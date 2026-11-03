/**
 * 人格文件**直接改了就生效**（不用重启）。
 *
 * ## 背景
 * 用户问「自动人格编写生效没有」——
 * 他改的是文件（或者让我改文件），却要**重启 whale-pod 才生效**，
 * 而"改个文件凭什么要重启程序"这件事不会有人联想到。
 *
 * ## 原来为什么不行
 * `read()` 只按路径缓存：
 *     if (this._cache.has(p)) return this._cache.get(p)
 * `write()`（走网页接口那条路）会清缓存，
 * 但**直接改文件**（编辑器 / 脚本 / 我按用户要求改）**不会** ——
 * 跑着的进程永远读旧内容。
 *
 * 实测（2026-11-02）：往 close.md 末尾追加一行后再 read，
 * 长度 3087 → 3087 **没变** —— 缓存把改动吃掉了。
 *
 * ## 现在
 * 缓存记 `mtimeMs + size`，每次读比一次 —— 变了就重读。
 * 代价是每次读多一个 `statSync`；人格文件很小、每条消息读一次，
 * 而"读的还是上一版人格"这种错**很难被发现**，值得。
 *
 * ⚠️ 为什么指纹要 **mtime + size 两个**：
 *    mtime 的精度在某些文件系统上很粗（同一毫秒内的两次改动看不出来），
 *    size 兜一层。两个都相同才算没变。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PersonaStore } from '../src/persona/store.js'

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-pod-persona-'))
const roles = path.join(home, 'persona', 'roles')
fs.mkdirSync(roles, { recursive: true })
const close = path.join(roles, 'close.md')
fs.writeFileSync(close, '# close\n\n第一版。\n', 'utf8')

const store = new PersonaStore({ home, active: 'close', log: {} })
store.init()

ok('★★ 直接改文件后，read() 要读到新内容（不能要重启）', () => {
  const before = store.read('close')
  assert.ok(before.includes('第一版'), '先要有第一版')
  // 模拟"我按用户要求直接改文件"
  fs.writeFileSync(close, before + '\n第二版：加了一句。\n', 'utf8')
  const after = store.read('close')
  assert.ok(after.includes('第二版'),
    '直接改文件必须立刻生效 —— 原来这里会返回缓存里的旧内容，'
    + '用户看到的就是"改了没生效"，而实际要重启 whale-pod')
  assert.notEqual(after, before, '内容必须变了')
})

ok('★ 没改过文件时，read() 返回一致的内容（缓存仍要起作用）', () => {
  const a = store.read('close')
  const b = store.read('close')
  assert.equal(a, b, '没改动时两次读必须一样')
})

ok('★ 文件被删掉后，read() 返回空串而不是抛错', () => {
  fs.rmSync(close, { force: true })
  assert.equal(store.read('close'), '', '文件不在就该给空串（调用方按"没人格"处理）')
})

ok('★ 文件重新出现后也要能读到', () => {
  fs.writeFileSync(close, '# close\n\n又回来了。\n', 'utf8')
  assert.ok(store.read('close').includes('又回来了'), '文件回来就得能读到')
})

fs.rmSync(home, { recursive: true, force: true })
console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)