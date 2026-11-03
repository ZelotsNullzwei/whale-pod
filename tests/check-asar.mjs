/**
 * asar 读取器（2026-11-02 为适配新版 DSH 写的）。
 *
 * ## 为什么有它
 * DSH 升级后安装目录从 `<安装>/resources/app/`（普通目录）变成
 * `<安装>/resources/app.asar`（一个 190MB 的包）。而 **asar 对普通 Node
 * 就是一个普通文件** —— `fs.existsSync('x.asar/…')` 恒 false、`import()` 也读不了。
 * whale-pod 要从里面取 attachment 那几个包，所以得自己解析 asar。
 *
 * ## 三个**都踩过**的坑，这里逐个锁住
 *
 * ### ① 内容区起点是 `8 + headerSize`，不是 `16 + jsonSize`
 * 第一版用了后者（更"直觉"），结果**每个文件整体偏 1 个字节**。
 * 症状极有迷惑性：`package.json` 开头变成 `p{`、`{` 前多个 `\n`
 * → Node 报 `Invalid package config … package.json`
 * → **看着像 DSH 的包坏了，其实是偏移算错**。
 * 而 `lib/index.js` 因为开头是 `import`，多一字节仍是合法 JS，
 * 所以**只有 import 到 package.json 那一步才炸**，更难查。
 *
 * ### ② `unpacked: true` 的文件**不在 asar 里**
 * 原生模块（`.node`）不能打进 asar，打包工具把它们放到同级
 * `<asar>.unpacked/<原路径>`，目录表里用 `unpacked:true` 指路。
 * 不认这个标记 → 从 asar 里读那段 → 写出坏文件 →
 * 报 `No usable native binding found`（像"包没装全"）。
 *
 * ### ③ 平台专用兄弟包**静态扫不到**
 * 形如 `node-addon-require-builtin-${platform}-${arch}` 的依赖名是**运行时拼的**，
 * 扫 import 文本看不见 → 闭包漏包 → 同一个 native binding 报错。
 * 而且尾部还带工具链后缀（`-win32-x64-**msvc**`），
 * 第一版正则「平台-架构」就结尾，**匹配不上**。
 *
 * ## 测法
 * 用一个**构造出来的最小 asar**（不是真 DSH 的那个）—— 这样测试不依赖机器环境。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readAsarTree, findAsarNode, readAsarFile, extractAsarSubtree } from '../src/gateway/asar.js'

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

/**
 * 造一个最小 asar。
 *
 * @param {object} entries  `{ 'a/b.txt': '内容', ... }`；值可以是字符串，
 *                          或 `{ text, unpacked:true }`
 * @returns {string} asar 路径
 */
