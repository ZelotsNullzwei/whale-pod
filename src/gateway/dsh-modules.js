/**
 * 拿到一个**能 import 的 DSH 模块目录** —— 旧布局直接用，新布局（asar）先提取。
 *
 * ## 背景
 *
 * whale-pod 要从 DSH 的安装目录 import 几个内部包（主要是 attachment 那几个）。
 * 而 DSH 的安装形态变过：
 *
 * ```
 * 旧：<安装>/resources/app/                 ← 普通目录，path.join 直接能 import
 * 新：<安装>/resources/app.asar             ← 一个 190MB 的包（2026-11-02 起）
 * ```
 *
 * **asar 对普通 Node 就是一个普通文件**：`fs.existsSync('x.asar/…')` 恒 false、
 * `import()` 也读不了（那层拦截只有 Electron 运行时才有）。
 * 所以新布局下必须把需要的子树**提取成真目录**再 import。
 *
 * ## 提取什么
 *
 * 不是整个 `node_modules`（`@deepseek-ai` 下有 **313 个包 / 264 MB**），
 * 而是**按 import 关系算出来的闭包** —— 实测从三个种子出发只有
 * **10 个包 / 83 个文件 / 556 KB**。
 *
 * 闭包是**算出来的**，不是写死的清单：DSH 升级后包的依赖变了，
 * 这里会自动跟上（只要种子还在）。
 *
 * ## 缓存
 *
 * 提取到 `<cacheRoot>/dsh-modules/`，用 asar 的 `size + mtime` 当指纹 ——
 * DSH 一升级指纹就变，自动重提，不用手工清缓存。
 */

import fs from 'node:fs'
import path from 'node:path'
import { builtinModules } from 'node:module'
import { readAsarTree, findAsarNode, readAsarFile, extractAsarSubtree, ensureAsarSubtree } from './asar.js'

/**
 * Node **内建模块**名（含 `node:` 前缀的变体）。
 *
 * ⚠️ 为什么需要：有些包的 package.json 会把 `fs` / `path` / `child_process`
 *    也写进 dependencies（历史遗留写法）。照单全收的话，闭包里会混进
 *    一堆**永远 missing** 的假条目，噪音盖住真问题。
 */
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])

/** attachment 那条链的种子包。少一个都 import 不起来。 */
export const ATTACHMENT_SEEDS = [
  'dsh-attachment-local',
  'dsh-attachment',
  'cordis',
]

/** 一个包目录下所有文件的节点。找不到返回 null。 */
function pkgFiles(tree, bare) {
  const node = findAsarNode(tree, ['node_modules', ...bare.split('/')])
  if (!node?.files) return null
  const out = []
  const walk = (n, rel) => {
    if (!n?.files) { out.push({ rel, node: n }); return }
    for (const [name, child] of Object.entries(n.files)) walk(child, rel + '/' + name)
  }
  for (const [name, child] of Object.entries(node.files)) walk(child, name)
  return out
}

/** 一个包 import 了哪些**外部**裸模块名（丢掉相对路径和 node: 内建）。 */
function depsOf(tree, contentOffset, asarFile, bare) {
  const files = pkgFiles(tree, bare) ?? []
  const out = new Set()
  for (const f of files) {
    if (!/\.(js|mjs|cjs)$/.test(f.rel)) continue
    let text
    try { text = readAsarFile(asarFile, contentOffset, f.node).toString('utf8') } catch { continue }
    for (const m of text.matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)) {
      const s = m[1]
      if (s.startsWith('.') || s.startsWith('node:')) continue
      const bare = s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]
      // 内建模块（`fs` / `path` / `child_process` …）不是包，别当依赖
      if (BUILTINS.has(bare)) continue
      out.add(bare)
    }
  }
  return out
}

/**
 * ★★ 一个包 **package.json 里声明的**依赖。
 *
 * ## 为什么必须看这个（不是"锦上添花"）
 *
 * 光扫 import 文本**一定会漏包**。实测踩到：
 * `dsh-attachment-local` 入库图片时要 `sharp`（图像处理），
 * 但它是**运行时才 require** 的（走 `@deepseek-ai/dsh-lazy-require` 延迟加载）
 * —— 静态扫文本扫不到 → 闭包里没有 sharp →
 * **`attachment 服务已挂载` 照样打印**，
 * 但一入库就 `Cannot find module 'sharp'`、图片静默降级成文字。
 *
 * 而 `package.json` 的 `dependencies` / `optionalDependencies`
 * 是**权威声明**，不管代码怎么加载都跑不掉。
 * `optionalDependencies` 尤其重要 —— 平台专用包
 * （`@img/sharp-win32-x64` 这种）全在那一栏里。
 */
