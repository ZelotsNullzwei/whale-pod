/**
 * 运行期日志轮转（2026-11-10）
 *
 * 原来只在**启动时**检查大小 —— 单次长跑能顶穿阈值（实测 4.3MB / 5MB）。
 * 现在按累计字节判断，超阈值就关流 → 轮转 → 重开（Windows 不能改打开中的文件）。
 * ⚠️ WriteStream 是异步的，断言前要等一下 flush。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Logger } from '../src/logger.js'

let pass = 0, fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ① 超阈值 → 必须产生历史文件 */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logrot-'))
  const file = path.join(dir, 'app.log')
  const log = new Logger({ file, maxBytes: 4_000, keep: 3, console: false, ringSize: 10 })
  /* 每条 ~60 字节；分批 await —— WriteStream 的 open 是异步的，紧循环里 fd 一直是 null */
  for (let i = 0; i < 1200; i++) {
    log.info('x'.repeat(50) + ' #' + i)
    if (i % 100 === 99) await sleep(3)
  }
  await sleep(400)
  const files = fs.readdirSync(dir)
  ok('★ 运行中写满阈值 → 落出 .1 历史文件', () => {
    assert.ok(files.some((f) => f.startsWith('app.log.')), `应有历史文件，实际：${files.join(',')}`)
  })
  ok('★ 当前文件被轮转后重新变小（不会无限增长）', () => {
    assert.ok(fs.statSync(file).size < 40_000, `当前 ${fs.statSync(file).size} B`)
  })
}

/* ② maxBytes=0 → 不轮转 */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logrot0-'))
  const file = path.join(dir, 'app.log')
  const log = new Logger({ file, maxBytes: 0, keep: 3, console: false })
  for (let i = 0; i < 800; i++) log.info('y'.repeat(50) + ' #' + i)
  await sleep(300)
  const files = fs.readdirSync(dir)
  ok('★ maxBytes=0 → 不轮转（保持旧行为）', () => {
    assert.equal(files.filter((f) => f.startsWith('app.log.')).length, 0, files.join(','))
  })
}

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
