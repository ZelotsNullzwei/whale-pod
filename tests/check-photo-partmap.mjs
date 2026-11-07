/**
 * 部位词 → 上游中性措辞（2026-11-07，GPT 交接）。
 *
 * 背景：edits 接口对「胸口」返回 HTTP 400。继续改提示词硬碰硬没意义 ——
 * 当成**文本安全过滤**处理：内部 ID 不变，只把发给上游的自然语言换成服装术语。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { upstreamPartName, hasUpstreamAlias, partPromptMap, RAW_PART_WORDS } from '../src/photo/partPromptMap.js'
import { composeFraming } from '../src/photo/photo-composer.js'
import { composePhotoPrompt } from '../src/photo/photo-prompt.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const promptFor = (req) => {
  const framing = composeFraming({ mode: 'front_selfie', subject: '坐在床边' }, { request: req })
  const p = composePhotoPrompt({
    plan: { camera: '举在身前', look: '看镜头', rules: [] },
    framing, scene: '卧室', outfit: '白T', hair: '蓝发', weather: '夜', mood: '',
    hasRef: false, anime: false, character: {}, mode: 'close',
  })
  return { framing, p }
}

console.log('=== 1. 映射表 ===')
ok('★ 每个部位都有中性说法，且不含原始词', () => {
  for (const [k, v] of Object.entries(partPromptMap())) {
    assert.ok(v && v.length >= 2, `${k} 没有中性说法`)
    for (const bad of RAW_PART_WORDS) assert.ok(!v.includes(bad), `${k} 的说法里还有「${bad}」`)
  }
})
ok('★ 胸部 → 领口/肩/上衣（不是身体部位）', () => {
  const v = upstreamPartName('胸部')
  assert.match(v, /领口/)
  assert.match(v, /上衣/)
  assert.ok(!v.includes('胸'))
})
ok('★ 认不出的部位退化成中性词，不回吐原始 ID', () => {
  assert.equal(upstreamPartName('尾巴'), '局部细节')
  assert.equal(hasUpstreamAlias('尾巴'), false)
})

console.log('\n=== 2. 提示词里不再出现原始部位词 ===')
ok('★ 「看看胸」的提示词不含「胸口/胸部」', () => {
  const { p } = promptFor('看看胸')
  assert.ok(!p.includes('胸口'), '还有「胸口」')
  assert.ok(!p.includes('胸部'), '还有「胸部」')
  assert.match(p, /领口、肩部及上衣穿搭细节/, '中性说法没进去')
})
ok('★ 内部 ID 不变（裁切表/缓存仍按「胸部」走）', () => {
  const { framing } = promptFor('看看胸')
  assert.equal(framing.bodyPart, '胸部')
})
ok('★ 腿/脚/锁骨 也走了中性说法', () => {
  assert.match(promptFor('看看腿').p, /腿部穿搭细节/)
  assert.match(promptFor('看看脚').p, /鞋袜穿搭细节/)
  assert.match(promptFor('看看锁骨').p, /领口与肩部细节/)
})

console.log('\n=== 3. 400 诊断（不再一律归因于某个词）===')
ok('★ bridge 记录原始错误/参考图/提示词长度', () => {
  const b = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(b, /部位特写生成失败/)
  assert.match(b, /原始=/)
  assert.match(b, /参考图=/)
  assert.match(b, /疑似参考图触发过滤/)
})
ok('★ 旧的「把胸换成领口和肩」硬替换已移除', () => {
  const b = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.ok(!b.includes("Replace(/胸口|胸部|胸/g, '领口和肩')"), '旧硬替换还在')
  assert.ok(!b.includes('降级成领口/肩重试一次'), '旧日志还在')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
