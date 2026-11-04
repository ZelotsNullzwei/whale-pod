/**
 * `[回应:…]` 要真的能跑起来（2026-11-04 20:xx）。
 *
 * ## 交付文档里那条实测
 * ```
 * 19:43:35 / 19:43:43 / 19:50:37  qq-actions：signature 被开关关掉了
 * [回应] / [戳] 一次都没触发过 —— 她不知道表情编号该写什么
 * ```
 * 「输出 [回应:表情编号]」这句提示词等于没说：编号从哪儿来？
 * 于是这条通道从来没被用过。
 *
 * ## 守什么
 * ① 提示词里**必须有具体编号**，而且编号真能在 `faces.json` 里查到
 * ② 她写名字（`[回应:偷笑]`）也要能用 —— 名字比数字熟练得多
 * ③ 名字查不到 → **不发，也不许把标记漏到正文里**
 * ④ `[戳]` 要带使用场景（私聊催话 / 群里打招呼），不然同样不会触发
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildEmojiHint,
  resolveEmojiId,
  faceIdOf,
  extractQQMarkers,
  runQQMarkers,
  EMOJI_ID_MIN,
  EMOJI_ID_MAX,
} from '../src/qq/qqActions.js'
import FACE_TABLE from '../src/qq/faces.json' with { type: 'json' }

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const here = path.dirname(fileURLToPath(import.meta.url))
const readSrc = (p) => fs.readFileSync(path.join(here, '..', p), 'utf8')

console.log('=== 1. 提示词里的编号是"真能用"的 ===')
ok('至少给 10 个可用编号', () => {
  const hint = buildEmojiHint()
  const items = hint.split('/').map((s) => s.trim()).filter(Boolean)
  assert.ok(items.length >= 10, `只有 ${items.length} 个`)
})

ok('每个编号都落在 0~104，且跟表情表对得上', () => {
  const hint = buildEmojiHint()
  for (const item of hint.split('/').map((s) => s.trim()).filter(Boolean)) {
    const m = item.match(/^(.+?)(\d+)$/)
    assert.ok(m, `格式不对：${item}`)
    const [, name, id] = m
    assert.equal(Number(id), faceIdOf(name), `${name} 的编号跟表不一致`)
    assert.ok(Number(id) >= EMOJI_ID_MIN && Number(id) <= EMOJI_ID_MAX, `${name}=${id} 越界`)
  }
})

ok('表里只有经典小黄脸是数字（动画表情不该被列进来）', () => {
  for (const [name, v] of Object.entries(FACE_TABLE)) {
    if (typeof v === 'number') {
      assert.ok(v >= EMOJI_ID_MIN && v <= EMOJI_ID_MAX, `${name}=${v}`)
    }
  }
})

console.log('\n=== 2. 编号和名字都认 ===')
ok('数字直接过', () => {
  assert.equal(resolveEmojiId('13'), 13)
  assert.equal(resolveEmojiId('0'), 0)
  assert.equal(resolveEmojiId('104'), 104)
})
ok('越界/非数字编号一律拒（免得发出一个错表情）', () => {
  assert.equal(resolveEmojiId('105'), null)
  assert.equal(resolveEmojiId('999'), null)
})
ok('表情名能翻成编号', () => {
  assert.equal(resolveEmojiId('偷笑'), faceIdOf('偷笑'))
  assert.equal(resolveEmojiId('白眼'), faceIdOf('白眼'))
})
ok('多写了几个字也能兜住（模糊匹配）', () => {
  const id = resolveEmojiId('有点委屈')
  assert.equal(id, faceIdOf('委屈'))
})
ok('瞎写的名字 → null（宁可不发，也不发错）', () => {
  assert.equal(resolveEmojiId('瞎写'), null)
  assert.equal(resolveEmojiId(''), null)
  assert.equal(resolveEmojiId(null), null)
})

console.log('\n=== 3. 名字形态的标记：认得出 + 剥得干净 ===')
ok('[回应:偷笑] 会被抽走，正文不留方括号', () => {
  const r = extractQQMarkers('好呀[回应:偷笑]')
  assert.equal(r.items[0].id, 'emojiLike')
  assert.equal(r.items[0].arg, '偷笑')
  assert.equal(r.text, '好呀')
})
ok('没认出来的标记也必须剥干净（绝不能漏到聊天里）', () => {
  const r = extractQQMarkers('行吧[回应:瞎写]')
  assert.equal(r.text, '行吧')
})

console.log('\n=== 4. 执行：名字也要真的发出编号 ===')
await (async () => {
  const mkOnebot = () => {
    const calls = []
    return {
      calls,
      _sendPreferHttp: async (action, params) => { calls.push({ action, params }); return { status: 'ok' } },
    }
  }

  await okAsync('名字 → 调 set_msg_emoji_like 且 emoji_id 是数字', async () => {
    const onebot = mkOnebot()
    const notes = await runQQMarkers({
      items: [{ id: 'emojiLike', arg: '偷笑' }],
      onebot,
      msg: { messageId: '777', scope: 'group:1', groupId: '1', userId: '2' },
      mem: { recent: () => [] },
      log: {},
    })
    assert.equal(onebot.calls[0].action, 'set_msg_emoji_like')
    assert.equal(onebot.calls[0].params.message_id, '777')
    assert.equal(onebot.calls[0].params.emoji_id, String(faceIdOf('偷笑')))
    assert.deepEqual(notes, ['回应了'])
  })

  await okAsync('认不出来的名字 → 一次 API 都不调', async () => {
    const onebot = mkOnebot()
    const notes = await runQQMarkers({
      items: [{ id: 'emojiLike', arg: '瞎写' }],
      onebot,
      msg: { messageId: '777', scope: 'group:1' },
      mem: { recent: () => [] },
      log: {},
    })
    assert.equal(onebot.calls.length, 0)
    assert.deepEqual(notes, [])
  })
})()

console.log('\n=== 5. 提示词接线（形状断言）===')
ok('bridge 用 buildEmojiHint 生成编号表，而不是只说"表情编号"', () => {
  const src = readSrc('src/qq/bridge.js')
  assert.match(src, /buildEmojiHint\(\)/)
  assert.match(src, /可用编号/)
  assert.match(src, /\[回应:13\]/)
})
ok('[戳] 带上了使用场景（私聊催话 / 群里打招呼）', () => {
  const src = readSrc('src/qq/bridge.js')
  assert.match(src, /催他回话/)
  assert.match(src, /打个招呼/)
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)