/**
 * 户型统一（2026-11-11）：一室一厅 = 卧室/客厅/小厨房/阳台/卫生间/玄关
 * 按活动选房间；没有线索白天默认客厅，夜里才卧室（避免全是卧室）。
 */
import assert from 'node:assert/strict'
import { HOME_ROOMS, roomForActivity, roomScene, homeEnvelope } from '../src/memory/home.js'
import { composeContent } from '../src/qq/qzoneProactive.js'

let pass = 0, fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

console.log('=== 1. 房间清单 ===')
ok('★ 六个房间齐全', () => {
  for (const k of ['bedroom', 'living', 'kitchen', 'balcony', 'bathroom', 'entry']) assert.ok(HOME_ROOMS[k], k)
})
ok('★ 客厅里没有"晾衣杆"（晾衣属于阳台）', () => {
  assert.ok(!/晾衣杆/.test(HOME_ROOMS.living))
  assert.match(HOME_ROOMS.balcony, /晾衣杆/)
})

console.log('\n=== 2. 活动 → 房间 ===')
ok('做饭/洗碗 → 厨房', () => { assert.equal(roomForActivity('煮了碗面，洗锅有点烦'), 'kitchen') })
ok('晾衣服 → 阳台', () => { assert.equal(roomForActivity('把袜子晾了'), 'balcony') })
ok('刷牙/肥皂 → 卫生间', () => { assert.equal(roomForActivity('把洗手台的肥皂盒刷干净了'), 'bathroom') })
ok('沙发/吃饭 → 客厅', () => { assert.equal(roomForActivity('窝在沙发上吃了饭'), 'living') })
ok('睡/衣柜/穿搭 → 卧室', () => { assert.equal(roomForActivity('对着衣柜挑了半天'), 'bedroom') })
ok('没线索 → null（不硬猜）', () => { assert.equal(roomForActivity('今天心情还行'), null) })

console.log('\n=== 3. 环境句不再默认卧室 ===')
ok('★ 白天无线索 → 客厅', () => {
  const e = homeEnvelope('今天没什么事', 10)
  assert.match(e, /客厅/); assert.ok(!/这一张在卧室/.test(e))
})
ok('★ 夜里无线索 → 卧室', () => {
  assert.match(homeEnvelope('', 23), /卧室/)
})
ok('环境句含完整户型', () => {
  const e = homeEnvelope('做饭', 12)
  assert.match(e, /一室一厅/); assert.match(e, /厨房/)
})

console.log('\n=== 4. 说说场景会换房间（不只卧室） ===')
ok('★ 不同发型/穿搭的自拍，房间至少出现两种', () => {
  const rooms = new Set()
  for (const hair of ['披着，头发有点乱', '扎成低马尾', '丸子头', '刚洗完吹干', '侧边编发', '披肩发']) {
    const c = composeContent('selfie', { hair, outfit: '浅灰T恤' })
    const m = c.scene.match(/(卧室|客厅|阳台)/)
    if (m) rooms.add(m[1])
  }
  assert.ok(rooms.size >= 2, `实际：${[...rooms]}`)
})
ok('做饭的小事场景落在厨房，且只画洗锅（不画面、不出现手）', () => {
  const c = composeContent('scene', { smallThing: '煮了碗面，洗锅有点烦' })
  assert.match(c.scene, /厨房/); assert.match(c.scene, /^洗锅/); assert.match(c.scene, /泡着/)
  assert.equal(c.mode, 'rear_selfie')
  assert.ok(!/出现手/.test(c.scene.replace('不要出现手', '')), '不应出现手')
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
