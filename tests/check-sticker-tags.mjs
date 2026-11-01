/**
 * 收藏表情的**标签库**（2026-10-31）。
 *
 * ## 为什么需要
 * `fetch_custom_face` 只返回一组 URL —— 没有名字、没有描述。
 * 所以机器人发表情是**闭着眼睛随机甩**：不知道自己有什么、也不知道
 * 挑中的那张是什么。实测事故：对方发表情包 → 她回了个"流泪" → 人家问「哭啥」。
 *
 * ## 做法（参考麦麦 MaiBot 的 `emoji_content_analysis`）
 * 用视觉模型给每张图打「情绪/语气/场景」标签（≤5 个），存 `sticker-tags.json`。
 * 打标签是**批处理**：现在打一批，之后攒够 `minPending` 张再打下一批（用户要求）。
 *
 * ## key 用「URL 去掉 query」
 * QQ 图片地址带时效签名（`?term=...&spec=...`），query 会变、path 不变。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StickerTagStore, stickerKey, splitTags, isCleanTag } from '../src/qq/sticker-tags.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`) } catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}\n`) }
}

const mkStore = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stk-'))
  return { home, store: new StickerTagStore({ home }) }
}

console.log('=== key 与标签解析 ===')

ok('★ stickerKey 去掉 query/hash（签名会变、path 不变）', () => {
  assert.equal(stickerKey('https://gchat.qpic.cn/x/abc.gif?term=2&spec=1'), 'https://gchat.qpic.cn/x/abc.gif')
  assert.equal(stickerKey('https://a/b.gif#frag'), 'https://a/b.gif')
  assert.equal(stickerKey(''), '')
})

ok('splitTags 容忍中英文逗号 / 顿号 / 分号 / 换行', () => {
  assert.deepEqual(splitTags('哭，委屈、无语;得意\n开心'), ['哭', '委屈', '无语', '得意', '开心'])
})

ok('splitTags 最多 5 个 + 丢掉过长的（多半是解释不是标签）', () => {
  const t = splitTags('一,二,三,四,五,六,七')
  assert.equal(t.length, 5)
  const long = splitTags('这是一个非常非常长的解释句子不应该被当成标签,哭')
  assert.deepEqual(long, ['哭'])
})

console.log('\n=== 存取 ===')

ok('★ 存进去能读回来，**带不同的签名也能命中**（靠 path）', () => {
  const { home, store } = mkStore()
  try {
    store.set('https://a/1.gif?term=1', '哭,委屈')
    assert.deepEqual(store.get('https://a/1.gif?term=999'), ['哭', '委屈'], '签名变了也要命中')
    assert.equal(store.get('https://a/2.gif'), null, '没存过的返回 null')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

ok('落盘后新实例能恢复', () => {
  const { home, store } = mkStore()
  try {
    store.set('https://a/1.gif', '笑')
    const s2 = new StickerTagStore({ home })
    assert.deepEqual(s2.get('https://a/1.gif'), ['笑'])
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

ok('空标签不写（不许把空字符串当标签）', () => {
  const { home, store } = mkStore()
  try {
    assert.equal(store.set('https://a/1.gif', ''), false)
    assert.equal(store.get('https://a/1.gif'), null)
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

console.log('\n=== 按标签挑（这就是"按意思发"）===')
/*
 * 事故对照：以前 `_pickMface` 是 `hashStr(名字) % 收藏数` ——
 * 同一个名字固定挑同一张，但**那张和名字毫无关系**，等于闭眼。
 */

