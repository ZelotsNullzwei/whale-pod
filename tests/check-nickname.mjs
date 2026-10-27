/**
 * 改昵称标记与校验测试。
 *
 * ⚠️ 这里测的是**全局 QQ 昵称**（`set_qq_profile`），不是群名片。
 *    改错了所有群和好友都会看到，所以边界比群名片严得多。
 */
import assert from 'node:assert/strict'
import {
  extractNicknameMarkers, stripNicknameMarkers, validateNickname,
  MAX_NICKNAME_LEN, NICKNAME_PER_HOUR,
} from '../src/qq/groupAdmin.js'

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

// ── 标记解析 ────────────────────────────────────────────────
ok('提取 [改昵称:新名字]', () => {
  const m = extractNicknameMarkers('行 [改昵称:本鲸去睡觉了]')
  assert.equal(m.length, 1)
  assert.equal(m[0].name, '本鲸去睡觉了')
})

ok('兼容全角冒号', () => {
  const m = extractNicknameMarkers('[改昵称：不吃鱼]')
  assert.equal(m[0].name, '不吃鱼')
})

ok('空名字不算标记', () => {
  assert.equal(extractNicknameMarkers('[改昵称:]').length, 0)
  assert.equal(extractNicknameMarkers('[改昵称:   ]').length, 0)
})

ok('剥掉标记不留空壳', () => {
  assert.equal(stripNicknameMarkers('[改昵称:新名]').trim(), '')
})

ok('剥标记保留正文', () => {
  assert.equal(stripNicknameMarkers('行 [改昵称:新名] 走了'), '行 走了')
})

ok('没有标记时原文不动', () => {
  assert.equal(stripNicknameMarkers('正常一句话'), '正常一句话')
})

// ── 校验：该放行的 ─────────────────────────────────────────
ok('正常昵称可以改', () => {
  const v = validateNickname({ name: '本鲸去睡觉了', currentName: '蓝色大肥鱼' })
  assert.equal(v.ok, true)
  assert.equal(v.name, '本鲸去睡觉了')
})

ok('12 个字刚好可以', () => {
  const v = validateNickname({ name: '一'.repeat(MAX_NICKNAME_LEN), currentName: 'x' })
  assert.equal(v.ok, true)
})

// ── 校验：必须拒绝的 ───────────────────────────────────────
ok('超过 12 个字被拒', () => {
  const v = validateNickname({ name: '一'.repeat(MAX_NICKNAME_LEN + 1), currentName: 'x' })
  assert.equal(v.ok, false)
  assert.match(v.reason, /最多/)
})

ok('空名字被拒', () => {
  assert.equal(validateNickname({ name: '', currentName: 'x' }).ok, false)
  assert.equal(validateNickname({ name: '   ', currentName: 'x' }).ok, false)
})

ok('纯符号被拒', () => {
  assert.equal(validateNickname({ name: '！！！', currentName: 'x' }).ok, false)
  assert.equal(validateNickname({ name: '···', currentName: 'x' }).ok, false)
})

ok('含引号被拒', () => {
  assert.equal(validateNickname({ name: '他说"嗨"', currentName: 'x' }).ok, false)
  assert.equal(validateNickname({ name: "it's", currentName: 'x' }).ok, false)
})

ok('含反斜杠被拒', () => {
  assert.equal(validateNickname({ name: 'a\\b', currentName: 'x' }).ok, false)
})

ok('跟当前一样被拒', () => {
  const v = validateNickname({ name: '蓝色大肥鱼', currentName: '蓝色大肥鱼' })
  assert.equal(v.ok, false)
  assert.match(v.reason, /一样/)
})

ok('换行被清理成空格', () => {
  const v = validateNickname({ name: '本鲸\n去睡觉', currentName: 'x' })
  assert.equal(v.ok, true)
  assert.equal(v.name, '本鲸 去睡觉')
})

// ── 频率限制 ───────────────────────────────────────────────
ok('一小时 3 次上限', () => {
  const now = Date.now()
  const hist = [now - 1000, now - 2000, now - 3000]
  const v = validateNickname({ name: '新名', currentName: 'x', history: hist, now })
  assert.equal(v.ok, false)
  assert.match(v.reason, new RegExp(String(NICKNAME_PER_HOUR)))
})

ok('超过一小时的记录不计入', () => {
  const now = Date.now()
  const hist = [now - 3700_000, now - 3800_000, now - 3900_000]
  const v = validateNickname({ name: '新名', currentName: 'x', history: hist, now })
  assert.equal(v.ok, true)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)
