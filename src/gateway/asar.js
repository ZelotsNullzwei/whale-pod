/**
 * 读 Electron 的 `app.asar`（只读，最小实现）。
 *
 * ## 为什么需要
 *
 * 2026-11-02 DSH 升级后，安装目录从
 * `<安装>/resources/app/`（普通目录）变成了 `<安装>/resources/app.asar`
 * （**一个 190MB 的包**）。
 *
 * whale-pod 有**两个功能要 import DSH 内部的包**：
 *   · `attachment.js` —— `dsh-attachment-local`（存储）+ `dsh-attachment`（入库）+ `cordis`
 *
 * 而 **asar 对普通 Node 来说就是一个普通文件**：`fs.existsSync('x.asar/…')`
 * 永远 false、`import()` 也读不了。（只有 Electron 运行时会拦 fs 调用去解 asar；
 * whale-pod 跑在**普通 Node** 下，没有那层拦截。）
 *
 * 所以要把需要的子树**提取成真目录**。
 *
 * ## asar 格式（很简单，值得知道）
 *
 * ```
 *   偏移 0   4 字节  uint32 = 4             pickle 里下一段的长度
 *   偏移 4   4 字节  uint32 = headerSize    pickle 里 header 的长度（含对齐）
 *   偏移 8   4 字节  uint32 = jsonSize      目录表 JSON 的真实长度
 *   偏移 12  4 字节  uint32 = jsonSize      重复一次
 *   偏移 16  jsonSize 字节  目录表 JSON
 *   偏移 16+jsonSize 起，是对齐填充，之后是**所有文件内容按顺序拼接**
 * ```
 *
 * 目录表节点的形状：
 * ```
 *   目录: { files: { 名字: 节点 } }
 *   文件: { size: 字节数, offset: '相对内容区起点的字符串偏移', executable?: true }
 * ```
 * ⚠️ `offset` 和 `size` 在 JSON 里是**字符串**（大文件会超出 float 精度）。
 *
 * ## 不做的事
 *   · 不写 asar（只读）
 *   · 不处理 `unpacked` 标记（那些文件本来就在 `app.asar.unpacked` 里，
 *     直接从那里读，不走这个模块）
 */

import fs from 'node:fs'
import path from 'node:path'

/** 读 asar 的目录表。返回 `{ files: {...} }` 那棵树。 */
export function readAsarTree(asarFile) {
  const fd = fs.openSync(asarFile, 'r')
  try {
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    const headerSize = head.readUInt32LE(4)
    const jsonSize = head.readUInt32LE(12)
    if (!(jsonSize > 0) || jsonSize > 512 * 1024 * 1024) {
      throw new Error(`asar 头部长度不合理（${jsonSize}）—— 不是有效的 asar？`)
    }
    const jsonBytes = Buffer.alloc(jsonSize)
    fs.readSync(fd, jsonBytes, 0, jsonSize, 16)
    /*
     * ★ **内容区起点 = 8 + headerSize**（2026-11-02 踩过一次）。
     *
     * 第一版写的是 `16 + jsonSize` —— 看着更"直觉"（16 是头部固定长度，
     * jsonSize 是目录表长度），但**错了**。
     *
     * 实测这台机器上的 asar：
     * ```
     *   offset 4  headerSize = 5472620     ← pickle 载荷总长（含对齐填充）
     *   offset12  jsonSize   = 5472611     ← 目录表 JSON 的真实长度
     *   16 + jsonSize = 5472627   ← 我的（错）
     *    8 + headerSize = 5472628 ← 正确，差 1 个字节
     * ```
     * 症状很有迷惑性：**每个文件整体偏 1 字节** ——
     * `package.json` 开头变成 `p{`、`{` 前面多一个 `\n`，
     * 于是 Node 报 `Invalid package config … package.json`，
     * 看起来像"DSH 的包有问题"，其实是**我读偏移算错了**。
     * （而 `lib/index.js` 因为开头是 `import`，多一字节也还是合法 JS，
     *   所以**只有 import 到 package.json 那一步才炸** —— 更难查。）
     *
     * 正确公式来自 asar 的格式定义：头 = `4 字节(值恒为4)` +
     * `4 字节 headerSize`，然后是 headerSize 字节的载荷（结尾按 4 字节对齐），
     * **内容紧跟其后**。所以内容是 `8 + headerSize` 开始，
     * 跟 `jsonSize` 之间还差着对齐填充。
     */
    const contentOffset = 8 + headerSize
    return { tree: JSON.parse(jsonBytes.toString('utf8')), contentOffset }
  } finally {
    fs.closeSync(fd)
  }
}

/** 在目录树里按路径找节点。找不到返回 null。 */
export function findAsarNode(tree, parts) {
  let cur = tree
  for (const p of parts) {
    cur = cur?.files?.[p]
    if (!cur) return null
  }
  return cur
}

