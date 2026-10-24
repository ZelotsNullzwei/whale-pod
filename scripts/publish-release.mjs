/**
 * 重发 v0.2.5 Release：替换 asset + 更新 target_commitish。
 *
 * 用法：node scripts/publish-release.mjs
 *
 * ## 为什么「重发」而不是新建 tag
 *
 * 用户决定保持 v0.2.5 这个版本号（视频、Release、tag 都对应它）。
 * 但旧 Release 的 asset 是改动前的代码、target 还指向旧 commit ——
 * 不更新的话，从 Release 下载的人拿到的仍是「表情包乱插话」的版本。
 *
 * ## 为什么用 curl 而不是 fetch
 *
 * 本机开着 FlClash 代理（127.0.0.1:7890），Node 的 fetch 不读系统代理，
 * 直连 github.com:443 不通。undici 的 ProxyAgent 能解决但要额外装依赖；
 * Windows 自带 curl 原生支持 --proxy，不必引包。
 *
 * ## 三个坑
 *
 * 1) GitHub 不允许覆盖同名 asset —— 必须先 DELETE 再 POST
 * 2) 上传走 uploads.github.com，和 api.github.com 是**两个域名**，
 *    两者都得经代理（本机直连都不通）
 * 3) target_commitish 接受分支名或完整 SHA，但不能用短 SHA（会 422）
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const REPO = 'D:/DSH WorkSpace/whale-pod'
const OWNER_REPO = 'ZelotsNullzwei/whale-pod'
const TAG = 'v0.2.5'
const ASSET = path.join(REPO, 'dist/dsh-whale-pod-v0.2.5.zip')
const PROXY = 'http://127.0.0.1:7890'

const cred = fs.readFileSync('C:/Users/Null_zwei/.dsh/.credentials.yaml', 'utf8')
const token = cred.match(/GITHUB_TOKEN:\s*(\S+)/)[1].replace(/'/g, '')

/** 用 curl 发请求，返回 { code, body } */
function curl(args) {
  const out = execFileSync('curl.exe', [
    '-s', '-S', '--proxy', PROXY,
    '-H', `Authorization: Bearer ${token}`,
    '-H', 'User-Agent: dsh',
    '-H', 'Accept: application/vnd.github+json',
    '-w', '\n__CODE__%{http_code}',
    ...args,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const m = out.match(/^([\s\S]*)\n__CODE__(\d{3})\s*$/)
  if (!m) throw new Error(`curl 输出异常: ${out.slice(0, 200)}`)
  return { body: m[1], code: Number(m[2]) }
}

const head = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
console.log(`目标 commit: ${head}`)

if (!fs.existsSync(ASSET)) {
  console.error(`❌ 找不到 ${ASSET}\n   先跑 node scripts/pack-release.mjs`)
  process.exit(1)
}
const size = fs.statSync(ASSET).size
console.log(`新 asset  : ${path.basename(ASSET)}  ${(size / 1024).toFixed(0)} KB`)

// ── 1. 查 release ──────────────────────────────────────────
console.log('\n[1/4] 查 release…')
const r1 = curl([`https://api.github.com/repos/${OWNER_REPO}/releases/tags/${TAG}`])
if (r1.code !== 200) { console.error(`❌ ${r1.code}\n${r1.body.slice(0, 300)}`); process.exit(1) }
const rel = JSON.parse(r1.body)
console.log(`   id=${rel.id}  tag=${rel.tag_name}`)
console.log(`   旧 target=${rel.target_commitish}`)
console.log(`   旧 assets=${rel.assets.map((a) => `${a.name}(${(a.size / 1024).toFixed(0)}KB)`).join(', ') || '(无)'}`)

// ── 2. 更新 target_commitish ───────────────────────────────
console.log('\n[2/4] 更新 target_commitish…')
const r2 = curl([
  '-X', 'PATCH',
  '-H', 'Content-Type: application/json',
  '-d', JSON.stringify({ target_commitish: head }),
  `https://api.github.com/repos/${OWNER_REPO}/releases/${rel.id}`,
])
if (r2.code !== 200) { console.error(`❌ ${r2.code}\n${r2.body.slice(0, 300)}`); process.exit(1) }
console.log(`   ✅ target → ${JSON.parse(r2.body).target_commitish}`)

// ── 3. 删旧 asset ──────────────────────────────────────────
console.log('\n[3/4] 删除旧 asset…')
for (const a of rel.assets) {
  const r = curl(['-X', 'DELETE', `https://api.github.com/repos/${OWNER_REPO}/releases/assets/${a.id}`])
  console.log(`   ${r.code === 204 ? '✅' : '❌'} ${a.name} (HTTP ${r.code})`)
}

// ── 4. 上传新 asset ────────────────────────────────────────
console.log('\n[4/4] 上传新 asset…')
const r4 = curl([
  '-X', 'POST',
  '-H', 'Content-Type: application/zip',
  '--data-binary', `@${ASSET}`,
  `https://uploads.github.com/repos/${OWNER_REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(path.basename(ASSET))}`,
])
if (r4.code !== 201) { console.error(`❌ ${r4.code}\n${r4.body.slice(0, 400)}`); process.exit(1) }
const asset = JSON.parse(r4.body)
console.log(`   ✅ ${asset.name}  ${(asset.size / 1024).toFixed(0)} KB  state=${asset.state}`)

// ── 5. 校验 ────────────────────────────────────────────────
console.log('\n[校验] 拉取最终状态…')
const rv = JSON.parse(curl([`https://api.github.com/repos/${OWNER_REPO}/releases/tags/${TAG}`]).body)
console.log(`   tag    : ${rv.tag_name}`)
console.log(`   target : ${rv.target_commitish}`)
console.log(`   assets : ${rv.assets.map((a) => `${a.name}(${(a.size / 1024).toFixed(0)}KB, ${a.state})`).join(', ')}`)
const ok = rv.target_commitish === head && rv.assets.some((a) => a.name === path.basename(ASSET) && a.size === size)
console.log(ok ? '\n✅ 发布完成，asset 与 commit 均已更新' : '\n⚠️ 校验未完全通过，请人工确认')
process.exit(ok ? 0 : 1)
