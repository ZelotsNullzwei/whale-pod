/**
 * 新建一个 GitHub Release（带 tag + asset + 发行说明）。
 *
 * 用法：
 *   node scripts/create-release.mjs              # 用 package.json 的 version
 *   node scripts/create-release.mjs 0.5.0        # 指定版本号
 *
 * ## 和 `publish-release.mjs` 的分工
 *   · `create-release.mjs`（本文件）—— **新建**一个版本。会先检查是否已存在，不覆盖。
 *   · `publish-release.mjs`         —— **重发**已有版本（换 asset / 更新 target）。
 *     那个脚本硬编码了 tag（写于 v0.2.5 重发时），只适合"同一个版本重发"。
 *
 * ## 发行说明从哪来
 *   读 `docs/release-notes-<版本>.md`（例：`docs/release-notes-0.4.0.md`）。
 *   **必须存在**，而且不能太短 —— 空正文发出去等于没有说明。
 *
 * ## ⚠️ 三个必须知道的点
 *
 * 1. **网络**：本机 `github.com:443` 不通，但 `api.github.com` 和
 *    `uploads.github.com` **直连都通**（实测）。
 *    所以这个脚本**不用代理**（`publish-release.mjs` 里那个 `127.0.0.1:7890`
 *    是 2026-10 那会儿的情况，现在不需要了）。
 *
 * 2. **target_commitish 要用「远端 main 的 SHA」，不是本地 HEAD**。
 *    因为本仓库的推送走 GitHub API（整棵树一次性提交），
 *    远端 SHA 和本地 HEAD **不是同一个**。用本地 HEAD 会 422。
 *
 * 3. **asset 不能覆盖同名** —— 想换内容得先 DELETE 再 POST
 *    （那是 `publish-release.mjs` 干的活；这里只做新建）。
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
  try { j = JSON.parse(t) } catch { /* 非 JSON */ }
  return { ok: r.ok, status: r.status, body: j, raw: t }
}

// ── 前置检查（三条都过了才动手）────────────────
console.log(`版本：v${VERSION}`)

if (!fs.existsSync(ZIP)) {
  console.error(`❌ 找不到 ${ZIP}\n   先跑 node scripts/pack-release.mjs ${VERSION}`)
  process.exit(1)
}
const size = fs.statSync(ZIP).size
console.log(`  asset : ${path.basename(ZIP)}  ${(size / 1024).toFixed(0)} KB`)

if (!fs.existsSync(NOTES)) {
  console.error(`❌ 找不到发行说明 ${NOTES}\n   先写一份（别发空正文的 Release）`)
  process.exit(1)
}
const body = fs.readFileSync(NOTES, 'utf8')
if (body.trim().length < 200) {
  console.error(`❌ 发行说明太短（${body.trim().length} 字）—— 至少写清楚这一版改了什么`)
  process.exit(1)
}
console.log(`  notes : ${path.basename(NOTES)}  ${body.length} 字`)

const ref = await api(`/repos/${OWNER_REPO}/git/refs/heads/${BRANCH}`)
if (!ref.ok) { console.error(`❌ 拿不到远端 ${BRANCH}：${ref.status}\n${ref.raw.slice(0, 300)}`); process.exit(1) }
const SHA = ref.body.object.sha
console.log(`  target: ${BRANCH} = ${SHA.slice(0, 7)}`)

const exists = await api(`/repos/${OWNER_REPO}/releases/tags/${TAG}`)
if (exists.ok) {
  console.error(`❌ ${TAG} 已存在（本脚本不覆盖）。重发请用：node scripts/publish-release.mjs`)
  process.exit(1)
}

// ── 1. 建 Release（GitHub 会自动创建 tag）──────
console.log('\n[1/3] 建 Release…')
const rel = await api(`/repos/${OWNER_REPO}/releases`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    tag_name: TAG,
    target_commitish: SHA,
    name: `WhalePod v${VERSION}`,
    body,
    draft: false,
    prerelease: false,
  }),
})
if (!rel.ok) { console.error(`❌ ${rel.status}\n${rel.raw.slice(0, 400)}`); process.exit(1) }
console.log(`  ✅ id=${rel.body.id}  tag=${rel.body.tag_name}`)
console.log(`     ${rel.body.html_url}`)

// ── 2. 上传 asset ──────────────────────────────
console.log('\n[2/3] 上传 asset…')
const assetName = path.basename(ZIP)
const up = await fetch(
  `https://uploads.github.com/repos/${OWNER_REPO}/releases/${rel.body.id}/assets?name=${encodeURIComponent(assetName)}`,
  {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/zip' },
    body: fs.readFileSync(ZIP),
  },
).then((r) => r.json())
if (!up.id) { console.error('❌ 上传失败：' + JSON.stringify(up).slice(0, 400)); process.exit(1) }
console.log(`  ✅ ${up.name}  ${(up.size / 1024).toFixed(0)} KB  state=${up.state}`)

// ── 3. 校验 ────────────────────────────────────
console.log('\n[3/3] 校验…')
const rv = await api(`/repos/${OWNER_REPO}/releases/tags/${TAG}`)
const ok = rv.ok
  && rv.body.tag_name === TAG
  && rv.body.assets.some((a) => a.name === assetName && a.size === size)
  && String(rv.body.body ?? '').length === body.length
console.log(`  tag    : ${rv.body?.tag_name}`)
console.log(`  target : ${String(rv.body?.target_commitish).slice(0, 7)}`)
console.log(`  正文   : ${String(rv.body?.body ?? '').length} 字`)
console.log(`  assets : ${(rv.body?.assets ?? []).map((a) => `${a.name}(${(a.size / 1024).toFixed(0)}KB, ${a.state})`).join(', ')}`)
console.log(`  下载   : ${(rv.body?.assets ?? [])[0]?.browser_download_url ?? '(无)'}`)
console.log(ok ? '\n✅ 发布完成' : '\n⚠️ 校验未完全通过，请人工确认')
process.exit(ok ? 0 : 1)