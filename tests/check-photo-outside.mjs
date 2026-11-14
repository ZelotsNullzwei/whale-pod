/**
 * 出图场景：「在外面」不能再说「她在自己家」（2026-11-10）
 *
 * ## 现场
 * 她先说「要不本鲸现在穿上出门买个宵夜」，画图场景写「一碗汤粉…**小店里暖黄的灯**」，
 * 结果出图是**家里厨房煮面** —— 因为提示词里写死了"她在自己家"，把场景的小店压掉了。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { planShot } from '../src/photo/index.js'
import { TEMPORARY_OUTING, temporaryOutingLayer } from '../src/memory/wardrobe.js'

let pass = 0, fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}
const cfg = { provider: 'openai-images', aspect: '9:16', resolution: '1K' }
const plan = { outfit: '雾霾蓝细吊带 + 深灰棉质家居短裤，光脚', hair: '扎成低马尾' }
/*
 * ⚠️ 每个用例必须用**不同的 scope**：planShot 有 continuity（同一会话会继承上一张的构图），
 *    用同一个 scope 时后面的用例会拿到不同 framing，测的就不是同一件事了。
 */
let seq = 0
const promptOf = (scene) => String(planShot({ scene, slot: 'evening', scope: `probe:${++seq}`, outfit: plan.outfit, hair: plan.hair, mode: 'daily', imageCfg: cfg })?.prompt ?? '')

console.log('=== 1. 外面场景 ===')
ok('★ 事故原句（小店）→ 说"在外面"，不说"自己家"', () => {
  const p = promptOf('一碗热气腾腾的汤粉，上面卧着一个煎蛋，几根青菜，筷子搁在碗边，小店里暖黄的灯')
  assert.match(p, /外面/, '应说明她在外面的场景里')
  assert.ok(!/她在自己家/.test(p), '不能再说"她在自己家"')
})
ok('★「出门买宵夜」→ 外面', () => {
  const p = promptOf('出门买了份宵夜，塑料袋拎在手里，街边路灯照着')
  assert.match(p, /外面/)
})
ok('★ 小区 / 楼道 / 电梯 / 快递柜 也算外面（2026-11-10 补）', () => {
  /* 2026-11-12：挑/拿类要用手的第一人称已改为拍物；这里用纯环境句测地点判定（rear/ первой人称都带地点行） */
  for (const s of ['楼道口的灯有点暗', '电梯里等楼层', '快递柜前取件码', '小区门口有棵大树']) {
    const p = promptOf(s)
    assert.ok(/外面/.test(p), `场景「${s}」应判外面`)
  }
})
ok('★ 便利店 / 餐厅 / 地铁 也算外面', () => {
  for (const s of ['便利店的货架摆满饮料', '餐厅桌上摆着一碗面', '地铁车厢里很安静']) {
    assert.match(promptOf(s), /外面/, `场景「${s}」应判外面`)
  }
})

console.log('\n=== 2. 家里场景保持原行为 ===')
ok('★「在家煮面」→ 仍是自己家', () => {
  const p = promptOf('在家煮了一碗面，厨房的灯很亮，锅还冒着热气')
  assert.match(p, /她在自己家/)
  assert.ok(!/在外面/.test(p), '家里的场景不该说在外面')
})
ok('★ 没有任何地点词 → 默认自己家（不误判）', () => {
  assert.match(promptOf('一只手端着碗'), /她在自己家/)
})

