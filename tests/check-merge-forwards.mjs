/**
 * 连发合并后转发 id 不能丢（2026-11-06 线上实测）。
 *
 * ## 现场
 * ```
 * 12:14:57  合并 3 条 → 一条处理（private:2129024700）「现在呢 / [合并转发] / 能看吗」
 * 12:15:03  [我]「看到个卡片，内容点不开。」
 * ```
 * 她看到的是**字面量**「[合并转发]」—— 展开根本没跑（日志里一条
 * `合并转发展开` 都没有）。
 *
 * ## 根因
 * `_mergeBurst` 最后是 `return { ...last, text, images }` —— 字段以
 * **最后一条**为准。而最后一条「能看吗」的 `forwards` 是 `[]`，
 * 把中间那条带的转发 id **抹掉了**。于是 `_handle` 里
 * `msg.forwards.length > 0` 判假，整段展开逻辑不执行。
 *
 * 修法跟 images / stickerRefs 一样：取**并集**。
 */
import assert from 'node:assert/strict'
import { QQBridge } from '../src/qq/bridge.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const merge = (msgs) => QQBridge.prototype._mergeBurst(msgs)
const m = (text, extra = {}) => ({ text, userId: '1', senderName: '甲', ...extra })

console.log('=== 1. 转发 id 必须活过合并 ===')
ok('★ 三条连发、转发生在**中间** → id 不能丢（线上就是这个）', () => {
  const r = merge([
    m('现在呢'),
    m('[合并转发]', { forwards: [{ id: '7704891221357637709' }] }),
    m('能看吗'),
  ])
  assert.deepEqual(r.forwards, [{ id: '7704891221357637709' }])
  assert.match(r.text, /\[合并转发\]/)
})

ok('转发生在**最后一条** → 本来就能过，别回归', () => {
  const r = merge([m('看'), m('[合并转发]', { forwards: [{ id: 'aaa' }] })])
  assert.deepEqual(r.forwards, [{ id: 'aaa' }])
})

ok('两条转发 → 并集（按 id 去重，保持顺序）', () => {
  const r = merge([
    m('a', { forwards: [{ id: 'x' }] }),
    m('b', { forwards: [{ id: 'y' }, { id: 'x' }] }),
  ])
  assert.deepEqual(r.forwards.map((f) => f.id), ['x', 'y'])
})

ok('都没有转发 → 空数组（老行为不变）', () => {
  assert.deepEqual(merge([m('a'), m('b')]).forwards, [])
})

ok('单条消息（不合并）→ 原样带 forwards', () => {
  const one = m('[合并转发]', { forwards: [{ id: 'z' }] })
  assert.deepEqual(one.forwards, [{ id: 'z' }], '单条不走 _mergeBurst，这里只确认形状')
})

console.log('\n=== 2. 别的东西不能被顺手改坏 ===')
ok('图片/表情仍是并集', () => {
  const r = merge([
    m('a', { images: ['i1'], stickerRefs: ['s1'] }),
    m('b', { images: ['i2'] }),
  ])
  assert.deepEqual(r.images, ['i1', 'i2'])
  assert.deepEqual(r.stickerRefs, ['s1'])
})

ok('文本用单换行连接（空行会被当成"显式分段"，那就白合并了）', () => {
  assert.equal(merge([m('第一句'), m('第二句')]).text, '第一句\n第二句')
})

ok('跨人合并要带名字（否则把 A 的话当成 B 说的）', () => {
  const r = merge([
    { text: 'A说的话', userId: '1', senderName: '甲' },
    { text: 'B说的话', userId: '2', senderName: '乙' },
  ])
  assert.match(r.text, /甲: A说的话/)
  assert.match(r.text, /乙: B说的话/)
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)