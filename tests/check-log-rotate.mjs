/**
 * 日志轮转（src/logger.js）。
 *
 * ## 为什么非做不可（2026-11-02 两次实际翻车）
 * `whale-pod.log` 原来**只追加、从不轮转** —— 7.6MB / 7.2 万行，
 * 半年前的记录和刚写的一行混在同一个文件里：
 * ```
 * · 把文件早期那条 `Guardian 启动` 当成了刚发生的事
 *   → 误报"有第二个机器人在抢 QQ 连接"（查了半天，是假的）
 * · 按"第一条匹配的时间戳"切片 → 切到老区域 → 结果全空
 * ```
 * ⚠️ 它不只是占地方，是**会主动误导人**。
 *
 * ## 本文件锁住的几件事
 * ① 超过阈值 → **下次打开写流之前**把老文件改名
 * ② 改名后的文件名**不能含 `:`**（Windows 非法字符 —— 而 ISO 时间戳里全是冒号）
 * ③ 只留最近 `keep` 份，旧的删掉
 * ④ `maxBytes: 0` = 关掉轮转（不能"设了 0 反而永远轮转"）
 * ⑤ 没超阈值时**不许动**（否则每次启动都切一份，等于没日志）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Logger } from '../src/logger.js'

let pass = 0
let fail = 0
/**
 * ⚠️ **必须 async 并 await `log.close()`**（2026-11-03 踩到）。
 *
 * `createWriteStream` 是**异步打开**的 —— `info(...)` 之后立刻读文件，
 * 它可能**还没被创建**。我第一版把 close 当同步用了，结果三条断言全红：
 * ```
 * ❌ 新日志文件要还在      ❌ 要追加到原文件      ❌ ENOENT: open '…\e.log'
 * ```
 * **看着像轮转把文件弄丢了，其实是测试读得太早。**
 * 所以 `Logger.close()` 改成了返回 Promise（等 'close' 事件，才是真写完）。
 */
const ok = async (name, fn) => {
  try { await fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-logrotate-'))
const mk = (file, bytes) => fs.writeFileSync(file, 'x'.repeat(bytes))
const rotated = (file) => fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(path.basename(file) + '.'))

// ── ① 超过阈值 → 轮转 ────────────────────────────────────────
await ok('★★★ 超过阈值就把老文件改名（打开写流之前）', async () => {
  const f = path.join(tmp, 'a.log')
  mk(f, 3000)
  const log = new Logger({ file: f, maxBytes: 1000, keep: 5, console: false })
  log.info('hello')
  await log.close()

  const olds = rotated(f)
  assert.equal(olds.length, 1, `应该有 1 份轮转文件，实际 ${olds.length}`)
  assert.ok(fs.existsSync(f), '新日志文件要还在')
  const fresh = fs.readFileSync(f, 'utf8')
  assert.match(fresh, /hello/, '新内容要写进新文件')
  assert.match(fresh, /日志已轮转/, '★ 要留一行说明 —— 否则下一个人以为日志"莫名短了"')
})

// ── ② 文件名不能含冒号 ───────────────────────────────────────
await ok('★★ 轮转文件名不含 `:`（Windows 非法字符）', () => {
  const f = path.join(tmp, 'a.log')
  for (const n of rotated(f)) {
    assert.ok(!n.includes(':'), `文件名里有冒号，Windows 上会建不出来：${n}`)
  }
  assert.ok(!rotated(f).some((n) => /\d{2}:\d{2}/.test(n)), '不能残留 HH:MM')
})

// ── ③ 只留 keep 份 ──────────────────────────────────────────
await ok('★★ 只保留最近 keep 份，旧的删掉', async () => {
  const f = path.join(tmp, 'b.log')
  for (let i = 0; i < 7; i++) {
    const p = path.join(tmp, `b.log.old-${i}`)
    fs.writeFileSync(p, 'old')
    const t = new Date(Date.now() - (7 - i) * 60_000)
    fs.utimesSync(p, t, t)
  }
  mk(f, 3000)
  const log = new Logger({ file: f, maxBytes: 1000, keep: 3, console: false })
  log.info('x')
  await log.close()

  const olds = rotated(f)
  assert.equal(olds.length, 3, `keep=3 时应该剩 3 份，实际 ${olds.length}：${olds.join(', ')}`)
})

// ── ④ maxBytes:0 = 关掉 ─────────────────────────────────────
await ok('★ maxBytes:0 = 关掉轮转（不是"永远轮转"）', async () => {
  const f = path.join(tmp, 'c.log')
  mk(f, 5000)
  const log = new Logger({ file: f, maxBytes: 0, keep: 5, console: false })
  log.info('x')
  await log.close()
  assert.equal(rotated(f).length, 0, 'maxBytes=0 时不该轮转')
})

// ── ⑤ 没超阈值不许动 ────────────────────────────────────────
await ok('★★ 没超阈值时不许动文件（否则每次启动都切一份）', async () => {
  const f = path.join(tmp, 'd.log')
  mk(f, 100)
  const log = new Logger({ file: f, maxBytes: 10_000, keep: 5, console: false })
  log.info('append-me')
  await log.close()
  assert.equal(rotated(f).length, 0, '没超阈值不该轮转')
  assert.match(fs.readFileSync(f, 'utf8'), /append-me/, '要**追加**到原文件')
})

// ── ⑥ 默认值 ────────────────────────────────────────────────
await ok('★ 默认 5MB / 保留 5 份', () => {
  const log = new Logger({ console: false })
  assert.equal(log.maxBytes, 5 * 1024 * 1024, '默认阈值该是 5MB')
  assert.equal(log.keep, 5, '默认保留 5 份')
})

// ── ⑦ 失败要 fail-soft ──────────────────────────────────────
await ok('★★ 轮转失败不能拦住日志（宁可继续追加）', async () => {
  const f = path.join(tmp, 'e.log')
  mk(f, 3000)
  const log = new Logger({ file: f, maxBytes: 1000, keep: 0, console: false })
  await assert.doesNotReject(async () => { log.info('still-works'); await log.close() }, '轮转出问题也不该抛')
  assert.match(fs.readFileSync(f, 'utf8'), /still-works/, '★ 内容必须照样落盘')
})

fs.rmSync(tmp, { recursive: true, force: true })
console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)