function declaredDeps(tree, contentOffset, asarFile, bare) {
  const out = new Set()
  const node = findAsarNode(tree, ['node_modules', ...bare.split('/'), 'package.json'])
  if (!node) return out
  let pkg
  try { pkg = JSON.parse(readAsarFile(asarFile, contentOffset, node).toString('utf8')) } catch { return out }
  for (const field of ['dependencies', 'optionalDependencies']) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (BUILTINS.has(name)) continue
      out.add(name)
    }
  }
  return out
}

/**
 * 平台专用的兄弟包名后缀（`win32-x64` / `darwin-arm64` …）。
 *
 * ⚠️ **有些包是运行时才拼出依赖名的** —— 形如
 * `node-addon-require-builtin-${process.platform}-${process.arch}`，
 * 静态扫 import 文本**看不到**。
 *
 * 实测（2026-11-02）：`node-addon-require-builtin` 就这么漏掉了它自己的
 * `node-addon-require-builtin-win32-x64-msvc` —— 于是那个包 import 时报
 * `No usable native binding found`。
 * （它对 attachment 不是致命的，但提取器**不该漏包**。）
 */
const PLATFORM_SUFFIX = new RegExp(
  '-(?:win32|darwin|linux|android|freebsd)'
  + '-(?:x64|arm64|ia32|arm|ppc64|s390x|riscv64|universal)'
  /*
   * ⚠️ 尾部**允许多一段工具链后缀**（`-msvc` / `-gnu` / `-musl` / `-eabi`…）。
   *    第一版写成「平台-架构」就结尾，于是 `-win32-x64-msvc` **匹配不上** ——
   *    目标包就在 asar 里、规则也在，却一个都没拉进来，
   *    特别容易误判成"asar 里没这个包"。
   */
  + '(?:-[a-z0-9]+)*$',
)

/**
 * 从种子出发算依赖闭包（BFS）。
 *
 * @param {string} asarFile
 * @param {string[]} seeds  裸包名（`@scope/name` 或 `name`）
 * @returns {{tree:object, contentOffset:number, packages:string[], missing:string[]}}
 */
export function computeClosure(asarFile, seeds) {
  const { tree, contentOffset } = readAsarTree(asarFile)
  const seen = new Set()
  const missing = []
  const queue = [...seeds]
  while (queue.length) {
    const bare = queue.shift()
    if (seen.has(bare)) continue
    seen.add(bare)
    if (!pkgFiles(tree, bare)) { missing.push(bare); continue }
    /*
     * ★★ 两个来源**都要**。
     *
     * · `declaredDeps` —— package.json 声明的（**权威**，含 optionalDependencies，
     *   平台包都在那栏）。运行时才 require 的包（如 sharp）**只有这里能捞到**。
     * · `depsOf` —— 扫 import 文本，捞那些"声明里没有、但代码里直接引"的。
     *
     * ⚠️ 少任何一个都会漏包，而漏包的后果是**静默降级**：
     *    实测漏掉 sharp 时，`attachment 服务已挂载` 照样打印，
     *    但一入库就 `Cannot find module 'sharp'` → 图片降级成文字。
     */
    for (const d of declaredDeps(tree, contentOffset, asarFile, bare)) {
      if (!seen.has(d)) queue.push(d)
    }
    for (const d of depsOf(tree, contentOffset, asarFile, bare)) {
      if (!seen.has(d)) queue.push(d)
    }
    /*
     * ★ **补拉平台专用的兄弟包**（见 PLATFORM_SUFFIX 的说明）。
     *
     * 只看"同一个 scope + 同名前缀"的兄弟 —— 别把无关的包也拖进来。
     */
    const scope = bare.startsWith('@') ? bare.split('/')[0] : ''
    const name = bare.startsWith('@') ? bare.split('/')[1] : bare
    const dir = scope
      ? findAsarNode(tree, ['node_modules', scope])
      : { files: tree.files.node_modules?.files ?? {} }
    for (const sibling of Object.keys(dir?.files ?? {})) {
      if (sibling === name || !sibling.startsWith(name)) continue
      const tail = sibling.slice(name.length)
      if (!PLATFORM_SUFFIX.test(tail)) continue
      const full = scope ? `${scope}/${sibling}` : sibling
      if (!seen.has(full)) queue.push(full)
    }
  }
  return { tree, contentOffset, packages: [...seen].sort(), missing }
}

/**
 * 提取逻辑的**版本号** —— 改动提取方式时必须 +1。
 *
 * ⚠️ 为什么需要：缓存指纹只用了 asar 的 `size + mtime`，
 *    而**改提取代码并不会让 asar 变** —— 于是修好之后旧的那份**坏提取**
 *    还留在磁盘上，指纹对得上，就不会重提，你会以为"改了没用"。
 *
 *    2026-11-02 就这么踩过一次：`contentOffset` 算错 1 个字节，
 *    所有 `package.json` 都坏；修完偏移之后**必须**强制重提才生效。
 *    把这个版本号并进指纹，改代码 = 换指纹 = 自动重提。
 */
