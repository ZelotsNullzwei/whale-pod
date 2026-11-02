/**
 * 表情段的两个实测怪癖（2026-11-02，对着 NapCat :3000 逐个形态试出来的）。
 *
 * ## 怪癖一：整条消息只有一个 face 段 → 拒收
 * ```
 * 只有 face（数组 / id 数字 / CQ 字符串）  → ❌ 全拒
 * 空文字 + face                          → ✅ 通
 * face + 空格                            → ✅ 通
 * 文字 + face                            → ✅ 通
 * 只有 image                             → ✅ 通（图不受影响）
 * ```
 * **规律：单独一个 face 不行，只要旁边有别的段就行。**
 *
 * ## 怪癖二：一个附件段发失败，不该把整条回复判成失败
 *
 * ## 这俩凑一起出的事故
 * B 站长视频的补发：她生成了正文、后台也听完了（1030 字），
 * 但那条消息**以表情开头** → 第一段是"单独一个 face" → 被拒 →
 * `_send` 抛错中断 → **后面的正文一个字都没发出去**。
 * 用户看到的是「她没读视频」，日志里只有一句「补发失败」。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

ok('单独一个 face 段要挂空文字前缀（否则 NapCat 拒收）', () => {
  assert.match(src, /payload\[0\]\?\.type === 'face'/,
    '要有"只有 face 段"的识别')
  assert.match(src, /payload = \[\{ type: 'text', data: \{ text: '' \} \}, payload\[0\]\]/,
    '要挂空文字段 —— 实测这是唯一不改语义的过法')
})

ok('face / mface 段失败不中断整条（正文必须发出去）', () => {
  assert.match(src, /seg\.kind === 'image' \|\| seg\.kind === 'face' \|\| seg\.kind === 'mface'/,
    '三类附件段都该"warn + continue"，不能只保 image')
})

ok('正文段失败仍然抛错（一个字都没发出去，调用方该知道）', () => {
  // 附件段之后紧跟的 throw 必须还在，且不能被附件分支吞掉
  const i = src.indexOf("seg.kind === 'image' || seg.kind === 'face' || seg.kind === 'mface'")
  assert.ok(i > 0, '找不到附件分支')
  const after = src.slice(i, i + 700)
  assert.match(after, /throw new Error\(`OneBot 返回失败/, '正文段失败还是要抛')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)