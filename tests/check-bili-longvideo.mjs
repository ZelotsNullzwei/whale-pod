/**
 * 长视频的「先回一句，看完再补」链路（2026-11-01）。
 *
 * ## 起因
 * 用户原话：**「视频内容还是看不见这种感觉，还是在读评论和弹幕」**
 * （同一句他在代码注释里已经说过一次，说明上一轮"加音频转写"没解决问题）。
 *
 * 实测查出来长视频有**两道门**，原来都没写出来：
 * ```
 * 26 分 46 秒那条：duration=1606s > 300s  ✗  （bridge 里的同步门槛）
 *                  音频 12.9MB > 12MB     ✗  （downloadAudio 的上限）
 * → 一条内容都拿不到，只能读评论/弹幕
 * ```
 *
 * 改法（用户提的设计）：**长视频先回一句，转写丢后台，完了再补一条**。
 *
 * 这个文件锁的是"不依赖网络"的那几层：
 *   · 前缀下载真的发了 `Range` 头，而且**只认 206**（回 200 = 整条下，要跳过换源）
 *   · 三种上下文形态（等后台 / 只听了开头 / 正常有转写）各自该说什么、不该说什么
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { downloadAudio, formatVideoContext } from '../src/qq/bilibili.js'

let pass = 0
let fail = 0
async function ok(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

/** 假的 fetch：记录每次请求的头，按剧本回状态码。 */
const stubFetch = (plan) => {
  const seen = []
  const impl = async (url, init = {}) => {
    seen.push({ url, headers: init.headers ?? {} })
    const step = plan[seen.length - 1] ?? plan[plan.length - 1] ?? { status: 206 }
    return {
      status: step.status ?? 206,
      ok: (step.status ?? 206) < 400,
      arrayBuffer: async () => Buffer.alloc(Number(step.bytes ?? 4096), 1),
    }
  }
  return { impl, seen }
}

const URLS = ['https://a.example/x.m4a', 'https://b.example/y.m4a']
const MB2 = 2 * 1024 * 1024

console.log('=== ① 前缀下载（长视频用）===')

await ok('prefixBytes → 发 Range 头，truncated=true', async () => {
  const { impl, seen } = stubFetch([{ status: 206 }])
  const r = await downloadAudio(URLS, { fetchImpl: impl, prefixBytes: MB2 })
  assert.equal(seen.length, 1, '只该请求第一个源')
  assert.equal(seen[0].headers.Range, `bytes=0-${MB2 - 1}`)
  assert.equal(r.truncated, true, 'truncated 必须为 true —— 调用方要据此如实告诉模型')
})

await ok('不带 prefixBytes → 不发 Range（原行为不能回归）', async () => {
  const { impl, seen } = stubFetch([{ status: 200 }])
  const r = await downloadAudio(URLS, { fetchImpl: impl })
  assert.equal('Range' in seen[0].headers, false, '普通下载不该带 Range 头')
  assert.equal(r.truncated, false)
})

await ok('源回 200（不认 Range）→ 跳过换下一个源，而不是悄悄下整条', async () => {
  const { impl, seen } = stubFetch([{ status: 200 }, { status: 206 }])
  const r = await downloadAudio(URLS, { fetchImpl: impl, prefixBytes: 1024 })
  assert.equal(seen.length, 2, '应该换到第二个源')
  assert.ok(r, '第二个源 206 应该成功')
  assert.equal(r.url, URLS[1])
})

await ok('所有源都不认 Range → 老实返回 null（别拿整条凑数）', async () => {
  const { impl } = stubFetch([{ status: 200 }, { status: 200 }])
  const r = await downloadAudio(URLS, { fetchImpl: impl, prefixBytes: 1024 })
  assert.equal(r, null)
})

console.log('\n=== ② 三种上下文形态 ===')

const base = {
  title: '谁是最适合当妈妈的AI？',
  owner: '牢大百科',
  duration: 1606,
  view: 48000,
  desc: '',
  comments: [{ like: 592, text: '我还没沦落到只给5个Ai娘当孩子的程度' }],
  danmaku: [{ count: 1196, text: '5' }],
}

