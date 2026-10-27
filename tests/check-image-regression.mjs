/**
 * 2026-10-27 三个 bug 的回归测试。
 *
 * 全部来自真实日志：
 *   ① 附图取历史旧图 → 每条纯文本都重发同一张
 *   ② QQ 图片 URL 过期（HTTP 400）→ 没重试
 *   ③ 日程生成的流消费方式 → 拿到空串
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const BRIDGE = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
const ONEBOT = fs.readFileSync(new URL('../src/qq/onebot.js', import.meta.url), 'utf8')
const INDEX = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

// ── ① 只附图当前消息的那张 ─────────────────────────────────
ok('不再从整个历史里倒着找带图消息', () => {
  /*
   * ⚠️ 只查**实际代码**，不查注释 —— 修法说明里我引用了旧写法
   *    （"原来是 [...recent].reverse().find(...)"），
   *    直接全文匹配会命中那句注释，误判成没修。
   */
  const code = BRIDGE.split('\n')
    .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
    .join('\n')
  assert.ok(!/\[\.\.\.recent\]\.reverse\(\)\.find/.test(code),
    '应该去掉 [...recent].reverse().find —— 它会把历史旧图重发')
})

ok('只取 history 最后一条（当前消息）的图', () => {
  assert.ok(/recent\[recent\.length - 1\]/.test(BRIDGE),
    '应该只看最后一条消息')
  assert.ok(/cur\.isMe/.test(BRIDGE), '自己的消息不附图')
})

ok('当前消息没图就返回空（不附图）', () => {
  assert.ok(/if \(!withImg\) return out/.test(BRIDGE))
})

// ── ② HTTP 400 换新 URL 重试 ───────────────────────────────
ok('有 _freshImageUrl 方法', () => {
  assert.ok(/async _freshImageUrl\(ref\)/.test(ONEBOT))
})

ok('400/403 会触发换地址重试', () => {
  assert.ok(/res\.status === 400 \|\| res\.status === 403/.test(ONEBOT), '应识别 400/403')
  assert.ok(/retried/.test(ONEBOT), '应有一次重试标记')
  assert.ok(/return this\.fetchImage\(fresh/.test(ONEBOT), '应重新下载新地址')
})

ok('重试有上限（不会无限递归）', () => {
  assert.ok(/__retried/.test(ONEBOT), '重试后要带标记')
  assert.ok(/&& !retried/.test(ONEBOT), '重试过就不再重试')
})

// ── ③ 日程生成消费流 ───────────────────────────────────────
ok('日程生成的流消费和 summarize 一致（读 chunk.text）', () => {
  // 找到 generateDayPlan 里的 for-await 段
  const genIdx = INDEX.indexOf('const generateDayPlan')
  assert.ok(genIdx > 0, '应存在 generateDayPlan')
  const seg = INDEX.slice(genIdx, genIdx + 2600)
  // 同样只看代码，不查注释
  const code = seg.split('\n')
    .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
    .join('\n')
  assert.ok(/typeof chunk\?\.text === 'string'/.test(code),
    '应该统一读 chunk.text')
  assert.ok(!/chunk\.textDelta/.test(code),
    '不该再用 textDelta（实测拿到空串）')
})

ok('解析失败有明确日志', () => {
  assert.ok(/日程生成：模型输出无法解析/.test(INDEX))
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
