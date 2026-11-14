/**
 * 说说文案与发布前检查（2026-11-11 GPT 定稿口径）
 *
 * 三种结构（事实/吐槽/感受），感受句可选；不含"今天"固定开头。
 * 发布前 6 项检查：事实依据 / 一件事 / 无虚构词 / 无营业腔 / 无内部词与第二人称 / 1-2 行且≤40 字。
 */
import assert from 'node:assert/strict'
import { qzoneTextFromFact, checkQzoneText } from '../src/qq/qzoneProactive.js'

let pass = 0, fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

console.log('=== 1. 三种结构 ===')
ok('事实型：事件本身够好 → 不加感受、不加"今天"', () => {
  const t = qzoneTextFromFact('买的牛奶到了')
  assert.equal(t, '买的牛奶到了')
})
ok('吐槽型：有麻烦 → 接一句即兴吐槽', () => {
  const t = qzoneTextFromFact('煮了碗面，洗锅有点烦')
  assert.match(t, /^煮了碗面，洗锅有点烦，.+/)
})
ok('六类表达：得意/吐槽/惊喜/纠结/满足/感慨都能命中', () => {
  const cases = [
    ['桌子收拾干净了', /还有点小得意|自己看着都顺眼|这波不亏|总算有点成就感/],
    ['洗碗真的很影响做饭的积极性', /真不知道谁想出来的|下次一定不折腾|这步骤真的很劝退|有点烦/],
    ['今天的煎蛋意外地漂亮', /还挺意外的|没想到这么好看|有点小惊喜/],
    ['想扔又觉得还能用', /想放着又觉得该弄完|有点拿不定主意|舍不得下口/],
    ['汤挺好喝的', /挺满足的|心里舒服多了|这样挺好/],
    ['下午什么正事都没干', /好像也没觉得浪费时间|今天就这样吧|不跟自己较劲了/],
  ]
  for (const [f, re] of cases) assert.match(qzoneTextFromFact(f), re, f)
  assert.ok(!/[！!～~]/.test(qzoneTextFromFact('今天的煎蛋意外地漂亮')), '不要感叹号/波浪号')
})
ok('感受型：有情绪记录 → 接一句自然感受', () => {
  const t = qzoneTextFromFact('桌子收拾干净了', { mood: '平静' })
  assert.match(t, /，(.+)$/)
  assert.ok(!/^今天/.test(t), '不要固定"今天"开头')
})
ok('≤40 字（去掉空白后）', () => {
  for (const f of ['买的牛奶到了', '煮了碗面，洗锅有点烦', '地上又是一层头发，蓝色的也不能这么掉吧']) {
    assert.ok(qzoneTextFromFact(f).replace(/\s/g, '').length <= 40, f)
  }
})

console.log('\n=== 2. 发布前检查（6 项） ===')
ok('★ 正常一条：通过', () => {
  const fact = '买的牛奶到了'
  assert.equal(checkQzoneText(qzoneTextFromFact(fact), fact).ok, true)
})
ok('营业腔/鸡汤：不通过', () => {
  const r = checkQzoneText('今天也要元气满满，生活的小确幸', '今天也要元气满满')
  assert.equal(r.ok, false)
})
ok('第二人称：不通过', () => {
  assert.equal(checkQzoneText('买了牛奶，你喝不喝', '买了牛奶').ok, false)
})
ok('话题标签：不通过', () => {
  assert.equal(checkQzoneText('买了牛奶 #日常', '买了牛奶').ok, false)
})
ok('超过 40 字：不通过', () => {
  const long = '把桌子上堆了半个月的书、纸、快递盒、旧充电线和一堆不知道有没有用的东西全都收拾干净了'
  assert.equal(checkQzoneText(long, long).ok, false)
})
ok('超过两行：不通过', () => {
  assert.equal(checkQzoneText('买了牛奶\n顺手整理了冰箱\n还挺顺', '买了牛奶').ok, false)
})
ok('没有事实依据：不通过', () => {
  assert.equal(checkQzoneText('今天天气真好呀', '买的牛奶到了').ok, false)
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
