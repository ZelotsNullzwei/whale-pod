/**
 * 角色一致性回归（P0）：瞳色 / 尾巴固定特征 / 人格模板 / 衣柜完整性
 *
 * ⚠️ 路径全部相对仓库根，不写死本机目录。
 *    运行时人格（<WHALE_POD_HOME>/persona/roles/*.md）**不属于仓库**，
 *    仅在文件存在时做可选检查；不存在则 SKIP，CI 不依赖用户目录。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROFILE, fallbackText } from '../src/photo/character-profile.js'
import { effectivePools } from '../src/memory/wardrobe.js'
import { DEFAULT_PERSONA } from '../src/persona/store.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const HOME = process.env.WHALE_POD_HOME || ''

let pass = 0, fail = 0, skip = 0
function ok(name, fn) {
  try { fn(); console.log('  OK  ' + name); pass++ }
  catch (e) { console.log('  XX  ' + name + '\n      ' + e.message); fail++ }
}
function maybe(name, fn) {
  try { fn(); console.log('  OK  ' + name); pass++ }
  catch (e) {
    if (String(e.message).startsWith('SKIP')) { console.log('  --  ' + name + '（跳过：' + e.message.slice(5) + '）'); skip++ }
    else { console.log('  XX  ' + name + '\n      ' + e.message); fail++ }
  }
}

console.log('=== P0-1 瞳色 ===')
ok('PROFILE.face.eyes 是蓝色、不是棕色', () => {
  assert.match(PROFILE.face.eyes, /蓝色/)
  assert.ok(!/棕色/.test(PROFILE.face.eyes))
})
ok('兜底文本是蓝色瞳孔，且不含棕色', () => {
  const t = fallbackText()
  assert.match(t, /蓝色/)
  assert.ok(!/棕色/.test(t))
})

console.log('\n=== P0-2 尾巴不再是固定角色特征（数据结构） ===')
ok('PROFILE.accessories 没有 tail 字段', () => {
  assert.ok(!Object.prototype.hasOwnProperty.call(PROFILE.accessories, 'tail'))
})
ok('兜底文本完全不提尾巴', () => {
  assert.ok(!/尾巴|鲸尾/.test(fallbackText()))
})
ok('accessories 其余字段完整（head/ears/earNote/earForbid）', () => {
  for (const k of ['head', 'ears', 'earNote', 'earForbid']) assert.ok(PROFILE.accessories[k], '缺 ' + k)
})

console.log('\n=== P0-2 仓库内人格模板（store.js DEFAULT_PERSONA） ===')
ok('外观行不含「鲸鱼耳鳍和尾巴」', () => {
  assert.ok(!DEFAULT_PERSONA.includes('鲸鱼耳鳍和尾巴'))
})
ok('不再把鲸鱼尾作为识别必要条件', () => {
  assert.ok(!/蓝发\s*\+\s*鲸鱼尾/.test(DEFAULT_PERSONA), '识别规则仍在要求鲸鱼尾')
})
ok('耳朵/耳鳍特征仍在（识别依据保留）', () => {
  assert.match(DEFAULT_PERSONA, /鲸鱼耳鳍/)
})
ok('没有为了表达新设定而反复写"没有尾巴"', () => {
  const hits = (DEFAULT_PERSONA.match(/尾巴/g) || []).length
  assert.ok(hits <= 1, 'DEFAULT_PERSONA 里"尾巴"出现 ' + hits + ' 次，属于反复强调')
})

console.log('\n=== 人格源文件（运行时，可选） ===')
for (const f of ['close.md', 'default.md']) {
  maybe(`运行时 ${f} 不再把尾巴当外观`, () => {
    if (!HOME) throw new Error('SKIP 未设置 WHALE_POD_HOME（仓库内测试不依赖用户目录）')
    const p = path.join(HOME, 'persona', 'roles', f)
    if (!fs.existsSync(p)) throw new Error('SKIP 文件不存在: ' + p)
    const s = fs.readFileSync(p, 'utf8')
    assert.ok(!s.includes('鲸鱼耳鳍和尾巴'), f + ' 仍写「鲸鱼耳鳍和尾巴」')
    assert.ok(!s.includes('一条**鲸鱼尾巴**（尾鳍）'), f + ' 仍写「一条鲸鱼尾巴」')
  })
}

console.log('\n=== 衣柜完整性 ===')
ok('47 套服装数量不变', () => {
  const p = effectivePools()
  const all = [...p.home, ...p.outing, ...p.sleepwear, ...p.signature]
  assert.equal(all.length, 47)
})
ok('含尾巴装饰的服装仍保留（≥6 套）', () => {
  const p = effectivePools()
  const all = [...p.home, ...p.outing, ...p.sleepwear, ...p.signature]
  assert.ok(all.filter((x) => /尾巴|鲸尾/.test(x)).length >= 6)
})

console.log('\n=== 仓库内不得残留本机绝对路径 ===')
ok('相关文件不含本机绝对路径', () => {
  /* 用拼接构造，避免这个正则的字面量本身被检出 */
  const ABS = new RegExp('[A-Za-z]:' + '[' + String.fromCharCode(92, 92) + '/]' + '(?:' + 'Users' + '|' + 'DSH' + ')', 'i')
  const files = [
    path.resolve(ROOT, "src/photo/character-profile.js"),
    path.resolve(ROOT, "src/persona/store.js"),
    path.resolve(ROOT, "tests/check-character-profile.mjs"),
  ]
  for (const f of files) {
    const txt = fs.readFileSync(f, "utf8")
    assert.ok(!ABS.test(txt), path.basename(f) + " 含本机绝对路径")
  }
})

console.log(`\npass ${pass} / fail ${fail} / skip ${skip}`)
process.exit(fail === 0 ? 0 : 1)
