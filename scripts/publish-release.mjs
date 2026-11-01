/**
 * 重发已有版本的 Release：换 asset + 更新正文 + 更新 target + 把 tag 一起挪过去。
 *
 * 用法：
 *   node scripts/publish-release.mjs           # 用 package.json 的 version
 *   node scripts/publish-release.mjs 0.4.0     # 指定版本号
 *
 * ## 和 `create-release.mjs` 的分工
 *   · `create-release.mjs`       —— **新建**一个版本（已存在就拒绝）
 *   · `publish-release.mjs`（本文件）—— **重发**已有版本
 *
 * ## 为什么"重发"必须连 tag 一起挪
 *
 * GitHub 的「Source code (zip / tar.gz)」是**按 tag 现打**的。只换 asset
 * 而不挪 tag，就会出现三样东西互相矛盾：
 *
 * ```
 * asset（whale-pod-x.y.z.zip）  → 新代码
 * tag                           → 旧 commit
 * Source code 自动包            → 旧代码   ← 用户点了这个就白下
 * ```
 *
 * v0.2.5 那次重发就没挪 tag，所以留了这个教训。
 *
 * ## ⚠️ 四个坑（都踩过）
 *
 * 1. **tag 是已存在的 ref，改 `target_commitish` 不会移动它。**
 *    `target_commitish` 只在 GitHub *首次创建* tag 时起作用；之后必须单独
 *    `PATCH /git/refs/tags/<tag>`（`force: true`）才会真的挪。
 *
 * 2. **不能覆盖同名 asset** —— 必须先 `DELETE` 再 `POST`。
 *
 * 3. **SHA 必须是远端存在的 commit。**
 *    本仓库的推送走 GitHub API（整棵树一次性成一个 commit），
 *    **本地 HEAD 在远端根本不存在** —— 拿它去 PATCH 会 422。
 *    所以一律取**远端 main 的 SHA**。
 *    （旧版这里硬编码 `v0.2.5` + curl + `127.0.0.1:7890` 代理，都已过时。）
 *
 * 4. **两个域名都要通**：`api.github.com`（元数据）和 `uploads.github.com`（上传）。
 *    实测本机两个直连都通，不需要代理；不通的是 `github.com:443`。
 *
 * ## 顺序
 *   先 `node scripts/pack-release.mjs` 生成 zip，再跑这个。
 */
import fs from 'node:fs'
import path from 'node:path'

const REPO = 'D:/DSH WorkSpace/whale-pod'
const OWNER_REPO = 'ZelotsNullzwei/whale-pod'
const BRANCH = 'main'

const PKG = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))
const VERSION = String(process.argv[2] ?? PKG.version).replace(/^v/, '')
const TAG = `v${VERSION}`
const ZIP = path.join(REPO, 'dist', `whale-pod-${VERSION}.zip`)
const NOTES = path.join(REPO, 'docs', `release-notes-${VERSION}.md`)