const EXTRACTOR_VERSION = 7

/**
 * ★ **拿到一个能 import 的目录。**
 *
 * @param {object} opts
 * @param {string} opts.dshAppDir   旧布局的目录（能直接 import 就原样返回）
 * @param {string} [opts.dshAsar]   新布局的 asar 文件
 * @param {string} opts.cacheRoot   提取到哪（通常是 whale-pod 的数据目录）
 * @param {string[]} [opts.seeds]   种子包（默认 attachment 那三个）
 * @param {(lv:string,msg:string)=>void} [opts.log]
 * @returns {{dir:string|null, kind:'dir'|'asar'|null, packages?:string[], missing?:string[]}}
 */
export function resolveImportableDshDir(opts = {}) {
  const log = opts.log ?? (() => {})
  const seeds = (opts.seeds ?? ATTACHMENT_SEEDS).map((s) => (s.includes('/') ? s : `@deepseek-ai/${s}`))

  // ① 旧布局：普通目录，直接用
  if (opts.dshAppDir) {
    const probe = path.join(opts.dshAppDir, 'node_modules', ...seeds[0].split('/'))
    if (fs.existsSync(probe)) return { dir: opts.dshAppDir, kind: 'dir' }
    log('warn', `DSH 目录里没有 ${probe} —— 退回 asar 路径`)
  }

  // ② 新布局：asar，提取闭包
  if (!opts.dshAsar || !fs.existsSync(opts.dshAsar)) return { dir: null, kind: null }
  if (!opts.cacheRoot) throw new Error('resolveImportableDshDir：asar 布局必须给 cacheRoot')

  let closure
  try {
    closure = computeClosure(opts.dshAsar, seeds)
  } catch (e) {
    log('warn', `算 asar 依赖闭包失败：${String(e?.message ?? e)}`)
    return { dir: null, kind: 'asar' }
  }

  const root = path.join(opts.cacheRoot, 'dsh-modules')
  /*
   * 原生模块（`.node`）不在 asar 里，在**同级**的 `<asar>.unpacked/` 下。
   * 目录表里那些节点带 `unpacked: true`，提取时要按标记去那边取真文件。
   */
  const unpackedDir = opts.unpackedDir ?? `${opts.dshAsar}.unpacked`
  // 指纹文件放在根目录，一次覆盖所有包
  const stampFile = path.join(root, '.asar-stamp')
  let stamp = `v${EXTRACTOR_VERSION}`
  try {
    const st = fs.statSync(opts.dshAsar)
    // ⚠️ 指纹 = 提取器版本 + asar 的 size/mtime。
    //    只放 size/mtime 的话，**改提取代码不会换指纹** → 坏的那份会被一直用。
    stamp = `v${EXTRACTOR_VERSION}:${st.size}:${Math.round(st.mtimeMs)}`
  } catch { /* 读不到就每次都重提 */ }
  let prev = ''
  try { prev = fs.readFileSync(stampFile, 'utf8') } catch { /* 首次 */ }

  if (prev !== stamp || !fs.existsSync(root)) {
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
    let n = 0
    for (const bare of closure.packages) {
      // 不存在的包（missing）跳过
      if (closure.missing.includes(bare)) continue
      const dest = path.join(root, 'node_modules', ...bare.split('/'))
      try {
        // ⚠️ 必须传 unpackedDir：原生模块（`.node`）**不在 asar 里** ——
        //    它们在**同级**的 `<asar>.unpacked/` 下，目录表里用 `unpacked:true` 指路。
        //    不传的话那段会被当成普通文件从 asar 里读，写出来是坏的，
        //    报 `No usable native binding found`（看着像"包没装全"）。
        extractAsarSubtree(opts.dshAsar, ['node_modules', ...bare.split('/')], dest, { unpackedDir, log })
        n++
      } catch (e) {
        log('warn', `asar：提取 ${bare} 失败：${String(e?.message ?? e)}`)
      }
    }
    fs.mkdirSync(root, { recursive: true })
    try { fs.writeFileSync(stampFile, stamp, 'utf8') } catch { /* ignore */ }
    log('info', `asar：已提取 ${n} 个包到 ${root}`)
  }

  if (closure.missing.length) {
    log('warn', `asar：这些包不在里面（可能要另找）：${closure.missing.join(', ')}`)
  }
  return { dir: root, kind: 'asar', packages: closure.packages, missing: closure.missing }
}

export { ensureAsarSubtree }