/**
 * 从 marketface/json/*.jtmp 提取「下载的表情包」完整索引。
 *
 * 数据形状（实测）：
 *   { id: "244979",                    ← emoji_package_id（= 目录名）
 *     imgs: [{ id: "<32位hex>",        ← emoji_id
 *              name: "严肃",
 *              keywords: ["严肃"] }] }
 *
 * 加上 marketface/<pkgId>/<emojiId>_thu.png 是缩略图（126x126 PNG）。
 *
 * 输出 src/qq/stickers.json：
 *   { packages: [{ id, name?, count, items: [{ id, name, keywords, thumb }] }] }
 *
 * ⚠️ 注意：发送这些需要用 **mface 段**（emoji_id + emoji_package_id），
 *    和内置小黄脸的 face 段不同。之前 mface 测试失败是因为用了假 id ——
 *    这里有真实的了。
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * 定位 QQ 数据目录（含 nt_qq/nt_data/Emoji 的那一层）。
 *
 * ⚠️ 不写死个人路径 —— 这个脚本要能给别人用。
 * 优先：命令行参数 > 环境变量 GUARDIAN_QQ_DATA > 从常见位置探测。
 */
function resolveQQDataDir(explicit) {
  const candidates = []
  if (explicit) candidates.push(explicit)

  /** 这个账号目录里有没有下载过表情包 */
  const hasStickers = (p) => fs.existsSync(path.join(p, 'nt_qq/nt_data/Emoji/marketface/json'))
  /** 有没有 QQ 数据（够用来列候选） */
  const hasQQData = (p) => fs.existsSync(path.join(p, 'nt_qq/nt_data'))

  const roots = [
    'D:/Tencent/Documents/QQ_files/Tencent Files',
    'C:/Tencent/Documents/QQ_files/Tencent Files',
    path.join(process.env.USERPROFILE ?? '', 'Documents/Tencent Files'),
    path.join(process.env.USERPROFILE ?? '', 'Documents/QQ_files/Tencent Files'),
    path.join(process.env.USERPROFILE ?? '', 'Documents/QQ Files/Tencent Files'),
  ]
  const all = []
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue
    let subs = []
    try { subs = fs.readdirSync(root) } catch { continue }
    for (const d of subs) {
      const p = path.join(root, d)
      if (hasQQData(p)) all.push(p)
    }
  }

  // ⚠️ 优先选**真的下载过表情包**的账号。
  //    实测踩过：一台机器上可能有多个 QQ 账号目录，随手取第一个
  //    会选到没有表情包的那个，然后报"这个账号没下载过"。
  const withStickers = all.filter(hasStickers)
  if (withStickers.length > 0) return withStickers[0]
  if (all.length > 0) return all[0]

  console.error('找不到 QQ 数据目录。请显式传入，例如：')
  console.error('  node scripts/extract-stickers.mjs "D:/Tencent/.../Tencent Files/123456789"')
  console.error('（也可以设环境变量 GUARDIAN_QQ_DATA）')
  process.exit(1)
}

const base = resolveQQDataDir(process.argv[2] ?? process.env.GUARDIAN_QQ_DATA)
console.log('QQ 数据目录：' + base)
const mf = path.join(base, 'nt_qq/nt_data/Emoji/marketface')
const jsonDir = path.join(mf, 'json')
if (!fs.existsSync(jsonDir)) {
  console.error(`这个账号没有下载过表情包（缺 ${jsonDir}）`)
  process.exit(1)
}

const packages = []
for (const f of fs.readdirSync(jsonDir)) {
  if (!f.endsWith('.jtmp') && !f.endsWith('.json')) continue
  let j
  try { j = JSON.parse(fs.readFileSync(path.join(jsonDir, f), 'utf8')) } catch { continue }
  const pkgId = String(j.id ?? path.basename(f, path.extname(f)))
  const items = []
  for (const im of (j.imgs ?? [])) {
    const emojiId = String(im.id ?? '')
    if (!emojiId) continue
    // 缩略图在磁盘上（<emojiId>_thu.png）—— 记下来，UI 可以直接显示
    const thumbPath = path.join(mf, pkgId, `${emojiId}_thu.png`)
    const hasThumb = fs.existsSync(thumbPath)
    items.push({
      id: emojiId,
      name: String(im.name ?? '').trim(),
      keywords: Array.isArray(im.keywords) ? im.keywords.map(String) : [],
      thumb: hasThumb ? `marketface/${pkgId}/${emojiId}_thu.png` : null,
    })
  }
  // 只收录磁盘上真的有资源的包
  const dirExists = fs.existsSync(path.join(mf, pkgId))
  packages.push({
    id: pkgId,
    name: String(j.name ?? j.title ?? '').trim() || null,
    author: String(j.author ?? '').trim() || null,
    downloadCount: Number(j.downloadcount ?? 0) || 0,
    count: items.length,
    onDisk: dirExists,
    items,
  })
}

packages.sort((a, b) => b.count - a.count)

console.log(`=== 提取结果 ===`)
console.log(`表情包 ${packages.length} 个`)
let total = 0
for (const p of packages) {
  total += p.items.length
  console.log(`  ${p.id}  ${String(p.count).padStart(3)} 个表情  ${p.onDisk ? '资源在盘' : '⚠️ 只有清单'}  名=${p.name ?? '(无)'}`)
}
console.log(`表情总数 ${total}`)

console.log('')
console.log('=== 抽样看名字（这些就是"搜索"用的关键词）===')
for (const p of packages.slice(0, 3)) {
  console.log(`  【包 ${p.id}】`)
  for (const it of p.items.slice(0, 10)) {
    console.log(`    ${it.name.padEnd(10)} keywords=${JSON.stringify(it.keywords)}  thumb=${it.thumb ? '有' : '无'}`)
  }
}

// 生成的搜索索引：关键词 → [包id, 表情id, 名字]
const index = []
for (const p of packages) {
  for (const it of p.items) {
    const keys = new Set([it.name, ...it.keywords].filter(Boolean))
    index.push({ pkg: p.id, id: it.id, name: it.name, kw: [...keys] })
  }
}

const out = { packages, index }
const file = 'D:/DSH WorkSpace/whale-pod/src/qq/stickers.json'
fs.writeFileSync(file, JSON.stringify(out))
console.log('')
console.log(`已写入 ${file}  ${(fs.statSync(file).size / 1024).toFixed(1)}KB`)

// 自检
console.log('')
console.log('=== 自检 ===')
const noName = index.filter((x) => !x.name).length
console.log(`  有名字的: ${index.length - noName}/${index.length}`)
const withThumb = packages.reduce((n, p) => n + p.items.filter((i) => i.thumb).length, 0)
console.log(`  有缩略图的: ${withThumb}/${total}`)
console.log(`  关键词总数: ${new Set(index.flatMap((x) => x.kw)).size}`)