const cred = fs.readFileSync('C:/Users/Null_zwei/.dsh/.credentials.yaml', 'utf8')
const token = cred.match(/GITHUB_TOKEN:\s*["']?([A-Za-z0-9_-]+)/)[1]
const H = {
  Authorization: `Bearer ${token}`,
  'User-Agent': 'whale-pod-release',
  Accept: 'application/vnd.github+json',
}

const api = async (p, init = {}) => {
  const r = await fetch(`https://api.github.com${p}`, { headers: H, ...init })
  const t = await r.text()
  let j = null
  try { j = JSON.parse(t) } catch { /* 非 JSON（DELETE 返回空） */ }
  return { ok: r.ok, status: r.status, body: j, raw: t }
}

// ── 前置检查 ───────────────────────────────────────────────
console.log(`重发：v${VERSION}`)

if (!fs.existsSync(ZIP)) {
  console.error(`❌ 找不到 ${ZIP}\n   先跑 node scripts/pack-release.mjs ${VERSION}`)
  process.exit(1)
}
const assetName = path.basename(ZIP)
const size = fs.statSync(ZIP).size
console.log(`  asset : ${assetName}  ${(size / 1024).toFixed(0)} KB`)

if (!fs.existsSync(NOTES)) {
  console.error(`❌ 找不到发行说明 ${NOTES}`)
  process.exit(1)
}
const body = fs.readFileSync(NOTES, 'utf8')
if (body.trim().length < 200) {
  console.error(`❌ 发行说明太短（${body.trim().length} 字）—— 别发空正文的 Release`)
  process.exit(1)
}
console.log(`  notes : ${path.basename(NOTES)}  ${body.length} 字`)

// ── 1. 拿远端 main（**不能**用本地 HEAD，见文件头坑 ③）─────
console.log('\n[1/6] 取远端 main…')
const ref = await api(`/repos/${OWNER_REPO}/git/refs/heads/${BRANCH}`)
if (!ref.ok) { console.error(`❌ 拿不到远端 ${BRANCH}：${ref.status}\n${ref.raw.slice(0, 300)}`); process.exit(1) }
const SHA = ref.body.object.sha
console.log(`  ${BRANCH} = ${SHA}`)

// ── 2. 查 release ──────────────────────────────────────────
console.log('\n[2/6] 查 release…')
const r1 = await api(`/repos/${OWNER_REPO}/releases/tags/${TAG}`)
if (!r1.ok) { console.error(`❌ ${TAG} 不存在（${r1.status}）。新建请用 create-release.mjs`); process.exit(1) }
const rel = r1.body
console.log(`   id=${rel.id}`)
console.log(`   旧 target=${String(rel.target_commitish).slice(0, 7)}   新 target=${SHA.slice(0, 7)}`)
console.log(`   旧 assets=${rel.assets.map((a) => `${a.name}(${(a.size / 1024).toFixed(0)}KB)`).join(', ') || '(无)'}`)
console.log(`   旧正文=${String(rel.body ?? '').length} 字   新正文=${body.length} 字`)

// ── 3. 更新 release（正文 + target）────────────────────────
console.log('\n[3/6] 更新正文与 target…')
const r3 = await api(`/repos/${OWNER_REPO}/releases/${rel.id}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ target_commitish: SHA, body }),
})
if (!r3.ok) { console.error(`❌ ${r3.status}\n${r3.raw.slice(0, 400)}`); process.exit(1) }
console.log(`   ✅ target → ${String(r3.body.target_commitish).slice(0, 7)}   正文 → ${String(r3.body.body).length} 字`)

// ── 4. 把 tag 挪到新 commit（坑 ①）─────────────────────────
console.log('\n[4/6] 移动 tag…')
const tag = await api(`/repos/${OWNER_REPO}/git/refs/tags/${TAG}`)
if (!tag.ok) {
  console.error(`❌ 拿不到 tag ${TAG}：${tag.status}\n${tag.raw.slice(0, 300)}`)
  process.exit(1)
}
console.log(`   ${TAG} 旧 → ${tag.body.object.sha.slice(0, 7)}（${tag.body.object.type}）`)
/*
 * ⚠️ 注释 tag（object.type === 'tag'）不能用这种方式挪 ——
 *    那需要一个 tag 对象，而不是 commit sha。本仓库的 tag 都是轻量的，
 *    所以这里直接挡住，避免把注释 tag 悄悄改成轻量 tag。
 */
if (tag.body.object.type !== 'commit') {
  console.error(`❌ ${TAG} 是 ${tag.body.object.type} 类型（注释 tag），本脚本不处理。请手工确认。`)
  process.exit(1)
}
const r4 = await api(`/repos/${OWNER_REPO}/git/refs/tags/${TAG}`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sha: SHA, force: true }),
})
if (!r4.ok) { console.error(`❌ 移动失败 ${r4.status}\n${r4.raw.slice(0, 400)}`); process.exit(1) }
console.log(`   ✅ ${TAG} → ${r4.body.object.sha.slice(0, 7)}`)

// ── 5. 换 asset（坑 ②）─────────────────────────────────────
console.log('\n[5/6] 换 asset…')
for (const a of rel.assets) {
  const d = await api(`/repos/${OWNER_REPO}/releases/assets/${a.id}`, { method: 'DELETE' })
  console.log(`   ${d.status === 204 ? '✅ 删除' : `❌ ${d.status}`} ${a.name}`)
}
const buf = fs.readFileSync(ZIP)
const up = await fetch(
  `https://uploads.github.com/repos/${OWNER_REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(assetName)}`,
  { method: 'POST', headers: { ...H, 'Content-Type': 'application/zip' }, body: buf },
).then((r) => r.json())
if (!up.id) { console.error('❌ 上传失败：' + JSON.stringify(up).slice(0, 400)); process.exit(1) }
console.log(`   ✅ ${up.name}  ${(up.size / 1024).toFixed(0)} KB  state=${up.state}`)

// ── 6. 校验 ────────────────────────────────────────────────
console.log('\n[6/6] 校验…')
const rv = await api(`/repos/${OWNER_REPO}/releases/tags/${TAG}`)
const rtag = await api(`/repos/${OWNER_REPO}/git/refs/tags/${TAG}`)
const ok = rv.ok
  && rtag.ok
  && String(rv.body.body ?? '').length === body.length
  && rv.body.assets.some((a) => a.name === assetName && a.size === size)
  && String(rtag.body.object.sha) === SHA
  && String(rv.body.target_commitish).startsWith(SHA.slice(0, 7))
console.log(`   tag    : ${rtag.body?.object.sha?.slice(0, 7)}  (期望 ${SHA.slice(0, 7)})`)
console.log(`   target : ${String(rv.body?.target_commitish).slice(0, 7)}`)
console.log(`   正文   : ${String(rv.body?.body ?? '').length} 字`)
console.log(`   assets : ${(rv.body?.assets ?? []).map((a) => `${a.name}(${(a.size / 1024).toFixed(0)}KB, ${a.state})`).join(', ')}`)
console.log(`   ${rv.body?.html_url ?? ''}`)
console.log(ok ? '\n✅ 重发完成：正文 / target / tag / asset 四样一致' : '\n⚠️ 校验未完全通过，请人工确认')
process.exit(ok ? 0 : 1)