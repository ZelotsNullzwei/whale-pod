/**
 * 拒答兜底（2026-11-10）
 *
 * 两件事：
 *   ① 兜底**真的接上了**：整条被上游拒答时，会发一句短反应，而不是静默丢弃。
 *   ② 不能把正常台词当拒答删掉：「我不能继续了……」属于场景里的自然台词。
 *
 * 另外锁住池子规模（7/7/7/7/4 = 32）和「阶段词与池子内容一致」，
 * 因为 2026-11-10 实测过：池子里有「别停」「再深一点」，但判定词里没有
 * 「停」「深」，那两句永远轮不到。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { QQBridge } from '../src/qq/bridge.js'

let pass = 0, fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const b = Object.create(QQBridge.prototype)

/** 固定随机数：pick 池子里第 idx 个（0=第一个，0.999=最后一个） */
async function withRandom(v, fn) {
  const orig = Math.random
  Math.random = () => v
  try { return await fn() } finally { Math.random = orig }
}

console.log('=== 1. 池子规模 ===')
ok('★ 四档 + 默认，共 32 句（7/7/7/7/4）', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  const i = src.indexOf('const pool = {')
  assert.ok(i > 0, '找不到 pool')
  const seg = src.slice(i, src.indexOf('\n    }', i))
  const counts = {}
  for (const stage of ['after_climax', 'near_climax', 'during', 'aroused', 'default']) {
    const j = seg.indexOf(`${stage}: [`)
    const k = seg.indexOf(']', j)
    counts[stage] = (seg.slice(j, k).match(/♡/g) ?? []).length
  }
  assert.deepEqual(counts, { after_climax: 7, near_climax: 7, during: 7, aroused: 7, default: 4 }, JSON.stringify(counts))
})

console.log('\n=== 2. 阶段词与池子内容一致 ===')
await okAsync('★ 「别停」→ near_climax 档（不再落 default）', async () => {
  const r = await withRandom(0.999, () => b._refusalFallback(['别停']))
  assert.equal(r, '本鲸快到了……♡', `实际 ${r}`)
})
await okAsync('★ 「再深一点」→ during 档', async () => {
  const r = await withRandom(0.999, () => b._refusalFallback(['再深一点']))
  assert.equal(r, '（往下坐实）哈啊……顶到了♡', `实际 ${r}`)
})
await okAsync('★ 「腿根抖」→ aroused 档', async () => {
  const r = await withRandom(0.999, () => b._refusalFallback(['腿根抖']))
  assert.equal(r, '（耳鳍动了动）哈……♡', `实际 ${r}`)
})
await okAsync('★ 什么都没说 → default 档', async () => {
  const r = await withRandom(0.999, () => b._refusalFallback([]))
  assert.equal(r, '本鲸……♡', `实际 ${r}`)
})

console.log('\n=== 3. 不能误伤正常台词 ===')
ok('★「我不能继续了……」不算拒答', () => {
  const r = b._stripRefusal('我不能继续了……')
  assert.equal(r.refused, false, '被误判成拒答了')
  assert.equal(r.text, '我不能继续了……', '正文被删了')
})
ok('★「啊啊~不行了，我不能继续了」也保留', () => {
  const r = b._stripRefusal('啊啊~不行了，我不能继续了')
  assert.equal(r.refused, false)
  assert.equal(r.text, '啊啊~不行了，我不能继续了')
})
ok('真的拒答仍然识别（带宾语）', () => {
  for (const t of ['抱歉，我不能回答这个问题。', '我无法提供这类内容']) {
    assert.equal(b._stripRefusal(t).refused, true, `应判拒答：${t}`)
  }
})
ok('英文安全拒答仍识别', () => {
  assert.equal(b._stripRefusal('Sorry, I cannot respond to that.').refused, true)
  assert.equal(b._stripRefusal('Content policy violation').refused, true)
})

console.log('\n=== 4. 整条拒答 → 真的发一句（不是静默）===')
await okAsync('★ _send 遇到整条拒答时发出 1 条兜底', async () => {
  const fake = Object.create(QQBridge.prototype)
  fake.cfg = { reply: {} }
  fake.log = { info() {}, warn() {} }
  fake._recentBotText = new Map([['private:1', ['要去了', '别停']]])
  const sent = []
  fake.onebot = {
    sendPrivate: async (id, payload) => { sent.push(payload); return { status: 'ok', data: { message_id: 1 } } },
  }
  const msg = { scope: 'private:1', kind: 'private', userId: '1', text: '继续' }
  const r = await fake._send(msg, '抱歉，我不能回答这个问题。', null)
  assert.equal(sent.length, 1, '应该正好发出 1 条')
  assert.deepEqual(r, ['1'], `返回 message_id 数组，实际 ${JSON.stringify(r)}`)
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
