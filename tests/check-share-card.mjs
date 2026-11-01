/**
 * 分享卡片（`json` / `xml` 段）的解析（2026-10-31）。
 *
 * ## 事故
 * 群里/私聊分享 B 站视频，NapCat 给的是 **`json` 段**（结构化卡片），
 * 而 `parseMessage` 原来对未知类型是「**其它类型：忽略，不污染文本**」——
 * **整条消息消失**，`msg.text` 变成空串。
 *
 * 实测（私聊原文）：
 * ```
 * 20:16:44  他「」                     ← text 是空的
 * 20:16:46  我「啥也没发，手滑了吧」    ← 她以为对方手滑
 * ```
 * 那条其实是一条 B 站分享。
 *
 * ## 规则
 * 抠出「【标题】链接」；**抠不到也必须给 `[分享]`，不能是空串** ——
 * 否则又退化成"手滑发了条空的"。
 */

import assert from 'node:assert/strict'
import { parseMessage } from '../src/qq/onebot.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`) } catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}\n`) }
}

const asSegs = (segs) => parseMessage(segs).text

console.log('=== json 卡片（数组段）===')

ok('★ B站 news 卡片 → 【标题】链接', () => {
  const t = asSegs([{
    type: 'json',
    data: {
      data: JSON.stringify({
        app: 'com.tencent.structmsg',
        meta: { news: { title: '显卡驱动更新完三角洲行动很卡怎么办', jumpUrl: 'https://www.bilibili.com/video/BV1GJ411x7h7' } },
      }),
    },
  }])
  assert.equal(t, '【显卡驱动更新完三角洲行动很卡怎么办】https://www.bilibili.com/video/BV1GJ411x7h7')
})

ok('★ detail 卡片的 qqdocurl 是 URL-encoded，要解开', () => {
  const t = asSegs([{
    type: 'json',
    data: {
      data: JSON.stringify({
        meta: { detail: { title: '三角洲卡顿解决', qqdocurl: 'https%3A%2F%2Fwww.bilibili.com%2Fvideo%2FBV1xx411c7mD' } },
      }),
    },
  }])
  assert.match(t, /【三角洲卡顿解决】/)
  assert.match(t, /https:\/\/www\.bilibili\.com\/video\/BV1xx411c7mD/, '编码要解开成正常 URL')
})

ok('★ 抠不到任何东西 → `[分享]`（**不能是空串**）', () => {
  assert.equal(asSegs([{ type: 'json', data: { data: '{}' } }]), '[分享]')
  assert.equal(asSegs([{ type: 'json', data: { data: 'not json at all' } }]), '[分享]')
})

ok('★★ `detail_1`（QQ 小程序卡片的 key，带下划线+数字）也要认', () => {
  /*
   * ⚠️ 这是**这轮真正的坑**：原来硬编码
   * `['news','detail','music','video','share']` —— 漏了 `detail_1`。
   * 实测那条分享只解析出「【[QQ小程序]小克你最好了】」，**没有 URL**，
   * 于是后续 `_biliContext` 触发不了、评论/弹幕永远拿不到。
   * 现在改成**遍历 meta 的所有子对象**，不再猜 key。
   */
  const t = asSegs([{
    type: 'json',
    data: {
      data: JSON.stringify({
        app: 'com.tencent.miniapp_01',
        meta: { detail_1: { title: '小克你最好了', qqdocurl: 'https%3A%2F%2Fwww.bilibili.com%2Fvideo%2FBV1GJ411x7h7' } },
      }),
    },
  }])
  assert.match(t, /【小克你最好了】/)
  assert.match(t, /https:\/\/www\.bilibili\.com\/video\/BV1GJ411x7h7/, '★ detail_1 里的 qqdocurl 也要抠出来')
})

ok('`preview`（封面图）不能被当成跳转链接', () => {
  const t = asSegs([{
    type: 'json',
    data: { data: JSON.stringify({ meta: { news: { title: '标题', preview: 'https://i0.hdslb.com/cover.jpg' } } }) },
  }])
  assert.match(t, /【标题】/)
  assert.ok(!/hdslb\.com\/cover/.test(t), '封面图不是链接，不该拼进去')
})

console.log('\n=== xml 卡片 ===')

ok('★ XML 卡片 → 【标题】链接', () => {
  const t = asSegs([{
    type: 'xml',
    data: { data: '<msg brief="【分享】好看视频"><item><title>某B站视频</title><url>https://www.bilibili.com/video/BV1GJ411x7h7</url></item></msg>' },
  }])
  assert.equal(t, '【某B站视频】https://www.bilibili.com/video/BV1GJ411x7h7')
})

ok('XML 没有 <title> 时退回 brief 属性', () => {
  const t = asSegs([{ type: 'xml', data: { data: '<msg brief="某视频标题"></msg>' } }])
  assert.match(t, /【某视频标题】/)
})

console.log('\n=== CQ 码字符串形式 ===')
/*
 * ⚠️ 这里有个坑：CQ 参数的通用解析是**按 `,` 切**的，
 * 而 `data={"meta":{...}}` 里的 JSON **本身就含逗号** —— 会被切断。
 * 所以分享卡片要用**原始 rest 串**，不能走那个 `data` 对象。
 */

ok('★ CQ 码形式的 json 卡片也要能抠出来', () => {
  const cq = '[CQ:json,data={"meta":{"news":{"title":"CQ里的标题","jumpUrl":"https://www.bilibili.com/video/BV1GJ411x7h7"}}}]'
  const t = parseMessage(cq).text
  assert.match(t, /【CQ里的标题】/)
  assert.match(t, /BV1GJ411x7h7/)
})

console.log('\n=== 不破坏正常消息 ===')

ok('普通文本不受影响', () => {
  assert.equal(asSegs([{ type: 'text', data: { text: '今天吃了个橘子' } }]), '今天吃了个橘子')
})

ok('文本 + 分享混排 → 都保留', () => {
  const t = asSegs([
    { type: 'text', data: { text: '看这个 ' } },
    { type: 'json', data: { data: JSON.stringify({ meta: { news: { title: '标题X', jumpUrl: 'https://b23.tv/abc' } } }) } },
  ])
  assert.match(t, /看这个/)
  assert.match(t, /【标题X】https:\/\/b23\.tv\/abc/)
})

ok('图文混排里夹分享也保留', () => {
  const t = asSegs([
    { type: 'image', data: { url: 'https://x/a.jpg' } },
    { type: 'json', data: { data: JSON.stringify({ meta: { news: { title: 'T', jumpUrl: 'https://b23.tv/z' } } }) } },
  ])
  assert.match(t, /\[图片\]/)
  assert.match(t, /【T】/)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
