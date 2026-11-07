/**
 * 贴吧内容要进普通对话（2026-11-07）。
 *
 * 原来只有 `_speakUp`（主动发言）里带 `forumHint`，而且只有几个关键词：
 * 跟她聊「这赛季怎么样」「塔露拉改了没」，她接不上 —— 因为她根本不知道帖子里写了什么。
 *
 * 现在：普通对话也带一小块「订阅的吧刚在聊什么」（关键词 + 每吧 2 条标题），
 * 但明确要求**只在沾边时用一句，不许报菜名**。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { QQBridge } from '../src/qq/bridge.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const fake = {
  cfg: { proactive: { tiebaForums: ['三角洲行动', '明日方舟'] } },
  hotTopics: {
    forumTopics: (names, opt) => [
      { forum: '三角洲行动', keywords: ['阶段', '超临界', '赛季'], count: 30 },
      { forum: '明日方舟', keywords: ['剧情', '塔露拉'], count: 29 },
    ],
    forumItems: (names, n) => [
      { from: '贴吧·三角洲行动吧', title: '【专项反馈】BUG 反馈集中贴' },
      { from: '贴吧·三角洲行动吧', title: '11月5日联动活动开启' },
      { from: '贴吧·明日方舟吧', title: '【将雪投火】出货庆祝集中贴' },
    ],
  },
}

console.log('=== 1. 内容 ===')
ok('★ 带关键词 + 帖子标题', () => {
  const t = QQBridge.prototype._forumDigest.call(fake)
  assert.match(t, /三角洲行动吧.*阶段/)
  assert.match(t, /BUG 反馈集中贴/)
  assert.match(t, /明日方舟吧.*塔露拉/)
})
ok('★ 有"别报菜名"的约束', () => {
  const t = QQBridge.prototype._forumDigest.call(fake)
  assert.match(t, /不要报菜名/)
})
ok('没订阅 → 空串', () => {
  const t = QQBridge.prototype._forumDigest.call({ cfg: {}, hotTopics: fake.hotTopics })
  assert.equal(t, '')
})
ok('没有数据 → 空串，不崩', () => {
  const t = QQBridge.prototype._forumDigest.call({ cfg: { proactive: { tiebaForums: ['x'] } }, hotTopics: {} })
  assert.equal(t, '')
})

console.log('\n=== 2. 真的进了提示词 ===')
ok('★ buildPrompt 里有 forumDigest 调用', () => {
  const src = fs.readFileSync('D:/DSH WorkSpace/whale-pod/src/qq/bridge.js', 'utf8')
  assert.match(src, /this\._forumDigest\(\)/)
  assert.match(src, /_forumDigest\(\) \{/)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
