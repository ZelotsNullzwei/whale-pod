/**
 * 「正文空、推理一大堆」要重试一次（2026-11-04 傍晚，私聊实测）。
 *
 * ## 现场
 * ```
 * 19:06:33 决策 → 发言 (p=1.00)
 * 19:06:40 本次生成非正常结束（stop）—— 正文 0 字、推理 2138 字，正文为空
 * 19:06:40 生成失败 — 上游只给了 finish_reason(stop) 但没有正文
 * ```
 * 然后**一个字都没发出去**。用户看到的就是「私聊里面现在不说话了」。
 *
 * 不是预算不够（16000 的额度，推理才 2138 字），是模型把话全花在"想"上、
 * 最后没吐正文。原来的处理是当作 `empty-after-clean` 沉默掉。
 *
 * ## 这条测试守什么
 * ① 有空正文+长推理 → 重试一次的分支；
 * ② 重试会带 `attempt + 1`（不能无限递归）；
 * ③ `_generate` 的签名里有这个计数位。
 *
 * （用源码锁：这段逻辑要真跑起来得连上游，成本比收益高。）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = fs.readFileSync(path.join(root, 'src/qq/bridge.js'), 'utf8')

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

console.log('=== 空正文重试 ===')

ok('_generate 签名带 attempt 计数', () => {
  assert.match(SRC, /async _generate\(msg, mem, scene, self, extraBlocks = null, extraNote = '', attempt = 0\)/,
    '签名没加 attempt —— 重试就没法收敛')
})

ok('正文空 + 推理 > 100 字 → 进重试分支', () => {
  assert.match(SRC, /if \(!cleaned && reason\.length > 100 && attempt < 1\)/,
    '缺少「空正文且推理不短才重试」的判据')
})

ok('重试会带上「直接给正文」的提醒', () => {
  assert.match(SRC, /直接给正文/, '重试时的提示语丢了 —— 不带的话多半还会再空一次')
})

ok('重试传 attempt + 1（最多一次，不会递归打转）', () => {
  assert.match(SRC, /attempt \+ 1,/, '递归没加计数 —— 上游一直空就会无限重试')
})

ok('正文正常时不走重试（cleaned 非空）', () => {
  // 判据里必须带 !cleaned，否则每条回复都会被重试一遍（翻倍烧 token）
  assert.match(SRC, /if \(!cleaned && reason\.length > 100 && attempt < 1\)/)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)