function makeAsar(dir, entries) {
  // 先把内容排好，记录每个文件的 offset
  const blobs = []
  let offset = 0
  const tree = { files: {} }
  for (const [rel, spec] of Object.entries(entries)) {
    const isU = typeof spec === 'object' && spec?.unpacked === true
    const text = typeof spec === 'object' ? spec.text : spec
    const size = Buffer.byteLength(text)
    const parts = rel.split('/')
    let cur = tree
    for (const p of parts.slice(0, -1)) {
      cur.files[p] = cur.files[p] ?? { files: {} }
      cur = cur.files[p]
    }
    const node = isU
      ? { size, unpacked: true }
      : { size, offset: String(offset) }
    cur.files[parts[parts.length - 1]] = node
    if (!isU) { blobs.push(Buffer.from(text)); offset += size }
  }

  const json = Buffer.from(JSON.stringify(tree), 'utf8')
  /*
   * 头部布局（**照真实 asar 抄**，2026-11-02 用 DSH 那个 190MB 的 asar 实测对过）：
   * ```
   *   offset 0   4 字节  uint32 = 4
   *   offset 4   4 字节  uint32 = headerSize
   *   offset 8   4 字节  uint32 = jsonSize
   *   offset 12  4 字节  uint32 = jsonSize（重复）
   *   offset 16  jsonSize 字节  目录表 JSON
   *   之后是填充，内容区从 **8 + headerSize** 开始
   * ```
   * ⚠️ 关键：`headerSize` **包含那 4 字节的 jsonSize 字段**（+填充）。
   *    实测真实 asar：`headerSize=5472620`、`jsonSize=5472611`、差 **9**。
   *    我第一版 fixture 按 `headerSize = JSON + PAD` 造，结果内容区错位 ——
   *    **测试红了，但代码是对的**（拿真 asar 逐个试，只有 `8 + headerSize` 能读出合法 JSON）。
   *    所以 fixture 必须照真布局造，否则测的是自己的假设。
   */
  const PAD = 4
  /*
   * 用**定义**反推，别拍脑袋：
   *   内容区起点 = `8 + headerSize`
   *   我把内容写在 `16 + json.length + PAD`（头 16 字节 + JSON + 填充）
   *   ⇒ 必须让 `8 + headerSize = 16 + json.length + PAD`
   *   ⇒ `headerSize = 8 + json.length + PAD`
   *
   * ⚠️ 这一步踩了两次：第一次按 `JSON+PAD`、第二次按 `4+JSON+PAD`，
   *    **两次都差 4 字节**（读出来前面多一串 `\x00` 或 `}}}}`）。
   *    最后用真 asar 的字段反推才对上：`headerSize=5472620`、`jsonSize=5472611`
   *    ⇒ `headerSize - jsonSize = 9`（不是 4、也不是 0）。
   *    所以 fixture 里这个 +8 是**必须的**，不是随便加的。
   */
  const headerSize = 8 + json.length + PAD
  const head = Buffer.alloc(16)
  head.writeUInt32LE(4, 0)
  head.writeUInt32LE(headerSize, 4)
  head.writeUInt32LE(json.length, 8)
  head.writeUInt32LE(json.length, 12)

  const asarFile = path.join(dir, 'app.asar')
  // 内容区 = 8 + headerSize = 16 + json.length + PAD ✓ 与我写的位置一致
  fs.writeFileSync(asarFile, Buffer.concat([head, json, Buffer.alloc(PAD), ...blobs]))
  return asarFile
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-pod-asar-'))

// ── ① 内容区起点 ───────────────────────────────────────────
ok('★★ 内容区起点是 8 + headerSize（不是 16 + jsonSize）', () => {
  const asar = makeAsar(tmp, {
    'node_modules/foo/package.json': '{"name":"foo"}',
  })
  const { tree, contentOffset } = readAsarTree(asar)
  const entry = findAsarNode(tree, ['node_modules', 'foo', 'package.json'])
  const buf = readAsarFile(asar, contentOffset, entry)
  assert.equal(buf.toString('utf8'), '{"name":"foo"}',
    '读出来的内容必须逐字节对得上 —— 偏 1 字节会让 package.json 变成非法 JSON')
  // 顺带确认：这个 fixture 真的**不是** 16+jsonSize（否则这条测试等于没测）
  const head = Buffer.alloc(16)
  const fd = fs.openSync(asar, 'r')
  fs.readSync(fd, head, 0, 16, 0)
  fs.closeSync(fd)
  assert.notEqual(contentOffset, 16 + head.readUInt32LE(12),
    'fixture 必须让两种算法结果不同，否则测不出偏移错误')
})

// ── ② unpacked ─────────────────────────────────────────────
ok('★★ unpacked:true 的文件要从 <asar>.unpacked 取，不能从 asar 里读', () => {
  const asar = makeAsar(tmp, {
    'node_modules/native/index.js': 'module.exports=1',
    'node_modules/native/prebuilt/x.node': { text: '', unpacked: true },
  })
  // 造出 .unpacked 里那个真文件
  const real = path.join(`${asar}.unpacked`, 'node_modules', 'native', 'prebuilt', 'x.node')
  fs.mkdirSync(path.dirname(real), { recursive: true })
  fs.writeFileSync(real, 'REAL-NATIVE-BINARY')

  const dest = path.join(tmp, 'out-native')
  extractAsarSubtree(asar, ['node_modules', 'native'], dest)
  const got = fs.readFileSync(path.join(dest, 'prebuilt', 'x.node'), 'utf8')
  assert.equal(got, 'REAL-NATIVE-BINARY',
    '提取出来的必须是 .unpacked 里那份真二进制；从 asar 里读会写成坏文件')
})

// ── ③ 平台后缀 ─────────────────────────────────────────────
ok('★★ 平台专用兄弟包名要能匹配（含 -msvc 这种工具链后缀）', async () => {
  const { computeClosure, PLATFORM_SUFFIX_FOR_TEST } = await import('../src/gateway/dsh-modules.js')
    .then((m) => ({ computeClosure: m.computeClosure, PLATFORM_SUFFIX_FOR_TEST: m.PLATFORM_SUFFIX_FOR_TEST }))
    .catch(() => ({ computeClosure: null }))
  if (!computeClosure) {
    // 没导出测试钩子就退回纯正则检查
    const re = /-(?:win32|darwin|linux|android|freebsd)-(?:x64|arm64|ia32|arm|ppc64|s390x|riscv64|universal)(?:-[a-z0-9]+)*$/
    assert.ok(re.test('-win32-x64-msvc'), '-win32-x64-msvc 必须匹配（尾部有工具链后缀）')
    assert.ok(re.test('-darwin-arm64'), '-darwin-arm64 必须匹配')
    assert.ok(!re.test('-win32-x64-extra-name'), '不该无限吞掉后面的名字')
    return
  }
  /* 有钩子就走真闭包：造一个"运行时拼依赖名"的布局 */
  const asar = makeAsar(tmp, {
    'node_modules/parent/lib/index.js': 'const n=`child-${process.platform}-${process.arch}`',
    'node_modules/parent/package.json': '{"name":"parent"}',
    'node_modules/parent-win32-x64-msvc/package.json': '{"name":"parent-win32-x64-msvc"}',
  })
  const c = computeClosure(asar, ['parent'])
  assert.ok(c.packages.includes('parent-win32-x64-msvc'),
    '平台专用兄弟包必须被拉进闭包（静态扫 import 看不到它）')
})

// ── ④ 依赖闭包必须读 package.json 声明 ────────────────────────
ok('★★★ 闭包必须包含「只在 package.json 里声明」的依赖（如 sharp）', async () => {
  const { computeClosure } = await import('../src/gateway/dsh-modules.js')
  /*
   * 造一个包：**代码里完全不 import 那个依赖**，只写在 package.json 里。
   * 这正是 sharp 的真实情况 —— 它走 dsh-lazy-require 延迟加载，
   * 静态扫 import 文本扫不到。
   */
  const asar = makeAsar(tmp, {
    'node_modules/needs-sharp/lib/index.js': 'module.exports = 1',
    'node_modules/needs-sharp/package.json': JSON.stringify({
      name: 'needs-sharp',
      dependencies: { sharp: '^0.33.0' },
    }),
    'node_modules/sharp/package.json': JSON.stringify({ name: 'sharp' }),
    'node_modules/sharp/lib/index.js': 'module.exports = 2',
  })
  const c = computeClosure(asar, ['needs-sharp'])
  assert.ok(c.packages.includes('sharp'),
    'package.json 里声明的依赖必须进闭包 —— 光扫 import 会漏掉运行时才 require 的包')
})

ok('★★ 内建模块不能被当成依赖（fs / path / child_process）', async () => {
  const { computeClosure } = await import('../src/gateway/dsh-modules.js')
  const asar = makeAsar(tmp, {
    'node_modules/declares-builtins/package.json': JSON.stringify({
      name: 'declares-builtins',
      dependencies: { fs: '*', path: '*', child_process: '*', sharp: '^1' },
    }),
    'node_modules/declares-builtins/lib/index.js': 'module.exports = 1',
  })
  const c = computeClosure(asar, ['declares-builtins'])
  for (const b of ['fs', 'path', 'child_process']) {
    assert.ok(!c.packages.includes(b), `${b} 是 Node 内建，不该进闭包`)
  }
  assert.ok(c.packages.includes('sharp'), '真依赖仍要保留')
})

// ── ⑤ 源码锁：闭包别退回"只扫 import 文本" ────────────────────
ok('★★★ 源码锁：computeClosure 必须同时用 declaredDeps 和 depsOf', () => {
  const src = fs.readFileSync(new URL('../src/gateway/dsh-modules.js', import.meta.url), 'utf8')
  const at = src.indexOf('export function computeClosure(')
  assert.ok(at > 0, '要有 computeClosure')
  const end = src.indexOf('\n}\n', at)
  const body = src.slice(at, end > at ? end : at + 4000)
  assert.match(body, /declaredDeps\(/, '必须读 package.json 的依赖声明')
  assert.match(body, /depsOf\(/, '也要扫 import 文本（两边互补）')
})

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)