console.log('\n=== 3. 下载走代理兜底（问题 1）===')
ok('★ 生成图下载都用 fetchWithProxyFallback（不再裸 fetch）', () => {
  const src = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
  assert.match(src, /import \{ fetchWithProxyFallback \} from '\.\.\/net\.js'/)
  const bad = src.match(/await fetch\((r\.url|r2\.url|retry\.url|v)\b/)
  assert.equal(bad, null, `还有裸 fetch：${bad && bad[0]}`)
  assert.ok((src.match(/fetchWithProxyFallback\(/g) ?? []).length >= 6, '下载点应都换掉了')
})

console.log('\n=== 4. 临时出门：家居服 + 外套 + 换鞋（2026-11-10） ===')
const promptWith = (scene, outfit) => String(planShot({ scene, slot: 'evening', scope: `probe:${++seq}`, outfit, hair: plan.hair, mode: 'daily', imageCfg: cfg })?.prompt ?? '')
ok('★ 外面 + 家居服 → 要求套外套、换鞋，且不换整套', () => {
  const p = promptWith('出门买宵夜，街边路灯照着', plan.outfit)
  assert.match(p, /临时出门/)
  assert.match(p, /套一件|外套|开衫|卫衣|风衣|马甲/, '要在家居服外面加一件外层')
  assert.match(p, /帆布鞋|运动鞋|乐福鞋/, '要换出门的鞋')
  assert.match(p, /别换成整套外出服/)
})
ok('★ 外面 + 已经是外出服 → 不加"临时出门"', () => {
  const p = promptWith('出门买宵夜，街边路灯照着', '米白半长裙，白针织上衣，白色帆布鞋')
  assert.ok(!/临时出门/.test(p), '本来就穿着外出服，不该再套外套')
})
ok('★ 在家 + 家居服 → 不加"临时出门"', () => {
  const p = promptWith('在家煮了一碗面，厨房的灯很亮', plan.outfit)
  assert.ok(!/临时出门/.test(p))
})
ok('★ temporaryOutingLayer 稳定且来自候选池', () => {
  const seed = '出门买宵夜街边路灯照着吊带短裤'
  const a = temporaryOutingLayer(seed)
  const b = temporaryOutingLayer(seed)
  assert.equal(a, b, '同种子必须同结果（同一场景别每次换外套）')
  assert.ok(TEMPORARY_OUTING.includes(a))
})

console.log('\n=== 5. 双手动作退回单手（2026-11-12 用户口径） ===')
ok('★「双手捧碗」→ 退回单手出图（不跳过）', () => {
  const shot = planShot({ scene: '出门买宵夜，街边小店的暖黄灯，双手捧着一碗热气腾腾的汤粉', slot: 'evening', scope: 'tp1', outfit: plan.outfit, hair: plan.hair, mode: 'daily', imageCfg: cfg })
  assert.equal(shot.skip, false, `不该跳过：${shot.skipReason ?? ''}`)
  assert.equal(shot.handStatus, 'degraded_action')
  const p = String(shot.prompt ?? '')
  assert.ok(p.length > 0, '应正常拼出提示词')
  assert.ok(!/双手捧碗|双手端着/.test(p), '提示词不能还写场景的双手动作')
})
ok('★「端在手里（单手）」保持 first_person —— 端=单手（v10）', () => {
  const shot = planShot({ scene: '出门买宵夜，街边小店的暖黄灯，一碗热气腾腾的汤粉端在手里', slot: 'evening', scope: 'tp1b', outfit: plan.outfit, hair: plan.hair, mode: 'daily', imageCfg: cfg })
  assert.equal(shot.mode, 'first_person', `实际 ${shot.mode}`)
  assert.equal(shot.handStatus, 'ok')
})
ok('★「抱纸箱」→ 退回单手出图（不跳过）', () => {
  const shot = planShot({ scene: '在小区门口取快递，抱着一个纸箱，夜里楼道口有灯', slot: 'evening', scope: 'tp2', outfit: plan.outfit, hair: plan.hair, mode: 'daily', imageCfg: cfg })
  assert.equal(shot.skip, false, `不该跳过：${shot.skipReason ?? ''}`)
  assert.ok(['degraded_action', 'ok'].includes(shot.handStatus), `handStatus=${shot.handStatus}`)
})
ok('★ 单手场景（拿一瓶饮料）→ 2026-11-12 起改为拍物（不画手）', () => {
  const shot = planShot({ scene: '在便利店门口，手里拿着一瓶刚买的饮料，街边路灯亮着', slot: 'evening', scope: 'tp3', outfit: plan.outfit, hair: plan.hair, mode: 'daily', imageCfg: cfg })
  assert.equal(shot.mode, 'rear_selfie', `实际 ${shot.mode}`)
  assert.match(shot.prompt, /没有手|没有人/)
})

ok('★「不出门」不能被当成外面（否则会加外套换鞋）', () => {
  const shot = planShot({ scene: '居家自拍：客厅；今天的发型比较随缘，反正也不出门', slot: 'noon', scope: 'tp4', outfit: '浅灰短袖家居T恤，深蓝棉布长裤，白棉袜，木色拖鞋', hair: plan.hair, mode: 'daily', imageCfg: cfg })
  assert.ok(!/临时出门/.test(shot.prompt), '不该触发临时出门外套')
  assert.ok(!/帆布鞋/.test(shot.prompt), '不该换帆布鞋')
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