/** 读 asar 里某个文件的字节。 */
export function readAsarFile(asarFile, contentOffset, entry) {
  const size = Number(entry.size)
  const off = contentOffset + Number(entry.offset)
  const fd = fs.openSync(asarFile, 'r')
  try {
    const buf = Buffer.alloc(size)
    fs.readSync(fd, buf, 0, size, off)
    return buf
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * 把 asar 里的一棵子树**提取成真目录**。
 *
 * @param {string} asarFile     asar 路径
 * @param {string[]} pathParts  子树路径（如 `['node_modules','@deepseek-ai','dsh-attachment']`）
 * @param {string} destDir      落地目录（会创建）
 * @param {object} [opts]
 * @param {string} [opts.unpackedDir] `app.asar.unpacked` 目录（**必须传**，见下）
 * @param {(lv:string,msg:string)=>void} [opts.log]
 * @returns {{files:number, bytes:number, fromUnpacked:number}}
 */
export function extractAsarSubtree(asarFile, pathParts, destDir, opts = {}) {
  const log = opts.log ?? (() => {})
  const unpackedDir = opts.unpackedDir ?? `${asarFile}.unpacked`
  const { tree, contentOffset } = readAsarTree(asarFile)
  const root = findAsarNode(tree, pathParts)
  if (!root) throw new Error(`asar 里没有 ${pathParts.join('/')}`)

  let files = 0
  let bytes = 0
  let fromUnpacked = 0
  const fd = fs.openSync(asarFile, 'r')
  try {
    const walk = (node, dir, relParts) => {
      /*
       * ★ **标了 `unpacked: true` 的，内容不在 asar 里**（2026-11-02 补）。
       *
       * 这是 asar 的既有机制：**原生模块（`.node`）不能打进 asar** ——
       * 它得能被 `process.dlopen` 从真实文件系统里加载。所以打包工具把它们
       * 放到**同级**的 `<asar>.unpacked/<原路径>`，并在目录表里打这个标记。
       *
       * 实测踩到：`node-addon-require-builtin-win32-x64-msvc` 的
       * `prebuilt/win32-x64-msvc-napi-v9.node`（343 KB）就是这个情况。
       * 不处理的话，提取器会**拿 asar 里那段占位/别的数据写成一个坏文件** ——
       * 报错是 `No usable native binding found`，看着像"包没装全"，
       * 其实是提取器没认这个标记。
       */
      if (node?.unpacked === true) {
        const src = path.join(unpackedDir, ...relParts)
        try {
          const st = fs.statSync(src)
          if (st.isDirectory()) {
            fs.mkdirSync(dir, { recursive: true })
            for (const name of fs.readdirSync(src)) {
              const s2 = path.join(src, name)
              const d2 = path.join(dir, name)
              const st2 = fs.statSync(s2)
              if (st2.isDirectory()) { walk({ unpacked: true }, d2, [...relParts, name]) }
              else { fs.copyFileSync(s2, d2); files++; bytes += st2.size; fromUnpacked++ }
            }
            return
          }
          fs.copyFileSync(src, dir)
          files++
          bytes += st.size
          fromUnpacked++
          return
        } catch (e) {
          log('warn', `asar：unpacked 文件读不到（${src}）：${String(e?.message ?? e)}`)
          return
        }
      }

      if (!node?.files) {
        // 普通文件：内容在 asar 里
        const buf = Buffer.alloc(Number(node.size))
        fs.readSync(fd, buf, 0, Number(node.size), contentOffset + Number(node.offset))
        fs.writeFileSync(dir, buf)
        files++
        bytes += Number(node.size)
        return
      }
      fs.mkdirSync(dir, { recursive: true })
      for (const [name, child] of Object.entries(node.files)) {
        walk(child, path.join(dir, name), [...relParts, name])
      }
    }
    walk(root, destDir, pathParts)
  } finally {
    fs.closeSync(fd)
  }
  log('info', `asar：提取 ${pathParts.join('/')} → ${destDir}（${files} 个文件，${Math.round(bytes / 1024)} KB`
    + `${fromUnpacked ? `，其中 ${fromUnpacked} 个来自 .unpacked` : ''}）`)
  return { files, bytes, fromUnpacked }
}

/**
 * ★ **确保一棵子树已经落到磁盘上**（幂等）。
 *
 * 用 asar 的 **文件大小 + mtime** 做"版本指纹"：DSH 升级后 asar 变了，
 * 指纹就变，于是会重新提取 —— 不用手工清缓存。
 *
 * @returns {string} 落地后的目录
 */
export function ensureAsarSubtree(asarFile, pathParts, destDir, opts = {}) {
  const log = opts.log ?? (() => {})
  const stampFile = `${destDir}.asar-stamp`
  let stamp = ''
  try {
    const st = fs.statSync(asarFile)
    stamp = `${st.size}:${Math.round(st.mtimeMs)}`
  } catch { /* 读不到就每次都提 */ }

  let prev = ''
  try { prev = fs.readFileSync(stampFile, 'utf8') } catch { /* 首次 */ }

  if (prev === stamp && fs.existsSync(destDir)) return destDir

  // 先清掉旧内容（换版本时目录结构可能不同，留着会混）
  try { fs.rmSync(destDir, { recursive: true, force: true }) } catch { /* ignore */ }
  extractAsarSubtree(asarFile, pathParts, destDir, { log })
  try { fs.writeFileSync(stampFile, stamp, 'utf8') } catch { /* ignore */ }
  return destDir
}