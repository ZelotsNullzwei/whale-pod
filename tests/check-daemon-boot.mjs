/**
 * 「一键启动没反应」修复的回归测试（2026-10-28）。
 *
 * ## 症状（B 站评论原话）
 *   香香兔要吃草：「点了一键启动之后没有反应，这个是什么原因呀」
 *
 * ## 根因：两边等待时间对不上
 *   · 服务端 `daemon.js` 的 ensureRunning 最多等 **25 秒** 才判定就绪
 *     （`readyTimeoutMs ?? 25_000`）
 *   · 而 `client.js` 的 `api()` 默认超时只有 **8 秒**
 *
 * 于是点下去 8 秒后客户端 abort → AbortError 文本含 "aborted"
 * → act() 的 benign 正则判成「预期内」→ 只闪一句「已发出指令，状态刷新中…」
 * → 刷新时后端还没起来 → 界面依旧「后端未运行」→ **看起来就是没反应**。
 *
 * ## 另外两个让问题"不可诊断"的点
 *   · `stdio: 'ignore'` —— 后端一起来就崩的话，日志一行都没有
 *   · 失败时只抛「启动超时」，没有子进程的任何输出
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readTail } from '../plugin/daemon.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-boot-'))

// ── readTail ───────────────────────────────────────────────
ok('readTail 读末尾若干字节', () => {
  const f = path.join(tmp, 'a.log')
  fs.writeFileSync(f, 'AAA\nBBB\nCCC\n')
  assert.equal(readTail(f).trim(), 'AAA\nBBB\nCCC'.trim())
})

ok('readTail 只取末尾（超过 maxBytes 时截断头部）', () => {
  const f = path.join(tmp, 'b.log')
  // 末尾正好 8 字节的标记，maxBytes 也取 8 —— 这样能精确验证「只取末尾」
  fs.writeFileSync(f, 'H'.repeat(2000) + 'END_MARK')
  const t = readTail(f, 8)
  assert.equal(t, 'END_MARK', `应精确取到末尾 8 字节，实际：${JSON.stringify(t)}`)
  assert.ok(!t.includes('H'), '不该含头部内容')
})

ok('readTail 末尾不足 maxBytes 时返回全部', () => {
  const f = path.join(tmp, 'b2.log')
  fs.writeFileSync(f, 'short')
  assert.equal(readTail(f, 1200), 'short')
})

ok('readTail 文件不存在 → 空串（不抛）', () => {
  assert.equal(readTail(path.join(tmp, 'nope.log')), '')
})

ok('readTail 空文件 → 空串', () => {
  const f = path.join(tmp, 'c.log')
  fs.writeFileSync(f, '')
  assert.equal(readTail(f), '')
})

// ── 源码锁：防止退回 ────────────────────────────────────────
/**
 * 只保留**代码行**，丢掉落单的注释行。
 *
 * ⚠️ 不能用「正则去掉 /* … *&#47; 块」——源码里有 `'/api/whale-pod/*'`
 *    这种带 `/*` 的**字符串**，会让配对错位、把真代码一起删掉
 *    （这个坑当场踩过一次：断言因此误报失败）。
 */
function codeLines(src) {
  return src
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*') && !l.startsWith('*/'))
}

const repo = path.resolve(import.meta.dirname, '..')
const clientLines = codeLines(fs.readFileSync(path.join(repo, 'plugin', 'client.js'), 'utf8'))
const daemonLines = codeLines(fs.readFileSync(path.join(repo, 'plugin', 'daemon.js'), 'utf8'))

ok('client：启停必须给比服务端 25 秒更长的超时（45 秒）', () => {
  const judge = clientLines.find((l) => l.includes('isLifecycle') && l.includes('(start|stop)'))
  assert.ok(judge, '应有一处判断是不是启停类路径')
  assert.ok(
    clientLines.some((l) => l.includes('isLifecycle ? 45_000 : undefined')),
    'post 调用的第三参应传 45_000',
  )
})

ok('client：act 里不能再用默认超时裸调 post', () => {
  assert.ok(
    !clientLines.some((l) => /^await post\(path, body\)$/.test(l)),
    'act 里不该再有 `await post(path, body)`（会退回 8 秒默认超时）',
  )
})

ok('daemon：spawn 子进程时必须把输出留痕（不能再 stdio: ignore）', () => {
  const i = daemonLines.findIndex((l) => l.startsWith('child = spawn('))
  assert.ok(i >= 0, '应能找到 child = spawn(')
  const block = daemonLines.slice(i, i + 10).join('\n')
  assert.ok(!/stdio:\s*'ignore'/.test(block), "spawn 不该用 `stdio: 'ignore'` —— 崩了就没线索")
  assert.ok(block.includes('bootFd'), '应把日志 fd 传给 spawn 的 stdio')
})

ok('daemon：日志文件叫 daemon-boot.log，且落在 home 下', () => {
  assert.ok(daemonLines.some((l) => l.includes("'daemon-boot.log'")), '应有 daemon-boot.log 文件名')
})

ok('daemon：失败时要带上子进程最后输出', () => {
  assert.ok(daemonLines.some((l) => l.includes('readTail(bootLog)')), '超时/早退时都要读日志尾巴')
  assert.ok(daemonLines.some((l) => l.includes('最后输出')), '错误消息里要有「最后输出」')
})

ok('daemon：加早退检测（别白等 25 秒）', () => {
  assert.ok(
    daemonLines.some((l) => l.includes('child.exitCode !== null') && l.includes('child.signalCode !== null')),
    '要检测进程是否已退出',
  )
  assert.ok(daemonLines.some((l) => l.includes('启动后立刻退出')), '要有专门的错误措辞')
})

fs.rmSync(tmp, { recursive: true, force: true })

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)