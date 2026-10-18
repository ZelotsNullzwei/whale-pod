/**
 * maxTokens 语义测试。
 *
 * 关键结论（实测得出，反直觉）：**0 / 负数 / 不传 = 不限制**。
 *
 *   同一道群聊题（都只该回 20 来字）：
 *     maxTokens=4096    68s   推理 8469 字   正文  0 字  ← 被推理吃光
 *     maxTokens=100000  32s   推理 4019 字   正文 24 字
 *     不传（无限）      34s   推理 3997 字   正文 24 字
 *
 * 推理没有天然终点 —— 给"中等"上限它会一路顶到极限，正文一个字都不剩。
 * 这条测试防止有人"好心"把默认值改回具体数字。
 */
import { toDshRequest } from '../src/gateway/openai.js'
import { ConfigStore } from '../src/config/store.js'

let pass = 0, fail = 0
const check = (n, ok, extra = '') => {
  if (ok) { pass++; console.log('  ✅ ' + n) }
  else { fail++; console.log('  ❌ ' + n + ' ' + extra) }
}

const MSG = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]

console.log('=== 1. 不限制的三种写法 ===')
for (const [v, label] of [[undefined, '不传'], [0, '0'], [-1, '负数']]) {
  const body = v === undefined ? { messages: MSG } : { messages: MSG, max_tokens: v }
  const r = toDshRequest(body)
  check(`max_tokens=${label} → 不传该字段（无限）`, r.maxTokens === undefined, String(r.maxTokens))
}

console.log('\n=== 2. 正整数才当上限 ===')
{
  const r1 = toDshRequest({ messages: MSG, max_tokens: 4096 })
  check('max_tokens=4096 → 原样用', r1.maxTokens === 4096, String(r1.maxTokens))

  const r2 = toDshRequest({ messages: MSG, max_tokens: 100000 })
  check('max_tokens=100000 → 原样用（不钳制）', r2.maxTokens === 100000, String(r2.maxTokens))

  // 太小的值会被推理吃光，保留 512 下限
  const r3 = toDshRequest({ messages: MSG, max_tokens: 100 })
  check('max_tokens=100 → 抬到 512 下限（太小必然空回复）', r3.maxTokens === 512, String(r3.maxTokens))

  const r4 = toDshRequest({ messages: MSG, max_completion_tokens: 2048 })
  check('max_completion_tokens 别名也认', r4.maxTokens === 2048, String(r4.maxTokens))
}

console.log('\n=== 3. 默认配置必须是 0（无限）===')
{
  const store = new ConfigStore({ home: '__test_max_tokens__' })
  const cfg = store.get()
  check('config 默认 maxTokens === 0', cfg.qq.maxTokens === 0, String(cfg.qq.maxTokens))
}

console.log('\n=== 4. 网关设置接口对 0 的处理 ===')
{
  // 模拟 UI 传来的值经过接口钳制后的结果（逻辑与 server.js 一致）
  const clamp = (body) => {
    if (!Number.isFinite(body.maxTokens)) return null
    const v = Math.round(body.maxTokens)
    return v > 0 ? Math.min(32768, Math.max(64, v)) : 0
  }
  check('传 0 → 仍是 0（不能被抬成 64）', clamp({ maxTokens: 0 }) === 0, String(clamp({ maxTokens: 0 })))
  check('传 2048 → 2048', clamp({ maxTokens: 2048 }) === 2048)
  check('传 100 → 100（本来就在下限之上）', clamp({ maxTokens: 100 }) === 100, String(clamp({ maxTokens: 100 })))
  check('传 10 → 抬到 64 下限', clamp({ maxTokens: 10 }) === 64, String(clamp({ maxTokens: 10 })))
  check('传 99999 → 钳到 32768', clamp({ maxTokens: 99999 }) === 32768)
}

console.log('\n' + '='.repeat(46))
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
