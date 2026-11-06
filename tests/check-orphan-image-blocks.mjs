/**
 * 无主图块必须补挂到最后一条 user 消息（2026-11-06 线上实测）。
 *
 * ## 现场
 * ```
 * 13:13:47  转发图 1 块进上下文（视觉模型能看到）      ← 我以为挂上了
 * 13:13:49  本条带 1 张图发给 …（若模型不支持视觉，图等于没传）
 * 13:14:01  [我]「这次没收到图啊，本鱼这边是空的。」    ← 她是真看不见
 * ```
 *
 * ## 根因
 * `buildChatMessages` 挂图是这么写的：
 * ```js
 * for (const ref of (m.images ?? [])) { const blk = imageCache.get(ref); if (blk) blocks.push(blk) }
 * ```
 * **只有消息自己 `images` 里列出的 ref 才会被挂**。
 *
 * 而转发图 / B 站分镜图 / 车牌截图走的是 `extraBlocks`，
 * 键是 `fwd:img:1` / `bili:shot:1` 这种**自造 key** ——
 * 没有任何消息的 `images` 引用它 → 块躺在缓存里，
 * **从来没被塞进请求**。日志里 imgCount 算得出"有 1 张"，
 * 但那 1 张根本没发出去：典型"日志全对、实际没传"。
 */
import assert from 'node:assert/strict'
import { buildChatMessages, attachOrphanBlocks } from '../src/qq/bridge.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const mkBlock = (tag) => ({ type: 'image', dataUrl: `data:image/jpeg;base64,${tag}` })
const user = (text, images = []) => ({ text, isMe: false, senderName: '甲', images })

console.log('=== 1. 无主块要被补挂 ===')
ok('★ 转发图（fwd:img:1）不在任何 messages.images 里 → 补挂到最后一条 user', () => {
  const history = [user('[转发了聊天记录·6条]')]
  const cache = new Map([['fwd:img:1', mkBlock('FWD')]])
  const msgs = buildChatMessages({ system: 'S', history, imageCache: cache })

  const before = msgs[msgs.length - 1].content.length
  const n = attachOrphanBlocks(msgs, history, cache)
  const after = msgs[msgs.length - 1].content

  assert.equal(n, 1, '应该补挂 1 块')
  assert.equal(after.length, before + 1)
  assert.ok(after.some((b) => b.type === 'image' && /FWD/.test(String(b.dataUrl))), '图片块要真的进 content')
})

ok('B 站分镜图（bili:shot:N）同样补挂 —— 走的是同一个口子', () => {
  const history = [user('看这个视频')]
  const cache = new Map([
    ['bili:shot:1', mkBlock('S1')],
    ['bili:shot:2', mkBlock('S2')],
  ])
  const msgs = buildChatMessages({ system: 'S', history, imageCache: cache })
  const n = attachOrphanBlocks(msgs, history, cache)
  assert.equal(n, 2)
  const imgs = msgs[msgs.length - 1].content.filter((b) => b.type === 'image')
  assert.equal(imgs.length, 2)
})

console.log('\n=== 2. 别把正常的图挂两遍 ===')
ok('⚠️ 消息 images 里已列出的 ref **不算**无主（不能重复挂）', () => {
  const history = [user('[图片]', ['https://x/a.jpg'])]
  const cache = new Map([['https://x/a.jpg', mkBlock('A')]])
  const msgs = buildChatMessages({ system: 'S', history, imageCache: cache })
  const before = msgs[msgs.length - 1].content.filter((b) => b.type === 'image').length
  const n = attachOrphanBlocks(msgs, history, cache)
  assert.equal(n, 0, '不该补挂')
  const after = msgs[msgs.length - 1].content.filter((b) => b.type === 'image').length
  assert.equal(after, before, '图不能变多')
})

ok('混合：一张正常图 + 一张转发图 → 只补那张转发图', () => {
  const history = [user('[图片]', ['https://x/a.jpg'])]
  const cache = new Map([
    ['https://x/a.jpg', mkBlock('A')],
    ['fwd:img:1', mkBlock('FWD')],
  ])
  const msgs = buildChatMessages({ system: 'S', history, imageCache: cache })
  const n = attachOrphanBlocks(msgs, history, cache)
  assert.equal(n, 1)
  const imgs = msgs[msgs.length - 1].content.filter((b) => b.type === 'image')
  assert.equal(imgs.length, 2, '两张都要在')
})

console.log('\n=== 3. 边界 ===')
ok('缓存为空 → 不动', () => {
  const history = [user('你好')]
  const msgs = buildChatMessages({ system: 'S', history, imageCache: new Map() })
  assert.equal(attachOrphanBlocks(msgs, history, new Map()), 0)
})

ok('没有 user 消息（只有 assistant）→ 不挂（上游不认）', () => {
  const history = [{ text: '[SILENT]', isMe: true, images: [] }]
  const cache = new Map([['fwd:img:1', mkBlock('FWD')]])
  const msgs = buildChatMessages({ system: 'S', history, imageCache: cache })
  assert.equal(attachOrphanBlocks(msgs, history, cache), 0)
})

ok('最后一条是 assistant、前面有 user → 挂到那条 user 上', () => {
  const history = [
    user('看这个'),
    { text: '嗯', isMe: true, senderName: '本鱼', images: [] },
  ]
  const cache = new Map([['fwd:img:1', mkBlock('FWD')]])
  const msgs = buildChatMessages({ system: 'S', history, imageCache: cache })
  const n = attachOrphanBlocks(msgs, history, cache)
  assert.equal(n, 1)
  const target = msgs.filter((m) => m.role === 'user').pop()
  assert.ok(target.content.some((b) => b.type === 'image'), 'user 那条要有图')
})

ok('返回值就是补挂块数（供日志）', () => {
  const history = [user('x')]
  const cache = new Map([['fwd:img:1', mkBlock('1')], ['fwd:img:2', mkBlock('2')]])
  const msgs = buildChatMessages({ system: 'S', history, imageCache: cache })
  assert.equal(attachOrphanBlocks(msgs, history, cache), 2)
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
