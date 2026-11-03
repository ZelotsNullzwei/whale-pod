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

/*
 * ★★★ 2026-11-03 语义变更（用户选的 A）：**等后台时也把评论/弹幕给它**。
 *
 * ## 为什么改
 * 原来 `pendingLong` 那条 `return` **连评论/弹幕一起砍掉**（注释原话"连评论/弹幕都不给"），
 * 理由是怕模型拿评论凑观后感。但 2026-11-03 把 **">15 秒一律转后台"** 落地之后，
 * 这条路的触发频率暴涨，于是：
 * ```
 *   现场（70 秒《绝区零》演示，群里）：
 *     评论 5 条 / 弹幕 10 条   ← 都抓到了 ✓
 *     转出来是空的（这视频真没说话）    ← 永远转不出内容
 *     她的回复：「点开那个视频了，标题里写着大肥鱼，内容我还没看完」
 *   → 手里有 5 条评论 + 10 条弹幕，却**只提标题** ✗
 * ```
 * **"没说话"的视频永远转不出内容 → 那些评论弹幕被永久浪费。**
 *
 * 现在的做法：不 return，改打 `pendingOnly` 标记，评论/弹幕照拼，
 * 结尾补一句说清性质（"视频本身还没听到，但评论/弹幕是真的"）。
 * **说清用途比整段砍掉好** —— 这是用户的判断，不是我的。
 */
await ok('★ 长视频等后台时：仍说清"你还没听到内容"，而且**不许编**', () => {
  assert.match(pending, /视频本身你还没听到/, '要明确说它还没听到')
  assert.match(pending, /别聊里面讲了什么/, '要禁止聊内容')
  assert.match(pending, /别编/, '★ 连"点开想干嘛"也不许编（2026-11-02 实测事故）')
  assert.match(pending, /刚开始看/, '有人问就说"刚开始看"')
})

await ok('★ 等后台时：**不能**出现"你得说点具体的"那套（那会逼它硬凑内容）', () => {
  assert.ok(!pending.includes('你得说点具体的'),
    '那段是给"已经听到内容"写的，等后台时出现就会逼它拿标题硬凑')
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

await ok('★★★ 等后台时**也给**评论/弹幕，而且要说"总结成自己的看法"', () => {
  assert.match(pending, /评论区怎么说/, '★ 等后台时也要给评论区（否则"没说话"的视频等于什么都没看到）')
  assert.match(pending, /弹幕在刷什么/, '★ 弹幕同理')
  // 元信息仍然要在
  assert.match(pending, /谁是最适合当妈妈的AI/, '标题不能少')
  assert.match(pending, /牢大百科/, 'UP 主不能少')
  /*
   * ★★ 用户原话：「**别人说的可以总结一下变成自己的**」。
   *    这条比我第一版写的"可以按大家的反应接话"强 —— 后者等于让她**当传声筒**。
   *    现在要的是：评论/弹幕是**素材**，消化成**自己的**看法再说。
   */
  assert.match(pending, /评论\/弹幕是\*\*真的\*\*/, '要说明评论/弹幕是真的')
  assert.match(pending, /总结成你自己的看法/, '★ 要能"总结成自己的看法"，不是复述别人的')
  assert.match(pending, /别当传声筒/, '★ 明确禁止"有人说…"这种复述腔')
})

await ok('★★ 等后台时**不能**出现"真人看完一个视频"那套（她还没看完）', () => {
  /*
   * 2026-11-03 踩的：`pendingOnly` 时那段"怎么用"是**无条件**拼的，
   * 里面写着「真人**看完**一个视频，说的是…」—— 她还在后台听，自相矛盾 ✗。
   * 而且它和「这时候别评价」打架（一个让说看法、一个让别评价）。
   * 现在 pending 时**整段跳过**，只留上面那段括号。
   */
  assert.ok(!pending.includes('真人看完一个视频'), '★ 她还没看完，不能说"看完"')
  assert.ok(!pending.includes('上面这几块怎么用'), '★ 整段"怎么用"在 pending 时不该出现')
  // 但"别评价"这句要留着（她确实不该评价还没看的东西）
  assert.match(pending, /别评价/, '仍然不许评价没看完的东西')
})

await ok('听完了（只听开头 / 短片）之后也给评论/弹幕', () => {
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

await ok('★★★ 短视频不能在小预算里同步等转写（固定成本就 25 秒）', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')

  // 那条该死的模糊日志不许回来
  assert.ok(!/无语音\/没装 ASR\/超时/.test(src),
    '★ 「无语音/没装 ASR/超时」三个原因糊成一句 —— 就是它把我带偏的，别再回来')

  // 同步那条支路要有**很窄**的时长门槛（长了就一律走后台）
  assert.match(src, /SHORT_SYNC_MAX_SEC\s*=\s*(\d+)/, '要有"多短才配同步"的显式门槛')
  const maxSec = Number(/SHORT_SYNC_MAX_SEC\s*=\s*(\d+)/.exec(src)[1])
  assert.ok(maxSec <= 20, `同步门槛 ${maxSec}s 太宽 —— 转写固定成本就 25 秒，宽了等于故意让它超时`)

  // 同步没成 / 超时，必须**落到后台再试**，不许下"无语音"的结论
  const at = src.indexOf('SHORT_SYNC_MAX_SEC')
  const seg = src.slice(at, at + 2600)
  assert.match(seg, /_startVideoTranscribe\(/, '★ 同步失败要转后台重试（那条路本来就是为"不能等"设计的）')
  assert.match(seg, /info\.pendingLong\s*=\s*true/, '要让提示词如实说"我刚开始听"')
})

await ok('★★ ASR 失败必须说清是哪一种（不许只返回空字符串）', () => {
  const src = fs.readFileSync(new URL('../src/qq/asr.js', import.meta.url), 'utf8')
  /*
   * 老 `transcribeVideo` 四种失败全返回 `''`，调用方根本没法知道为什么。
   */
  assert.match(src, /export async function transcribeVideoDetailed/, '要有带原因的版本')
  for (const why of ['no-candidates', 'download-failed', 'asr-empty']) {
    assert.ok(src.includes(`'${why}'`), `why 里要有 ${why}`)
  }
  assert.ok(/why: 'timeout'/.test(src), '超时要单独标')
  assert.ok(/why: 'script-error'/.test(src), '脚本报错要单独标')
  assert.ok(!/启动 python 失败[\s\S]{0,60}debug/.test(src),
    'python 起不来这种事不该只写 debug —— 等于藏起来')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)