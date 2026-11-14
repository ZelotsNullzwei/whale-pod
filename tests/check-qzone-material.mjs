/**
 * 说说素材「可公开」过滤（2026-11-10，v2 窄白名单）
 *
 * ## 口径（用户 2026-11-10 确认）
 * 「开发相关语境应过滤；普通生活内容里偶然提到『测试』或『API』不该整条丢掉。」
 *
 * 判不安全只有三种：
 *   ① 真实姓名 / 本机路径等敏感线索
 *   ② 强开发词（仓库/部署/报错/GPT/LLM/bug…）
 *   ③ 开发动词紧邻开发名词（跑测试/改代码/调接口），或 ≥2 个弱信号
 * 单个弱词（代码/测试/模型/API/接口/服务器/配置）→ 放行。
 */
import assert from 'node:assert/strict'
import { isPublicSafeMaterial, scrubMaterialText } from '../src/qq/qzoneProactive.js'

let pass = 0, fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const safe = (t) => isPublicSafeMaterial(t)

console.log('=== 1. 开发记录 / 私域 必须挡 ===')
ok('★ 真实脏数据 → 不安全', () => {
  for (const t of [
    'Null_zwei 在完善拍照系统，正和 GPT 一起跑测试',
    'Null_zwei 晚点回来继续给我改代码',
    '刚把 bridge.js 的 bug 修了',
    '在重启守护进程，日志里报错',
    '工作区有一堆未提交改动',
    '跑了一下午测试，才过一半',
    '晚上改代码改到两点',
  ]) {
    assert.equal(safe(t), false, `应被挡：${t}`)
  }
})

console.log('\n=== 2. 普通生活内容放行（单个常见词不误伤）===')
ok('★ 只出现「测试 / API / 配置」等单个词 → 放行', () => {
  for (const t of [
    '测试一下新买的咖啡机，出水量刚刚好',
    '今天 API 限额用完了，有点烦',
    '把智能灯的配置调了一下，晚上会自动变暗',
    '楼下超市的荔枝打折，买了两斤',
    '下午窝在沙发上把一部剧看完了',
    '把玄关那双帆布鞋的鞋带拆下来洗了，晾在阳台',
    '今天煮了锅粥，火大了有点糊',
  ]) {
    assert.equal(safe(t), true, `不该被挡：${t}`)
  }
})

console.log('\n=== 3. 脱敏：人名/路径替换掉，生活内容保留 ===')
ok('★「Null_zwei 平时晚上8点还没下课」→ 脱敏后可用', () => {
  const s = scrubMaterialText('Null_zwei 平时晚上8点还没下课')
  assert.ok(!/Null_zwei/i.test(s), '不能残留真实姓名')
  assert.ok(s.includes('晚上8点还没下课'), '生活内容要保留')
  assert.equal(safe(s), true, '脱敏后应放行')
})
ok('★ 路径被整段去掉', () => {
  const s = scrubMaterialText('把照片存到 D:/work/out 里了')
  assert.ok(!/[A-Za-z]:[\\/]/.test(s), '盘符路径要清掉')
})
ok('★ 脱敏后仍是开发记录 → 继续挡', () => {
  assert.equal(safe(scrubMaterialText('Null_zwei 正让 GPT 帮忙审批')), false)
  assert.equal(safe(scrubMaterialText('Null_zwei 在跑测试')), false)
})

console.log('\n=== 4. 边界 ===')
ok('空串 / 纯空白 / null → 不安全（没有素材）', () => {
  assert.equal(safe(''), false)
  assert.equal(safe('   '), false)
  assert.equal(safe(null), false)
})

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
