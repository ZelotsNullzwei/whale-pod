/**
 * 自重复闸（2026-11-04）。
 *
 * ## 现场（群里 704291282）
 * ```
 * 13:36:01 我「风宝是说主题走进程奖励吧，那不还是得肝」
 * 13:36:08 我「风宝说的是主题靠进程奖励拿，不是直接买」
 * 13:36:08 我「（歪头）我说主题得刷够进程才给，白送是不可能的」   ← B 站补一句通道
 * 13:36:25 群友「依旧复读」
 * ```
 * 7 秒内把同一个意思说了三遍，群里当场点破。
 *
 * ## 这个闸管什么、不管什么
 * 只管**内容重复**（原样、包含、同开头、二元组高重合），
 * **不管近义改写** —— 判据收得紧是故意的：误杀 = 该说话的时候不吭声，
 * 比偶尔重复一句更伤人。
 *
 * 所以下面有一条**故意断言"不命中"**的用例（两个近义改写），
 * 那不是漏测，是**已知边界**：这一半要靠提示词（见
 * `## 你刚才说过的话` 那段的措辞）兜，不靠代码猜语义。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { QQBridge } from '../src/qq/bridge.js'
import { PersonaStore } from '../src/persona/store.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

/** 假记忆：只要 `recent()`。 */
const mem = (texts) => ({
  recent: () => texts.map((text, i) => ({ text, isMe: true, at: 1_793_000_000_000 + i * 1000 })),
})

const repeat = (text, texts) => QQBridge.prototype._selfRepeatOf.call({}, text, mem(texts))

const A = '风宝是说主题走进程奖励吧，那不还是得肝'
const B = '风宝说的是主题靠进程奖励拿，不是直接买'

console.log('=== 1. 该命中 ===')
ok('原样重复 → 命中', () => {
  const r = repeat('造背包吧，送的物资够 GTO 那种，别去造 6 级头，亏', [
    '造背包吧，送的物资够 GTO 那种，别去造 6 级头，亏',
  ])
  if (!r) throw new Error('原样重复没命中')
})

ok('只差标点/空白 → 仍算原样', () => {
  const r = repeat('削魂大人啊 这么好用不削才怪', ['削魂大人啊，这么好用不削才怪。'])
  if (!r) throw new Error('归一化后应该相等')
})

ok('同开头 ≥8 字 → 命中', () => {
  const r = repeat('轮椅归轮椅，能点出来就是好用，就是别削啊', [
    '轮椅归轮椅，能点出来就是好用，削了又得重练',
  ])
  if (!r) throw new Error('同开头没命中')
})

ok('一方包含另一方（≥6 字）→ 命中', () => {
  const r = repeat('格子永远不够（躺平）', ['格子永远不够'])
  if (!r) throw new Error('包含关系没命中')
})

console.log('=== 2. 不该命中（别误杀） ===')
ok('短回复（<4 字）不拦 —— 「咋了」「？」是正常接话', () => {
  if (repeat('咋了', ['咋了'])) throw new Error('短回复不该比对')
})

ok('纯表情不拦（那是表情清单的事）', () => {
  if (repeat('[表情包:无语]', ['[表情包:无语]'])) throw new Error('表情不该拦')
})

ok('★ 已知边界：近义改写不命中（靠提示词，不靠代码猜语义）', () => {
  if (repeat(B, [A])) {
    throw new Error('这条判据本来不该命中 —— 一旦能命中，误杀率就上去了')
  }
})

ok('只比最近 3 条 —— 更早说过的可以再说', () => {
  const olds = [A, '第一句别的话', '第二句别的话', '第三句别的话']
  if (repeat(A, olds)) throw new Error('第 4 条之前的不该再拦')
})

console.log('=== 3. 提示词里的指代规则 ===')
const HOME = path.join(root, '.test-home-selfrepeat')
const store = new PersonaStore({ home: HOME, active: 'default', log: {} })
store.init()

ok('群聊 system prompt 里点明「我」指说话人', () => {
  const sys = store.buildSystemPrompt({
    scene: { kind: 'group', groupName: '测试群' },
    self: { nickname: '蓝色大鲸鱼' },
  })
  if (!/「我」指说这句话的人/.test(sys)) throw new Error('缺少指代规则')
})

ok('「你刚才说过的话」那段明确禁止"换个说法再说一遍"', () => {
  const sys = store.buildSystemPrompt({
    scene: { kind: 'group', groupName: '测试群' },
    recentSelf: ['风宝是说主题走进程奖励吧，那不还是得肝'],
  })
  if (!/同一件事不要再说一遍/.test(sys)) throw new Error('那段还是旧措辞（默许复述）')
  if (!/换个词、换个句式重说，一样是复读/.test(sys)) throw new Error('没点明"换说法也是复读"')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)