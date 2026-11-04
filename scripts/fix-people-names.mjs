/**
 * 把 people.json 里的「群名片」换成真实 QQ 昵称。
 *
 * ## 背景
 *
 * 2026-11-04 之前，`normalizeEvent()` 的 `senderName` 是**群名片优先**
 * （`card || nickname`），而 `PeopleStore#touch()` 直接拿它当名字 ——
 * 于是同一个人换个群就换一个名字，仪表盘/设置页显示的是「群里的马甲」。
 *
 * 之后的代码改成：事件里额外带 `nickname`（QQ 资料昵称），档案展示优先用它。
 * 但**已经落盘的旧档案没有 `nickname`** —— 要等本人再说话才会被修正。
 * 这个脚本用 OneBot 的 `get_stranger_info` 一次性补齐。
 *
 * ## 用法
 *
 *   node scripts/fix-people-names.mjs            # 只查询 + 打印，不写文件
 *   node scripts/fix-people-names.mjs --apply    # 查询 → 停后端 → 写入 people.json
 *   node scripts/restart.mjs                     # 再启动（--apply 会把它杀掉）
 *
 * ⚠️ 为什么 --apply 要**先停后端再写**：
 *    后端每 30 秒 `flush()` 一次内存里的档案，运行时改 people.json 会被覆盖。
 *    而查询又必须在后端活着时做（NapCat 是它的子进程），所以顺序是
 *    「查完 → 停 → 写」。写文件名是 `people.json.fixed`，确认后再原子替换。
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const HOME = process.env.WHALE_POD_HOME
  ?? path.join(process.env.USERPROFILE ?? '', '.dsh', 'whale-pod')
const FILE = path.join(HOME, 'people.json')
const WEB_PORT = 18898
const apply = process.argv.includes('--apply')

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))

function onebotEndpoint() {
  try {
    const cfg = readJson(path.join(HOME, 'config.json'))
    const ob = cfg.qq?.onebot ?? {}
    return { url: String(ob.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/$/, ''), token: ob.token ?? '' }
  } catch {
    return { url: 'http://127.0.0.1:3000', token: '' }
  }
}

async function strangerName(id, { url, token }) {
  const res = await fetch(`${url}/get_stranger_info`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ user_id: Number(id), no_cache: false }),
    signal: AbortSignal.timeout(8000),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok || body?.status === 'failed' || body?.retcode !== 0) {
    return { error: body?.message ?? body?.wording ?? `HTTP ${res.status}` }
  }
  const d = body?.data ?? {}
  const nick = String(d.nick ?? d.nickname ?? '').trim()
  return nick ? { nick } : { error: '没有 nick 字段' }
}

function killDaemon() {
  try {
    const ps = `(Get-NetTCPConnection -LocalPort ${WEB_PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], {
      encoding: 'utf8', windowsHide: true, timeout: 15_000,
    }).trim()
    const pid = Number(out)
    if (!pid || Number.isNaN(pid)) return '后端没在运行'
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8', windowsHide: true, timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return `已停止 PID ${pid} 及其子树`
  } catch (e) {
    return `清理异常: ${String(e.message ?? e).slice(0, 100)}`
  }
}

if (!fs.existsSync(FILE)) {
  console.error(`❌ 找不到 ${FILE}`)
  process.exit(1)
}

const data = readJson(FILE)
const people = data?.people ?? {}
const ep = onebotEndpoint()
console.log(`档案：${FILE}（${Object.keys(people).length} 人）`)
console.log(`OneBot：${ep.url}\n`)

let changed = 0
const misses = []
for (const [key, p] of Object.entries(people)) {
  const id = String(p?.id ?? key.replace(/^u:/, ''))
  const alias = (p?.aliases ?? []).at(-1) ?? id
  let line = `${key.padEnd(16)} 名片=${JSON.stringify(alias)}`
  try {
    const got = await strangerName(id, ep)
    if (got.error) {
      misses.push(`${id}（${got.error}）`)
      line += `  → ✗ ${got.error}`
    } else {
      p.nickname = got.nick
      changed += 1
      line += `  → QQ昵称=${JSON.stringify(got.nick)}`
    }
  } catch (e) {
    misses.push(`${id}（${String(e.message ?? e).slice(0, 60)}）`)
    line += `  → ✗ ${String(e.message ?? e).slice(0, 60)}`
  }
  console.log(line)
}

console.log(`\n可更新 ${changed} 人${misses.length ? `，跳过 ${misses.length} 人：${misses.join('、')}` : ''}`)

if (!apply) {
  console.log('\n（演练模式，未写文件。加 --apply 应用）')
  process.exit(0)
}

// 停后端 → 写文件，避免 30 秒 flush 把旧内存覆盖回来
console.log(`\n停后端：${killDaemon()}`)
const out = path.join(HOME, 'people.json.fixed')
const tmp = `${out}.tmp`
fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
fs.renameSync(tmp, out)
fs.renameSync(out, FILE)
console.log(`✅ 已写入 ${FILE}（${changed} 个昵称）`)
console.log('现在启动后端：node scripts/restart.mjs')