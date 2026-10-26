/**
 * 多模态端到端验证（不依赖真实 QQ 群）。
 *
 * 验证三件事：
 *   1. 决策层：带图片的消息意愿被抬高（否则"别人发图它一律沉默"）
 *   2. bridge：图片 → ImageBlock 的转换正确（字段符合 dsh-llm 契约）
 *   3. 清洗：模型吐出的工具调用标记不会流到群里
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = 'D:/DSH WorkSpace/whale-pod'
const imp = (p) => import(pathToFileURL(path.join(root, p)).href)

let pass = 0, fail = 0
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log('  ✅ ' + name) }
  else { fail++; console.log('  ❌ ' + name + ' ' + extra) }
}

// ── 1. 决策层：图片抬高意愿 ────────────────────────────────────
console.log('=== 1. 决策层：带图消息的回复意愿 ===')
{
  const { RuleDecisionProvider } = await imp('src/decision/rule.js')
  const d = new RuleDecisionProvider({}, {})

  const base = {
    scope: 'group:1', kind: 'group', groupId: '1',
    self: { qq: '999', nickname: 'Bot' },
    scene: { kind: 'group', groupId: '1', groupName: '测试群' },
    sinceMyLastMessage: 999999,
    consecutiveTurns: 0,
  }
  const mk = (text, images) => ({
    ...base,
    messages: [
      { sender: '111', senderName: '甲', text: '前面有人说话', at: Date.now() - 5000, isMe: false },
      { sender: '111', senderName: '甲', text: '大家好啊', at: Date.now() - 3000, isMe: false },
      { sender: '222', senderName: '乙', text, images, at: Date.now(), isMe: false },
    ],
  })

  // 多条采样取平均（规则里有随机成分）
  const avg = async (text, images) => {
    let sum = 0
    for (let i = 0; i < 200; i++) {
      const r = await d.decide(mk(text, images))
      sum += r.probability ?? 0
    }
    return sum / 200
  }

  const pPlain = await avg('今天天气不错', [])
  const pImage = await avg('[图片]', ['http://x/a.jpg'])
  const pMface = await avg('[表情包:猫猫]', ['http://x/b.gif'])

  console.log(`     纯文本 p≈${pPlain.toFixed(3)}  图片 p≈${pImage.toFixed(3)}  表情包 p≈${pMface.toFixed(3)}`)
  check('带图片时意愿显著高于纯文本', pImage > pPlain * 1.5, `${pPlain.toFixed(3)} → ${pImage.toFixed(3)}`)
  check('表情包同样抬高意愿', pMface > pPlain * 1.5, `${pPlain.toFixed(3)} → ${pMface.toFixed(3)}`)
  check('意愿有上限（不会变成必回）', pImage <= 0.76, String(pImage))
}

// ── 2. bridge：图片转换 ───────────────────────────────────────
console.log('\n=== 2. bridge：图片 → ImageBlock ===')
{
  const { QQBridge } = await imp('src/qq/bridge.js')

  // 用假的 gateway/onebot，观察 bridge 的行为
  let receivedBlocks = null
  const fakeGateway = {
    providers: ['fake'],
    catalog: [],
    defaultModels: () => ({}),
    makeImageBlock: async ({ base64, mediaType, name }) => ({
      type: 'image',
      attachment: {
        attachmentId: 'sha256:' + String(base64).slice(0, 8),
        mediaType, width: 10, height: 10, bytes: base64.length,
        ...(name ? { name } : {}),
      },
    }),
    stream: async function* () { yield { type: 'text-delta', text: '看到图了' } },
  }
  const fakeOnebot = {
    fetchImage: async () => ({
      dataUrl: 'data:image/png;base64,' + Buffer.from('FAKE_PNG').toString('base64'),
      mime: 'image/png',
    }),
    call: async () => ({ data: {} }),
  }

  const br = new QQBridge({
    cfg: { reply: { imagesEnabled: true, maxImages: 2 }, model: 'fake/m', maxTokens: 64 },
    onebot: fakeOnebot,
    gateway: fakeGateway,
    decision: { decide: async () => ({ reply: true, probability: 1 }) },
    memory: {
      get: () => ({
        push: () => {}, tick: () => {}, recent: () => [
          { sender: '222', senderName: '乙', text: '[图片]', images: ['http://x/a.jpg'], at: Date.now(), isMe: false },
        ],
        toDecisionInput: () => ({ messages: [] }),
      }),
    },
    persona: { buildSystemPrompt: () => 'sys' },
    log: {},
  })

  const collected = await br._collectImages([
    { sender: '222', text: '[图片]', images: ['http://x/a.jpg'], at: Date.now(), isMe: false },
  ])
  const blk = collected.get('http://x/a.jpg')
  check('图片被转成 ImageBlock', Boolean(blk && blk.type === 'image'))
  check('ImageBlock 用 attachment 字段（不是 url）',
    Boolean(blk?.attachment?.attachmentId), JSON.stringify(blk))
  check('attachment 含 mediaType/宽高', Boolean(blk?.attachment?.mediaType && blk?.attachment?.width))

  // attachment 服务不可用时应降级而不是抛错
  const br2 = new QQBridge({
    cfg: { reply: { imagesEnabled: true } },
    onebot: fakeOnebot,
    gateway: { providers: [] },   // 没有 makeImageBlock
    decision: {}, memory: {}, persona: {}, log: {},
  })
  const c2 = await br2._collectImages([
    { sender: '1', text: '[图片]', images: ['http://x/a.jpg'], at: Date.now(), isMe: false },
  ])
  check('没有 attachment 服务时安全降级（不抛错）', c2.size === 0)
}

// ── 3. 清洗模型输出 ───────────────────────────────────────────
console.log('\n=== 3. 清洗工具调用残留 ===')
{
  const { cleanModelText } = await imp('src/qq/bridge.js')
  const leaked = '？\n\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="get_weather">\n' +
    '<｜｜DSML｜｜ parameter name="city">北京</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>'
  const out = cleanModelText(leaked)
  check('DSML 标签被清掉', !/DSML|invoke|parameter/i.test(out), JSON.stringify(out))
  check('普通文本不受影响', cleanModelText('在的，什么事？') === '在的，什么事？')
  check('正常尖括号不受影响', cleanModelText('价格是 <100> 元') === '价格是 <100> 元')
  // ⚠️ 表情标记不能被清洗误删 —— 它是"机器人发表情"的唯一表达方式
  check('表情标记不被误删', cleanModelText('你好[表情:4]') === '你好[表情:4]', cleanModelText('你好[表情:4]'))
  check('表情包标记不被误删', cleanModelText('[表情包:猫猫]') === '[表情包:猫猫]')
}

// ── 4. 表情标记 → 消息段 ──────────────────────────────────────
console.log('\n=== 4. 表情标记切分（发送时转成真表情）===')
{
  const { splitFaceMarkers } = await imp('src/qq/bridge.js')

  const a = splitFaceMarkers('你好[表情:4]再见')
  check('文本+表情混排切分正确',
    a.length === 3 && a[0].kind === 'text' && a[1].kind === 'face' && a[1].id === '4' && a[2].kind === 'text',
    JSON.stringify(a))

  const b = splitFaceMarkers('[表情包:猫猫]')
  check('纯表情包标记', b.length === 1 && b[0].kind === 'mface' && b[0].name === '猫猫', JSON.stringify(b))

  const c = splitFaceMarkers('没有表情')
  check('无标记原样返回', c.length === 1 && c[0].kind === 'text', JSON.stringify(c))

  const d = splitFaceMarkers('[表情:4][表情包:笑]')
  check('多表情切分', d.filter((x) => x.kind !== 'text').length === 2, JSON.stringify(d))

  const e = splitFaceMarkers('')
  check('空字符串安全', Array.isArray(e) && e.length >= 1)
}

// ── 5. 收藏表情 / 表情包的识别 ────────────────────────────────
console.log('\n=== 5. 收藏表情识别（NapCat 把它编码成 image 段）===')
{
  const { parseMessage } = await imp('src/qq/onebot.js')

  // ⚠️ 这是 NapCat 的 marketFaceElement 实际输出结构：
  //    type 是 image（不是 mface！），但多带 emoji_id / key / summary
  const market = {
    type: 'image',
    data: {
      summary: '猫猫震惊',
      file: 'ab-abcd.gif',
      url: 'https://gxh.vip.qq.com/club/item/parcel/item/ab/abcdef/raw300.gif',
      key: 'k',
      emoji_id: 'abcdef',
      emoji_package_id: 12345,
    },
  }
  const r1 = parseMessage([{ type: 'text', data: { text: '看 ' } }, market])
  check('收藏表情标成 [表情包:名字]', r1.text.includes('[表情包:猫猫震惊]'), r1.text)
  check('收藏表情仍当图片收录', r1.images.length === 1, JSON.stringify(r1.images))

  // 普通图片不能被误判成表情
  const plain = { type: 'image', data: { file: 'a.jpg', url: 'https://x/a.jpg', file_size: 1234 } }
  const r2 = parseMessage([{ type: 'text', data: { text: '看 ' } }, plain])
  check('普通图片仍是 [图片]', r2.text.includes('[图片]') && !r2.text.includes('表情包'), r2.text)

  // 标准 mface 段（别的实现可能发这个）
  const mface = { type: 'mface', data: { emoji_package_id: 1, emoji_id: 'e1', key: 'k', summary: '狗头' } }
  const r3 = parseMessage([{ type: 'mface', data: mface.data }])
  check('标准 mface 段也识别', r3.text.includes('[表情包:狗头]'), r3.text)

  // 只有 emoji_id、没有 summary → 仍标记为表情包，只是没名字
  const r4 = parseMessage([{ type: 'image', data: { emoji_id: 'xyz', url: 'http://x/a.gif' } }])
  check('缺 summary 时退化为 [表情包]', r4.text.includes('[表情包]'), r4.text)

  // CQ 码形式也要一致
  const r5 = parseMessage('[CQ:image,emoji_id=abc,summary=%E7%8C%AB,url=http://x/a.gif]')
  check('CQ 码形式的收藏表情', r5.text.includes('[表情包'), r5.text)
}

// ── 6. 往上送历史时，messages 必须符合 dsh-llm 契约 ────────────
//
// ⚠️ 两个曾经导致**全渠道失败**的坑（都在这一个函数里）：
//    ① system 的 content 用裸字符串 → 带图时抛 "content.some is not a function"
//    ② assistant 消息没有 source  → 多轮对话时抛 "reading 'replayState'"
//       症状极具迷惑性：只在**历史里有自己的回复**时崩，单条消息测不出来。
console.log('\n=== 6. messages 契约（这函数踩过两个"全渠道失败"的坑）===')
{
  const { buildChatMessages } = await imp('src/qq/bridge.js')
  const { makeMessage } = await imp('src/memory/short.js')

  const history = [
    makeMessage({ sender: '111', senderName: '甲', text: '在吗', at: Date.now() - 5000 }),
    makeMessage({
      sender: '999', senderName: 'Bot', text: '在的', at: Date.now() - 3000,
      isMe: true, provider: 'buddy', model: 'hy4-preview',
    }),
    makeMessage({ sender: '111', senderName: '甲', text: '帮我看个东西', at: Date.now() - 1000 }),
  ]

  const msgs = buildChatMessages({ system: 'SYSTEM', history, lastRoute: { provider: 'x', model: 'y' } })

  // ① system：必须是数组块，不能是字符串
  const sys = msgs.find((m) => m.role === 'system')
  check('system.content 是数组（不是字符串）', Array.isArray(sys.content), typeof sys.content)
  check('system 能安全调 .some()（上游就这么判图片）',
    (() => { try { return sys.content.some((b) => b.type === 'image') === false } catch { return false } })(),
    JSON.stringify(sys.content))

  // ② assistant：必须带 source，否则 forAdapter() 读 source.replayState 会抛
  const asst = msgs.filter((m) => m.role === 'assistant')
  check('有 assistant 消息（历史里有自己的回复）', asst.length === 1, String(asst.length))
  check('assistant.source 存在（否则 replayState 抛错）', Boolean(asst[0]?.source), JSON.stringify(asst[0]))
  check('source 含 kind/provider/model',
    asst[0]?.source?.kind === 'model' && Boolean(asst[0]?.source?.provider) && Boolean(asst[0]?.source?.model),
    JSON.stringify(asst[0]?.source))
  check('source 读取不抛错（模拟上游 forAdapter）',
    (() => { try { return asst[0].source.replayState === undefined } catch { return false } })())
  check('provider/model 来自那条记忆（buddy/hy4-preview）',
    asst[0].source.provider === 'buddy' && asst[0].source.model === 'hy4-preview',
    JSON.stringify(asst[0].source))

  // 没有 provider 的旧记忆 → 用 lastRoute 兜底，仍不能是 undefined
  const legacy = buildChatMessages({
    system: 'S',
    history: [makeMessage({ sender: '999', senderName: 'B', text: '旧回复', isMe: true })],
    lastRoute: { provider: 'p1', model: 'm1' },
  })
  const a2 = legacy.filter((m) => m.role === 'assistant')[0]
  check('旧记忆（无 provider）用 lastRoute 兜底', a2?.source?.provider === 'p1', JSON.stringify(a2?.source))

  // 连 lastRoute 都没有 → 占位值，依然不能 undefined
  const bare = buildChatMessages({
    system: 'S',
    history: [makeMessage({ sender: '999', senderName: 'B', text: 'x', isMe: true })],
  })
  const a3 = bare.filter((m) => m.role === 'assistant')[0]
  check('全都没有时给占位值（仍非 undefined）', Boolean(a3?.source?.provider), JSON.stringify(a3?.source))

  // user 消息保持原样
  check('user 消息不带 source（上游不读）',
    msgs.filter((m) => m.role === 'user').every((m) => m.source === undefined))
}

// ── 6b. 媒体标记要被改写成"行为说明"，不能诱导模型去描述图 ──────
//
// ⚠️ 实测：直接喂 `[表情包:猫猫]` 给模型，它会回
//    「这猫是被吓到了还是被丑到了」—— 真人不会这么说话。
//    所以要换成明确的指令式说明。
console.log('\n=== 6b. 媒体标记的改写（别让模型去解说图）===')
{
  const { buildChatMessages, describeMedia } = await imp('src/qq/bridge.js')
  const { makeMessage } = await imp('src/memory/short.js')

  check('表情包 → 说明式文字 + 行为指引', describeMedia({ text: '[表情包:猫猫]' }).includes('（对方发了一个表情包，关于「猫猫」') && describeMedia({ text: '[表情包:猫猫]' }).includes('别去猜图里画的是谁'),
    describeMedia({ text: '[表情包:猫猫]' }))
  check('无名表情包也说明 + 行为指引', describeMedia({ text: '[表情包]' }).includes('（对方发了一个表情包') && describeMedia({ text: '[表情包]' }).includes('别去猜图里画的是谁'))
  check('内置表情 → 带 id 的说明', describeMedia({ text: '[表情:4]' }).includes('（对方发了个QQ表情，id=4）'))
  check('图片 → 说明式', describeMedia({ text: '[图片]' }).includes('（对方发了一张图）'))
  check('普通文本不动', describeMedia({ text: '今天天气不错' }) === '今天天气不错')
  check('混排也能改', describeMedia({ text: '看这个[表情包:笑]哈哈' }).includes('（对方发了一个表情包，关于「笑」'))

  // 通过 buildChatMessages 走一遍，确认送给模型的确实是改写后的
  const m = buildChatMessages({
    system: 'S',
    history: [makeMessage({ sender: '1', senderName: '甲', text: '[表情包:猫猫]', at: Date.now() })],
  })
  const body = m.find((x) => x.role === 'user').content[0].text
  check('送模型的是改写后的文本（不再有 [表情包:…] 字面量）',
    !body.includes('[表情包') && body.includes('（对方发了一个表情包'), body)

  // 记忆里存的仍是原标记（否则界面/日志看不懂）
  const raw = makeMessage({ sender: '1', text: '[表情包:猫猫]', at: Date.now() })
  check('记忆里保留原标记', raw.text === '[表情包:猫猫]', raw.text)
}

// ── 6c. _generate 整条路径能跑通（抓"变量名写错"这类低级错）──────
//
// ⚠️ 踩过的坑：给 mediaHint 那段写成了 `cfg.reply?.mediaHint`
//    （应该是 `this.cfg.reply`），于是**每次带图的消息都生成失败**，
//    报 "cfg is not defined"。而单测 buildChatMessages 抓不到 ——
//    它只测了构造 messages，没走 _generate 的完整流程。
//
//    所以这里真的把 _generate 跑一遍（用假的 gateway，不打网络），
//    任何 ReferenceError 都会当场暴露。
console.log('\n=== 6c. _generate 能跑通（带媒体标记的场景）===')
{
  const { QQBridge } = await imp('src/qq/bridge.js')
  const { makeMessage } = await imp('src/memory/short.js')

  const CASES = [
    ['纯文字', '今天天气不错'],
    ['表情包', '[表情包:猫猫]'],
    ['系统表情', '[表情:4]'],
    ['图片', '[图片]'],
    ['图 + 文字', '[图片] 这是啥'],
  ]

  for (const [label, text] of CASES) {
    const history = [makeMessage({ sender: '2', senderName: '乙', text, at: Date.now() })]
    const fakeGateway = {
      providers: ['fake'],
      catalog: [{ provider: 'fake', id: 'm1' }],
      defaultModels: () => ({}),
      makeImageBlock: async () => null,
      refreshCatalog: async () => [{ provider: 'fake', id: 'm1' }],
      // 真的被调用一次，确认请求组装没问题
      stream: async function* () { yield { type: 'text-delta', text: '好的' } },
    }
    const br = new QQBridge({
      cfg: { model: 'auto', freeOrder: ['fake'], disabledProviders: [], maxTokens: 0, search: { enabled: false }, reply: {} },
      onebot: { call: async () => ({ data: {} }), fetchImage: async () => null, connected: true },
      gateway: fakeGateway,
      decision: {}, memory: {}, persona: { buildSystemPrompt: () => 'SYS' },
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    })
    br.memory = {
      get: () => ({
        push: () => {}, tick: () => {}, recent: () => history,
        sinceMyLast: () => 99999, consecutiveTurns: 0, toDecisionInput: () => ({}),
      }),
    }
    let err = null
    try {
      const out = await br._generate(
        { scope: 'group:1', kind: 'group', groupId: '1', userId: '2', text, images: [], at: Date.now() },
        br.memory.get(), { kind: 'group', groupId: '1', groupName: '测试群' },
        { qq: '9', nickname: 'Bot' },
      )
      // ⚠️ 2026-10-25 修：_generate 现在返回 `{ text, cover }` 而不是纯字符串。
      //
      // 为什么改成对象：封面图必须**随返回值带出去**，不能挂 this 上 ——
      // 用实例变量会有竞态（_generate 到 _send 之间隔了几百行，
      // 群里并发时后一条搜到的图可能被前一条取走，张冠李戴）。
      //
      // 这里断言形状正确 + text 是字符串。
      if (!out || typeof out !== 'object') {
        err = '没返回对象：' + typeof out
      } else if (typeof out.text !== 'string') {
        err = 'out.text 不是字符串：' + typeof out.text
      }
    } catch (e) {
      err = String(e?.message ?? e)
    }
    check(`_generate 跑通（${label}）`, err === null, err || '')
  }
}

// ── 7. 残缺表情标记的修补 ────────────────────────────────────
//
// ⚠️ 实测：群里收到过「[表情:」这串字面文本 —— 生成被截断在标记中间，
//    残缺标记不匹配发送时的正则，就被当普通文本发出去了。
console.log('\n=== 7. 残缺表情标记修补 ===')
{
  const { repairTruncatedMarkers, cleanModelText, splitFaceMarkers } = await imp('src/qq/bridge.js')

  check('完整标记不动', repairTruncatedMarkers('[表情:4]') === '[表情:4]')
  check('缺右括号 → 补全', repairTruncatedMarkers('[表情:4') === '[表情:4]')
  check('只有前缀 → 删掉', repairTruncatedMarkers('[表情:') === '', JSON.stringify(repairTruncatedMarkers('[表情:')))
  check('全角冒号也能补', repairTruncatedMarkers('[表情：4') === '[表情:4]')
  check('表情包缺括号 → 补全', repairTruncatedMarkers('[表情包:猫猫') === '[表情包:猫猫]')
  check('表情包只有前缀 → 删掉', repairTruncatedMarkers('[表情包:') === '')
  check('前面有文字也补', repairTruncatedMarkers('好的[表情:4') === '好的[表情:4]')
  check('孤立的半开括号清掉', repairTruncatedMarkers('好的[') === '好的')
  check('非数字 id 不动（保持原样）', repairTruncatedMarkers('[表情:abc]') === '[表情:abc]')
  check('普通文本不动', repairTruncatedMarkers('今天天气不错') === '今天天气不错')

  // 端到端：残缺标记绝不能被当成文本发出去
  const bad = cleanModelText('[表情:')
  check('cleanModelText 后残缺标记不残留', bad === '', JSON.stringify(bad))
  const good = cleanModelText('[表情:4')
  check('cleanModelText 能把它修成可用标记',
    splitFaceMarkers(good).some((p) => p.kind === 'face' && p.id === '4'), JSON.stringify(good))
}

// ── 8. 表情包挑选（收藏表情 / 兜底）──────────────────────────
console.log('\n=== 8. 表情包挑选 ===')
{
  const { QQBridge } = await imp('src/qq/bridge.js')

  const mk = (faces) => new QQBridge({
    cfg: { reply: {} },
    onebot: { call: async (a) => (a === 'fetch_custom_face' ? { data: faces } : { data: {} }) },
    gateway: {}, decision: {}, memory: {}, persona: {},
    log: { info: () => {}, warn: () => {}, debug: () => {} },
  })

  // 有收藏表情 → 发 image 段（NapCat 的 fetch_custom_face 给的是可下载 URL）
  const faces = ['https://x/a.gif', 'https://x/b.gif', 'https://x/c.gif']
  const br = mk(faces)
  const got = await br._customFaces()
  check('能取到收藏表情列表', got.length === 3, JSON.stringify(got))

  const pick = await br._pickMface('猫猫')
  check('表情包 → image 段', pick?.[0]?.type === 'image', JSON.stringify(pick))
  check('用的是收藏表情的 URL', faces.includes(pick?.[0]?.data?.file), JSON.stringify(pick))

  const again = await br._pickMface('猫猫')
  check('同一名字挑到同一张（确定性）', JSON.stringify(pick) === JSON.stringify(again))

  const noName = await br._pickMface('')
  check('没名字也能发（随机一张）', noName?.[0]?.type === 'image', JSON.stringify(noName))

  // 没有收藏表情 → 兜底小黄脸，**绝不返回 null**
  const br2 = mk([])
  const f1 = await br2._pickMface('笑')
  check('无收藏时兜底内置表情', f1?.[0]?.type === 'face', JSON.stringify(f1))
  // 现在「笑」走表情表解析（比原来硬编码的 4=得意 更贴切），
  // 关键是**是个有效的 face id**，而不是具体某一个数字
  check('「笑」解析成合法 face id',
    f1?.[0]?.type === 'face' && Number(f1[0].data.id) >= 0 && Number(f1[0].data.id) <= 104,
    JSON.stringify(f1))
  const f2 = await br2._pickMface('莫名其妙')
  check('名字对不上也有兜底（不返回 null）', Array.isArray(f2) && f2.length > 0, JSON.stringify(f2))
  const f3 = await br2._pickMface('')
  check('空名字也有兜底', Array.isArray(f3) && f3.length > 0, JSON.stringify(f3))

  // 配置映射优先于收藏表情
  const br3 = new QQBridge({
    cfg: { reply: { mfaceMap: { 猫猫: 'https://fixed/cat.gif' } } },
    onebot: { call: async () => ({ data: faces }) },
    gateway: {}, decision: {}, memory: {}, persona: {},
    log: { info: () => {}, warn: () => {}, debug: () => {} },
  })
  const mapped = await br3._pickMface('猫猫')
  check('配置映射优先', mapped?.[0]?.data?.file === 'https://fixed/cat.gif', JSON.stringify(mapped))
}

console.log('\n=== 9. 表情名查找（本地"搜索" QQ 表情库）===')
{
  const { lookupFace, faceTableSize } = await imp('src/qq/bridge.js')

  check('表情表已加载', faceTableSize() > 150, String(faceTableSize()))

  // 精确命中：名字和官方 id 都要对
  const EXACT = [
    ['微笑', 0], ['撇嘴', 1], ['色', 2], ['发呆', 3], ['得意', 4],
    ['流泪', 5], ['害羞', 6], ['睡', 8], ['大哭', 9], ['尴尬', 10],
    ['发怒', 11], ['调皮', 12], ['呲牙', 13], ['惊讶', 14], ['难过', 15],
    ['酷', 16], ['抓狂', 18], ['吐', 19], ['偷笑', 20], ['可爱', 21],
    ['白眼', 22], ['困', 25], ['惊恐', 26], ['憨笑', 28], ['奋斗', 30],
    ['疑问', 32], ['嘘', 33], ['晕', 34], ['衰', 36], ['骷髅', 37],
    ['敲打', 38], ['再见', 39], ['擦汗', 40], ['抠鼻', 41], ['鼓掌', 42],
    ['坏笑', 44], ['哈欠', 47], ['鄙视', 48], ['委屈', 49], ['可怜', 54],
    ['菜刀', 55], ['玫瑰', 63], ['爱心', 66], ['炸弹', 70], ['太阳', 76],
    ['礼物', 77], ['拥抱', 78], ['强', 79], ['握手', 81], ['胜利', 82],
  ]
  let okN = 0
  const bad = []
  for (const [name, want] of EXACT) {
    const r = lookupFace(name)
    if (r && r.kind === 'face' && r.id === want) okN++
    else bad.push(`${name}: ${JSON.stringify(r)} ≠ ${want}`)
  }
  check(`官方 id 全对（${okN}/${EXACT.length}）`, okN === EXACT.length, bad.join('; '))

  // ⚠️ 关键回归：face id 必须在 0~104 区间。
  //    曾经把「大笑」按 EMCode-100 算成 163（错），那是因为
  //    QQ 的 EMCode 编号体系对商城表情不适用。
  const overRange = EXACT.map(([n]) => lookupFace(n))
    .filter((r) => r && r.kind === 'face' && (r.id < 0 || r.id > 104))
  check('所有 face id 都在合法区间 0~104', overRange.length === 0, JSON.stringify(overRange))

  // 模糊匹配
  check('模糊：「笑」→ 某个笑类表情', (() => {
    const r = lookupFace('笑')
    return r && r.kind === 'face'
  })())
  check('模糊：「超级大笑」能剥掉修饰词', Boolean(lookupFace('超级大笑')))

  // 口语别名
  check('别名：大笑 → 有经典脸可发', (() => {
    const r = lookupFace('大笑')
    return r && r.kind === 'face' && r.id >= 0 && r.id <= 104
  })(), JSON.stringify(lookupFace('大笑')))
  check('别名：赞 → 强(79)', lookupFace('赞')?.id === 79, JSON.stringify(lookupFace('赞')))
  check('别名：无语 → 擦汗(40)', lookupFace('无语')?.id === 40, JSON.stringify(lookupFace('无语')))

  // 查不到就返回 null（交给上层兜底，不要瞎猜一个错表情）
  check('查不到 → null', lookupFace('完全不存在的词xyz') === null)
  check('空字符串 → null', lookupFace('') === null)
  check('undefined → null', lookupFace(undefined) === null)
}

console.log('\n' + '='.repeat(46))
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)