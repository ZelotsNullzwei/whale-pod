/**
 * P0 回归：瞳色 / 尾巴固定特征 / 衣柜完整性 / 人格源文件
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { PROFILE, fallbackText } from '../src/photo/character-profile.js'
import { effectivePools } from '../src/memory/wardrobe.js'

let pass = 0, fail = 0
function ok(name, fn) {
  try { fn(); console.log('  OK  ' + name); pass++ }
  catch (e) { console.log('  XX  ' + name + '\n      ' + e.message); fail++ }
}

console.log('=== P0-1 瞳色 ===')
ok('PROFILE.face.eyes 是蓝色、不是棕色', () => {
  assert.match(PROFILE.face.eyes, /蓝色/)
  assert.ok(!/棕色/.test(PROFILE.face.eyes), '不应再有棕色')
})
ok('兜底文本里也是蓝色瞳孔', () => {
  const t = fallbackText()
  assert.match(t, /蓝色/)
  assert.ok(!/棕色/.test(t))
})

console.log('\n=== P0-2 尾巴不再是固定角色特征 ===')
ok('PROFILE.accessories 里没有 tail 字段', () => {
  assert.ok(!Object.prototype.hasOwnProperty.call(PROFILE.accessories, 'tail'))
})
ok('兜底文本完全不提尾巴', () => {
  assert.ok(!/尾巴|鲸尾/.test(fallbackText()), '兜底文本不应出现尾巴')
})
ok('accessories 其余字段完整（head/ears 仍在）', () => {
  assert.ok(PROFILE.accessories.head)
  assert.ok(PROFILE.accessories.ears)
  assert.ok(PROFILE.accessories.earNote)
})

console.log('\n=== 人格源文件清理 ===')
ok('store.js 不再有「一条鲸鱼尾巴」与「尾巴、耳鳍是招牌」', () => {
  const s = fs.readFileSync('D:/DSH WorkSpace/whale-pod/src/persona/store.js', 'utf8')
  assert.ok(!s.includes('一条**鲸鱼尾巴**'), '仍有一条鲸鱼尾巴')
  assert.ok(!s.includes('尾巴、耳鳍是她的招牌'), '仍有尾巴招牌')
})
ok('人格 md 里不再把尾巴当成外观的一部分', () => {
  const dir = 'C:/Users/Null_zwei/.dsh/whale-pod/persona/roles'
  for (const f of ['close.md', 'default.md']) {
    const s = fs.readFileSync(dir + '/' + f, 'utf8')
    assert.ok(!s.includes('鲸鱼耳鳍和尾巴'), f + ' 仍写「鲸鱼耳鳍和尾巴」')
    assert.ok(!s.includes('一条**鲸鱼尾巴**（尾鳍）'), f + ' 仍写「一条鲸鱼尾巴」')
  }
})

console.log('\n=== 衣柜完整性 ===')
ok('47 套服装数量不变', () => {
  const p = effectivePools()
  const all = [...p.home, ...p.outing, ...p.sleepwear, ...p.signature]
  assert.equal(all.length, 47, '实际 ' + all.length)
})
ok('含尾巴的服装数据仍在（不误删衣柜）', () => {
  const p = effectivePools()
  const all = [...p.home, ...p.outing, ...p.sleepwear, ...p.signature]
  assert.ok(all.filter((x) => /尾巴|鲸尾/.test(x)).length >= 6, '带尾巴的服装被误删了')
})

console.log('\npass ' + pass + ' / fail ' + fail)
process.exit(fail === 0 ? 0 : 1)
