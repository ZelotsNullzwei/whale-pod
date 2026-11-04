/**
 * `[改标签:…]` —— 她唯一能**真的**改表情标签的通道（2026-11-04）。
 *
 * ## 现场
 * 私聊里用户指出「这个标签打错了，是嫌弃不是震惊」，她连着回了两句
 * 「改了改了」「标签改完了」，但 `sticker-tags.json` 的 mtime 停在 15:17 ——
 * **一个字都没动**。因为当时 `stickerTags.set()` 全项目只有自动打标签一处调用，
 * 她的回复里没有任何东西能触发它。
 *
 * ## 这条测试守什么
 * ① 标记能认出来、能从正文里剥干净（不能把 `[改标签:…]` 发到聊天里）
 * ② 目标找得准：靠图片 md5 命中库里的那条，不靠猜
 * ③ 私聊可以回退到"她刚发出去那张"，群聊**不许**
 * ④ set 之后 get 真的变了
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { extractTagMarkers, stripTagMarkers, QQBridge } from '../src/qq/bridge.js'
import { StickerTagStore } from '../src/qq/sticker-tags.js'

let pass = 0
let fail = 0
async function ok(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

console.log('=== 1. 标记的认与剥 ===')
await ok('认出 `[改标签:嫌弃,厌恶]`', () => {
  assert.deepEqual(extractTagMarkers('改了[改标签:嫌弃,厌恶]'), ['嫌弃,厌恶'])
})

await ok('全角括号 + 全角冒号也认', () => {
  assert.deepEqual(extractTagMarkers('［改标签：无语］'), ['无语'])
})

await ok('一条里有多个标记 → 都取出来', () => {
  assert.equal(extractTagMarkers('[改标签:a][改标签:b]').length, 2)
})

await ok('没有标记 → 空数组', () => {
  assert.deepEqual(extractTagMarkers('今天天气不错'), [])
})

await ok('剥干净：正文里一个字都不剩', () => {
  assert.equal(stripTagMarkers('改了改了 [改标签:嫌弃] 这下对了吧'), '改了改了  这下对了吧'.replace(/\s+/g, ' ').trim())
})

await ok('剥完不会留下 `[改标签` 残渣', () => {
  assert.equal(stripTagMarkers('[改标签:嫌弃]').includes('改标签'), false)
})

console.log('=== 2. 按 md5 精确命中（不靠猜） ===')
const BYTES = Buffer.from('fake-sticker-bytes-for-md5-test')
const HASH = createHash('md5').update(BYTES).digest('hex').toUpperCase()
const LIB_URL = `https://p.qpic.cn/qq_expression/1/1_0_0_0_${HASH}_0_0/0`
const DATA_URL = `data:image/png;base64,${BYTES.toString('base64')}`

await ok('findUrlByHash 命中（大小写都行）', () => {
  const store = new StickerTagStore({})
  store.set(LIB_URL, ['震惊'])
  assert.equal(store.findUrlByHash(HASH), LIB_URL)
  assert.equal(store.findUrlByHash(HASH.toLowerCase()), LIB_URL)
})

await ok('不是 32 位十六进制的输入 → null（不瞎扫）', () => {
  const store = new StickerTagStore({})
  store.set(LIB_URL, ['震惊'])
  assert.equal(store.findUrlByHash(''), null)
  assert.equal(store.findUrlByHash('abc'), null)
  assert.equal(store.findUrlByHash('Z'.repeat(32)), null)
})

console.log('=== 3. 目标选择：谁能改、谁不能改 ===')
const mkStore = () => {
  const s = new StickerTagStore({})
  s.set(LIB_URL, ['震惊', '崩溃'])
  return s
}

await ok('对方这条里带了那张表情 → 精确改它', async () => {
  const stickerTags = mkStore()
  const r = await QQBridge.prototype._tagTarget.call({
    cfg: {}, stickerTags,
    onebot: { fetchImage: async () => ({ dataUrl: DATA_URL }) },
  }, { scope: 'private:1', stickerRefs: ['https://multimedia.nt.qq.com.cn/x'] })
  assert.equal(r?.url, LIB_URL)
  assert.match(r.why, /对方这条/)
})

await ok('★ 群聊：没带表情时**不许**回退到"她刚发出去那张"', async () => {
  const stickerTags = mkStore()
  const r = await QQBridge.prototype._tagTarget.call({
    cfg: {}, stickerTags,
    _lastMface: { scope: 'group:9', url: LIB_URL, at: Date.now() },
    onebot: { fetchImage: async () => null },
  }, { scope: 'group:9' })
  assert.equal(r, null, '群聊不该顺手改自己的库')
})

await ok('★ 私聊：可以回退到"她刚发出去那张"（10 分钟内）', async () => {
  const stickerTags = mkStore()
  const r = await QQBridge.prototype._tagTarget.call({
    cfg: {}, stickerTags,
    _lastMface: { scope: 'private:1', url: LIB_URL, at: Date.now() - 60_000 },
    onebot: { fetchImage: async () => null },
  }, { scope: 'private:1' })
  assert.equal(r?.url, LIB_URL)
  assert.match(r.why, /刚发出去/)
})

await ok('私聊：超过 10 分钟就不认了（防止改到很久以前那张）', async () => {
  const stickerTags = mkStore()
  const r = await QQBridge.prototype._tagTarget.call({
    cfg: {}, stickerTags,
    _lastMface: { scope: 'private:1', url: LIB_URL, at: Date.now() - 11 * 60_000 },
    onebot: { fetchImage: async () => null },
  }, { scope: 'private:1' })
  assert.equal(r, null)
})

await ok('跨会话的 _lastMface 不串（私聊 A 的不给私聊 B）', async () => {
  const stickerTags = mkStore()
  const r = await QQBridge.prototype._tagTarget.call({
    cfg: {}, stickerTags,
    _lastMface: { scope: 'private:1', url: LIB_URL, at: Date.now() },
    onebot: { fetchImage: async () => null },
  }, { scope: 'private:2' })
  assert.equal(r, null)
})

console.log('=== 4. 改完真的变了 ===')
await ok('set 之后 get 返回新标签', () => {
  const s = mkStore()
  assert.deepEqual(s.get(LIB_URL), ['震惊', '崩溃'])
  s.set(LIB_URL, ['嫌弃', '厌恶'])
  assert.deepEqual(s.get(LIB_URL), ['嫌弃', '厌恶'])
})

await ok('垃圾标签过不了 isCleanTag（不会把提示词写进库）', () => {
  const s = mkStore()
  const changed = s.set(LIB_URL, ['分析用户请求：可能是动画的一帧'])
  assert.equal(changed, false)
  assert.deepEqual(s.get(LIB_URL), ['震惊', '崩溃'])
})

console.log('=== 5. 说了做了、其实没做（谎报闸）===')
const claim = (text, did = {}) => QQBridge.prototype._falseClaim.call({}, text, did)

await ok('★ 现场原话：「改了改了，现在是嫌弃」+ 没有任何动作 → 抓住', () => {
  const r = claim('（那标签本来就是我贴错的，改还用你说。）改了改了，现在是嫌弃，不是震惊。')
  assert.ok(r, '这句必须被抓')
  assert.equal(r.kind, 'tag')
})

await ok('真改了（有 [改标签] 动作）→ 放过', () => {
  assert.equal(claim('改了改了，现在是嫌弃', { tag: true }), null)
})

await ok('「标签改完了，这下总对了吧」+ 没动作 → 抓住', () => {
  assert.ok(claim('标签改完了，这下总对了吧。'))
})

await ok('否定句放过：标签没改好 / 改不了', () => {
  assert.equal(claim('标签没改好，等等'), null)
  assert.equal(claim('这标签改不了'), null)
})

await ok('疑问句放过：改好了吗？', () => {
  assert.equal(claim('改好了吗'), null)
})

await ok('其他三类也查：禁言 / 改名 / 找图', () => {
  assert.ok(claim('已经禁言他了'))
  assert.equal(claim('已经禁言他了', { ban: true }), null)
  assert.ok(claim('名字改好了'))
  assert.ok(claim('给你找了张图'))
  assert.equal(claim('给你找了张图', { image: true }), null)
})

await ok('正常话不误伤：「这标签挺合适」「改天再说」', () => {
  assert.equal(claim('这标签挺合适的'), null)
  assert.equal(claim('改天再说吧'), null)
  assert.equal(claim('我先看看 那个标签是什么意思'), null)
})

/*
 * ★ 签名的**跨句**谎报（2026-11-04 20:xx）。
 *
 * 现场（19:43:32~44）：
 * ```
 * 他「你看看现在能自己改签名和其他的了吗」
 * 她「（手搭上去动了一下）改了，」    ← 这轮根本没提"签名"两个字
 * ```
 * 同一句规则漏掉它，所以靠"对方这一轮问的是签名"（第三参数 ctx）来认。
 */
console.log('\n=== 6. 签名跨句谎报 ===')
const claimCtx = (text, did, ctx) => QQBridge.prototype._falseClaim.call({}, text, did, ctx)

await ok('★ 对方问签名 + 她只说「改了」+ 没动作 → 抓住', () => {
  const r = claimCtx('（手搭上去动了一下）改了，', {}, '你看看现在能自己改签名和其他的了吗')
  assert.ok(r)
  assert.equal(r.kind, 'signature')
})

await ok('对方没提签名 → 同一句「改了」不误伤（她可能在说别的事）', () => {
  assert.equal(claimCtx('改了，', {}, '今天吃什么'), null)
})

await ok('「我改了主意」不算（skip 词挡住）', () => {
  assert.equal(claimCtx('我改了主意，明天再说', {}, '签名还能改吗'), null)
})

await ok('真改了签名（有 [签名:…]）→ 放过', () => {
  assert.equal(claimCtx('改了，', { signature: true }, '你现在能改签名了吗'), null)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)