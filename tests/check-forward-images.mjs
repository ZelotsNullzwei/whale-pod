/**
 * 转发里的图：拼成一张网格再交给模型（2026-11-06）。
 *
 * 用户要的链路：「用我们现在看 b 站视频的机制」「做拼贴」「然后再交给模型」。
 *
 * ## 守什么
 * ① **只看前几张**（默认 4）—— 87 张全看是真花钱，也没人等；
 *    超出的张数必须**说清楚**，别假装全看了
 * ② 两张以上才拼（一张没必要多一次编解码）
 * ③ 拼图失败 / 浏览器起不来 → **退回原图**，一张都不少
 * ④ 下载失败的单张跳过，不拖垮整条
 * ⑤ 一张都下不来 → 返回空（上层退回 `[图片]` 占位，不编内容）
 */
import assert from 'node:assert/strict'
import { stitchForwardImages } from '../src/qq/forward-images.js'

let pass = 0
let fail = 0
async function ok(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** 假的 fetchImage：给一张 1×1 png。 */
const mkFetch = (opts = {}) => async (ref) => {
  if (opts.failAll) throw new Error('download failed')
  if (opts.failRefs?.includes(ref)) throw new Error('download failed')
  return { dataUrl: PNG }
}

/** 假的 makeImageBlock：记下每次调用。 */
const mkBlock = () => {
  const calls = []
  const fn = async (o) => { calls.push(o); return { type: 'image', name: o.name } }
  fn.calls = calls
  return fn
}

console.log('=== 1. 张数上限（太多就看一点就停）===')
await ok('给 10 张、上限 4 → 只下 4 张，并且说清还有 6 张没看', async () => {
  const refs = Array.from({ length: 10 }, (_, i) => `https://x/${i}.jpg`)
  const r = await stitchForwardImages({
    refs,
    fetchImage: mkFetch(),
    makeImageBlock: mkBlock(),
    maxImages: 4,
    // 浏览器起不来（测试环境没有）→ 应退回原图，不影响"取了 4 张"这件事
  })
  assert.equal(r.used, 4)
  assert.equal(r.omitted, 6)
  assert.match(r.note, /共 10 张图，只看了前 4 张/)
  assert.ok(r.blocks.length >= 1, '至少要有一块进模型')
})

await ok('给 1 张 → 不拼（多一次编解码没意义）', async () => {
  const r = await stitchForwardImages({
    refs: ['https://x/only.jpg'],
    fetchImage: mkFetch(),
    makeImageBlock: mkBlock(),
  })
  assert.equal(r.used, 1)
  assert.equal(r.stitched, false)
  assert.equal(r.blocks.length, 1)
})

console.log('\n=== 2. 失败降级 ===')
await ok('一张都下不来 → 返回空块（上层退回 [图片] 占位，不编内容）', async () => {
  const r = await stitchForwardImages({
    refs: ['https://x/a.jpg'],
    fetchImage: mkFetch({ failAll: true }),
    makeImageBlock: mkBlock(),
    log: {},
  })
  assert.equal(r.blocks.length, 0)
  assert.equal(r.used, 0)
})

await ok('部分下载失败 → 成功的照常进模型', async () => {
  const r = await stitchForwardImages({
    refs: ['https://x/a.jpg', 'https://x/bad.jpg', 'https://x/c.jpg'],
    fetchImage: mkFetch({ failRefs: ['https://x/bad.jpg'] }),
    makeImageBlock: mkBlock(),
    log: {},
  })
  assert.equal(r.used, 2, '只算真正下下来的')
  assert.ok(r.blocks.length >= 1)
})

await ok('makeImageBlock 不可用（返回 null）→ 空块，不抛', async () => {
  const r = await stitchForwardImages({
    refs: ['https://x/a.jpg', 'https://x/b.jpg'],
    fetchImage: mkFetch(),
    makeImageBlock: async () => null,
    log: {},
  })
  assert.equal(r.blocks.length, 0)
})

await ok('maxImages=0 → 一张都不取（纯文字模式）', async () => {
  const r = await stitchForwardImages({
    refs: ['https://x/a.jpg'],
    fetchImage: mkFetch(),
    makeImageBlock: mkBlock(),
    maxImages: 0,
  })
  assert.equal(r.used, 0)
  assert.equal(r.blocks.length, 0)
  assert.equal(r.omitted, 1)
})

console.log('\n=== 3. 拼图：拼成功就只给 1 块 ===')
await ok('★ 两张以上 → 拼成 1 张，且**浏览器进程被关掉**（不关会挂住整条回复）', async () => {
  /*
   * 实测事故（2026-11-06）：原来只 `closePage` 不 `bot.close()`，
   * 浏览器是 `detached:false` 的前台子进程 → Node 等它退出才结束
   * → 脚本挂 3 分钟没返回，线上就是「这条回复永远发不出去」。
   */
  const logs = []
  const r = await stitchForwardImages({
    refs: ['https://x/a.jpg', 'https://x/b.jpg', 'https://x/c.jpg'],
    fetchImage: mkFetch(),
    makeImageBlock: mkBlock(),
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  })
  assert.equal(r.used, 3)
  assert.equal(r.stitched, true, '这台机器有 Edge，应该真拼上了')
  assert.equal(r.blocks.length, 1, '拼成一张就只该有 1 块')
  assert.ok(logs.some((m) => /拼成 1 张/.test(m)))
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)