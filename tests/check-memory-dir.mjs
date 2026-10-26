/**
 * check-memory-dir.mjs —— 记忆目录可配置。
 *
 * 覆盖：
 *   1. memory.dir 为空时跟 home（默认行为不变）
 *   2. 填了就写到指定目录
 *   3. 目录不存在时自动创建
 *   4. 存过之后换个目录能读到新位置
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LongTermStore } from '../src/memory/long.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try {
    fn()
    pass++
    console.log(`  ✅ ${name}`)
  } catch (e) {
    fail++
    console.log(`  ❌ ${name}\n     ${e.message}`)
  }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wp-mem-'))

console.log('记忆目录')

ok('dir 为空 → 跟 home', () => {
  const home = tmp()
  const s = new LongTermStore({ home, cfg: {} })
  assert.equal(s.file, path.join(home, 'memory-long.json'))
  fs.rmSync(home, { recursive: true, force: true })
})

ok('dir 为空字符串 → 还是跟 home', () => {
  const home = tmp()
  const s = new LongTermStore({ home, dir: '', cfg: {} })
  assert.equal(s.file, path.join(home, 'memory-long.json'))
  fs.rmSync(home, { recursive: true, force: true })
})

ok('dir 填了就写到那儿', () => {
  const home = tmp()
  const alt = tmp()
  const s = new LongTermStore({ home, dir: alt, cfg: {} })
  assert.equal(s.file, path.join(alt, 'memory-long.json'))
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(alt, { recursive: true, force: true })
})

ok('dir 前后有空格也能用（trim）', () => {
  const home = tmp()
  const alt = tmp()
  const s = new LongTermStore({ home, dir: `  ${alt}  `, cfg: {} })
  assert.equal(s.file, path.join(alt, 'memory-long.json'))
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(alt, { recursive: true, force: true })
})

ok('写盘后换个目录读不到旧数据（证明真的分开了）', () => {
  const home = tmp()
  const alt = tmp()

  // 在 home 写一份
  const a = new LongTermStore({ home, cfg: { enabled: true } })
  const m = a.get('group:1')
  m.summary = '这是 home 里的摘要'
  a.save()

  // 指向 alt → 应该是空的
  const b = new LongTermStore({ home, dir: alt, cfg: { enabled: true } })
  b.load()
  assert.equal(b.get('group:1').summary, '', 'alt 目录还没有文件，应为空')

  // 写进 alt 之后，home 的数据不受影响
  const m2 = b.get('group:1')
  m2.summary = '这是 alt 里的摘要'
  b.save()

  const c = new LongTermStore({ home, cfg: { enabled: true } })
  c.load()
  assert.equal(c.get('group:1').summary, '这是 home 里的摘要', 'home 那份不该被覆盖')

  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(alt, { recursive: true, force: true })
})

ok('目录不存在时 save 会创建它', () => {
  const home = tmp()
  const nested = path.join(home, 'a', 'b', 'c')
  const s = new LongTermStore({ home, dir: nested, cfg: { enabled: true } })
  s.get('group:1').summary = 'x'
  s.save()
  assert.equal(fs.existsSync(path.join(nested, 'memory-long.json')), true, '应该自动建目录并写文件')
  fs.rmSync(home, { recursive: true, force: true })
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