const pending = formatVideoContext({ ...base, pendingLong: true })
const prefix = formatVideoContext({
  ...base,
  transcript: '今天老大请来了五位AI小姐，提前看看他们能把孩子养成什么样'.repeat(3),
  prefixOnly: true,
})
const full = formatVideoContext({
  ...base,
  duration: 230,
  transcript: '这是一段正常长度的转写内容，用来对比'.repeat(4),
})

await ok('长视频等后台时：说清"你还不知道里面讲了什么"，先应一声', () => {
  assert.match(pending, /刚开始听/, '要明确说它还没听到')
  assert.match(pending, /先应一声/)
  assert.match(pending, /别装作看过/)
})

await ok('等后台时：**不能**出现"你得说点具体的"那套（那会逼它硬凑内容）', () => {
  assert.ok(!pending.includes('你得说点具体的'),
    '那段是给"已经听到内容"写的，等后台时出现就会逼它拿标题/评论硬凑')
})

await ok('只听了开头：标题写明"开头"，并说清范围', () => {
  assert.match(prefix, /视频开头讲了什么/)
  assert.match(prefix, /只听了开头几分钟/)
  assert.ok(!prefix.includes('视频里说了什么'), '不能说成"视频里说了什么"（她没听全）')
})

await ok('短片正常转写：照旧叫"视频里说了什么" + 机器听写提醒', () => {
  assert.match(full, /视频里说了什么/)
  assert.match(full, /机器听写/)
  assert.ok(!full.includes('只听了开头'))
})

await ok('等后台时**不给**评论/弹幕 —— 给了它就会去念（用户要的是"先应一声"）', () => {
  assert.ok(!pending.includes('评论区怎么说'), '等后台时不该给评论区')
  assert.ok(!pending.includes('弹幕在刷什么'), '等后台时不该给弹幕')
  // 但标题/UP/时长这些元信息要在 —— 不然她连"这是啥视频"都不知道，没法应声
  assert.match(pending, /谁是最适合当妈妈的AI/, '标题不能少')
  assert.match(pending, /牢大百科/, 'UP 主不能少')
})

await ok('听完了（只听开头）之后才给评论/弹幕', () => {
  for (const [n, t] of [['只听开头', prefix], ['短片', full]]) {
    assert.match(t, /评论区怎么说/, `${n} 少了评论区`)
    assert.match(t, /弹幕在刷什么/, `${n} 少了弹幕`)
  }
})

await ok('长视频（1606s）走 pending 分支而不是"没内容"分支', () => {
  // 回归：原来 >300s 就是"什么都不做"，现在必须变成"等后台"
  const t = formatVideoContext({ ...base, pendingLong: true })
  assert.ok(!t.includes('没看过这个视频本身'),
    '那句是"彻底看不到内容"的兜底文案，等后台时不该出现（她马上就会看到）')
})

await ok('补发必须从 gen.text 取文本（_generate 返回 {text, cover}，不是字符串）', async () => {
  /*
   * ⚠️ 这条锁的来由（2026-11-01 实测事故）：
   * 我第一版写了 `cleanModelText(await this._generate(...))` —— 把**对象**丢进 String()，
   * 于是真的往 QQ 发了一条「[object Object]」。日志上：
   * ```
   * B站：BV1dXxp6xEk3 看完补一句（等了 10s）「[object Object]」
   * ```
   * `_handle` 那边一直是 `gen?.text ?? ''`（L2943 附近），照抄才对。
   */
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  const i = src.indexOf('async _videoFollowUp(')
  assert.ok(i > 0, '找不到 _videoFollowUp')
  const body = src.slice(i, i + 3000)
  assert.match(body, /gen\.text/, '要从 gen.text 取文本')
  assert.match(body, /typeof gen\?\.text !== 'string'/, '要有类型闸 —— 不是字符串就不发（别再让 [object Object] 到用户眼前）')
  assert.ok(!/cleanModelText\(String\(text \?\? ''\)\)/.test(body),
    '这句就是当初的错误写法，别再回来')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)