ok('★ findByTag 精确命中', () => {
  const { home, store } = mkStore()
  try {
    store.set('https://a/1.gif', '哭,委屈')
    store.set('https://a/2.gif', '笑')
    const urls = ['https://a/1.gif', 'https://a/2.gif']
    assert.equal(store.findByTag(urls, '哭'), 'https://a/1.gif')
    assert.equal(store.findByTag(urls, '笑'), 'https://a/2.gif')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

ok('★ findByTag 模糊命中（「哭」→「大哭」；「想笑」→「笑」）', () => {
  const { home, store } = mkStore()
  try {
    store.set('https://a/1.gif', '大哭')
    store.set('https://a/2.gif', '笑')
    assert.equal(store.findByTag(['https://a/1.gif'], '哭'), 'https://a/1.gif', '标签包含请求词')
    assert.equal(store.findByTag(['https://a/2.gif'], '想笑'), 'https://a/2.gif', '请求词包含标签')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

ok('findByTag 找不到返回 null（→ 调用方退回老逻辑，不是乱发）', () => {
  const { home, store } = mkStore()
  try {
    store.set('https://a/1.gif', '哭')
    assert.equal(store.findByTag(['https://a/1.gif'], '暴怒'), null)
    assert.equal(store.findByTag([], '哭'), null)
    assert.equal(store.findByTag(['https://a/1.gif'], ''), null)
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

console.log('\n=== 注入提示词 ===')

ok('★ toPrompt 列出收藏的标签（让模型知道能写 `[表情包:哭]`）', () => {
  const { home, store } = mkStore()
  try {
    store.set('https://a/1.gif', '哭,委屈')
    store.set('https://a/2.gif', '笑')
    const p = store.toPrompt(['https://a/1.gif', 'https://a/2.gif'])
    assert.match(p, /你收藏的表情/)
    assert.match(p, /哭、委屈/)
    assert.match(p, /\[表情包:/, '要告诉它怎么写')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

ok('★ toPrompt 只列**还在收藏里**的（URL 列表核对过）', () => {
  const { home, store } = mkStore()
  try {
    store.set('https://a/1.gif', '哭')
    store.set('https://a/2.gif', '笑')
    // a/2 已经被用户删了
    const p = store.toPrompt(['https://a/1.gif'])
    assert.match(p, /哭/)
    assert.ok(!/笑/.test(p), '已删掉的表情不该列出来')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

ok('toPrompt 一张有标签的都没有 → 空串（别硬编）', () => {
  const { home, store } = mkStore()
  try {
    assert.equal(store.toPrompt(['https://a/1.gif']), '')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

console.log('\n=== 源码锁 ===')

ok('⚠️ 源码锁：`_pickMface` 必须先按标签挑，再退回 hash', () => {
  const SRC = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  const at = code.indexOf('async _pickMface(')
  assert.ok(at > 0, '要有 _pickMface')
  const seg = code.slice(at, at + 3000)
  assert.match(seg, /stickerTags\?\.findByTag/, '要按标签找')
  // 标签命中必须**在** hash 兜底之前
  const atTag = seg.indexOf('findByTag')
  const atHash = seg.indexOf('hashStr')
  assert.ok(atTag > 0 && atHash > atTag, '标签匹配要排在 hash 兜底前面')
})

ok('⚠️ 源码锁：打标签是**批处理**（攒够 minPending 才动手）', () => {
  const SRC = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  const at = code.indexOf('async _tagStickerBatch(')
  assert.ok(at > 0, '要有 _tagStickerBatch')
  const seg = code.slice(at, at + 1500)
  assert.match(seg, /minPending/, '要有"攒够才打"的参数')
  assert.match(seg, /todo\.length < minPending/, '★ 没攒够就直接返回')
  assert.match(seg, /_taggingBusy/, '要有并发锁，别叠着跑')
})

ok('⚠️ 源码锁：打标签必须跳过 `reasoning-delta`（草稿不是答案）', () => {
  /*
   * ⚠️ **同一个坑踩了第二次**（2026-10-31）：
   *
   * `reasoning-delta` 这个 chunk **也有 `.text`**。只写
   * `if (typeof chunk?.text === 'string') text += chunk.text`
   * 会把推理草稿拼进来 —— 实测存进标签库的是：
   * 「分析用户请求**：、可能是动画的一帧）、语气或常见使用场景标签…」
   *
   * `index.js:841` 早在 2026-10-28 就为日程生成修过一模一样的 bug，
   * 注释里写着「**草稿不是答案**」。这次 `_callVisionTags` 没照抄。
   */
  const SRC = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  const at = SRC.indexOf('async _callVisionTags(')
  assert.ok(at > 0, '要有 _callVisionTags')
  const seg = SRC.slice(at, at + 2600)
  assert.match(
    seg,
    /kind === 'reasoning-delta' \|\| kind === 'reasoning'/,
    '★ 必须跳过 reasoning-delta / reasoning —— 否则标签会是推理草稿',
  )
})

ok('⚠️ 源码锁：`isCleanTag` 要挡住噪音与长句', () => {
  /*
   * 第二道防线。即使模型还是漏了草稿，`isCleanTag` 也要挡住：
   * · 含「分析/任务/限制/提取/输出…」这类元词
   * · 长于 6 个字（「哭」「无语」「阴阳怪气」都在 6 字内）
   * · 带 markdown / 标点残留
   */
  assert.equal(isCleanTag('哭'), true)
  assert.equal(isCleanTag('阴阳怪气'), true, '4 字可以')
  assert.equal(isCleanTag('分析用户请求'), false, '元词要挡')
  assert.equal(isCleanTag('提取主要表达的情绪'), false, '长句要挡')
  assert.equal(isCleanTag('**震惊**'), false, 'markdown 要挡')
  assert.equal(isCleanTag(''), false)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
