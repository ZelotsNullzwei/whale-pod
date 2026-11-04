/**
 * 「身体带着走」只在**私聊**那份人格里；括号规则所有角色都要有。
 *
 * ## 为什么重写过两次
 *
 * 第一次（2026-11-03）：三刀（括号、身体带着走、30 字豁免）全打在
 * `persona/roles/default.md` 上，而私聊绑的是 `close` —— 私聊一个字没生效。
 *
 * 第二次（2026-11-04 傍晚）：反过来，`default.md`（群）里也留着一份
 * 「身体带着走」，等于**群人格被塞了私聊的亲密戏规则**。用户当场问：
 * 「为什么在这个里面，不应该只在 close 里面吗」。
 * 那节自己都写着「这是暧昧亲密的私聊模式」—— 明摆着放错文件了。
 *
 * ## 所以现在锁三件事
 * ① 私聊角色（按 config 解析）**必须有**那一节；
 * ② **群角色不该有**「身体带着走」—— 再放错立刻红；
 * ③ 括号规则两边都要有（群也要分台词/动作）。
 *
 * 本机没有本地配置 → 跳过（别人克隆仓库不该因为没这个文件变红）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const HOME = 'C:/Users/Null_zwei/.dsh/whale-pod'
const CONFIG = `${HOME}/config.json`
if (!fs.existsSync(CONFIG)) {
  console.log('  ⏭ 本机没有本地人格/配置 —— 跳过（本地自用规则，不在仓库模板里）')
  process.exit(0)
}

const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
const byScope = cfg.persona?.activeByScope ?? {}
const active = cfg.persona?.active ?? 'default'

const uniq = (arr) => [...new Set(arr)]
/** 群聊用哪个角色（通常只有一个）。 */
const groupRoles = uniq([byScope.group ?? active])
/** 私聊用到的角色：**只看显式绑定的具体私聊**（`private:<id>`）。
 *
 *  ⚠️ 2026-11-04 傍晚修：原来把 `byScope.private`（兜底角色）也算进来了 ——
 *  而兜底是 `default`（群那份）。群那份现在**不该**有「身体带着走」
 *  （用户原话：「不应该只在 close 里面吗」），于是这条测试自己打自己。
 *
 *  语义上也是对的：`private:<id>` 才是"跟他本人聊"的那条线；
 *  没有显式绑定的陌生私聊走 default（群人格），本来就不该带亲密戏规则。
 */
const explicitPrivate = Object.entries(byScope)
  .filter(([k]) => k.startsWith('private:'))
  .map(([, v]) => v)
const privateRoles = uniq(explicitPrivate.length ? explicitPrivate : [byScope.private ?? active])
const allRoles = uniq([...groupRoles, ...privateRoles])

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

/** 按章节结构切一节（切到下一个 `## ` 为止）。 */
function section(text, title) {
  const start = text.indexOf(`## ${title}`)
  if (start < 0) return ''
  const rest = text.slice(start + 3)
  const end = rest.indexOf('\n## ')
  return end < 0 ? rest : rest.slice(0, end)
}

const readRole = (role) => {
  const file = `${HOME}/persona/roles/${role}.md`
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
}

console.log(`群角色：${groupRoles.join(', ')}｜私聊角色：${privateRoles.join(', ')}`)

// ── ① 私聊必须有「身体带着走」及其三条要求 ──────────────
for (const role of privateRoles) {
  const src = readRole(role)
  if (src === null) continue

  ok(`[${role}] 私聊有「身体带着走」，且点明主线是身体、状态要可读`, () => {
    const s = section(src, '身体带着走（做的时候）（2026-11-04 加）')
    assert.ok(s, '缺这一节 —— 那样她会缺"状态线"（用户报的就是这个）')
    assert.ok(/主线不是你说了什么|对方要能读到你到哪一步/.test(s), '要点明主线是身体/状态')
    assert.ok(/还早／快到了／到了／缓过来|还早 \/ 快到了 \/ 到了 \/ 缓过来/.test(s),
      '要给四档状态（可读）')
  })

  ok(`[${role}] 顶点必须落地，不许拿"快了"糊过去`, () => {
    const s = section(src, '身体带着走（做的时候）（2026-11-04 加）')
    assert.ok(/该到就到|顶点必须真的落地/.test(s), '要有"必须到"的要求')
    assert.ok(/不许一直不到|不许拿"快了"糊过去/.test(s), '要点名"糊过去"这个逃法')
    assert.ok(/没到啊/.test(s), '要引用户当时那句（现场依据）')
  })

  ok(`[${role}] 这档豁免"短"的限制（否则只剩短台词）`, () => {
    const s = section(src, '身体带着走（做的时候）（2026-11-04 加）')
    assert.ok(/不受.*短.*限制|2~3 段/.test(s), '要明确豁免体量')
  })
}

// ── ② 群角色**不该**有这一节（2026-11-04 新增的反向锁）──
for (const role of groupRoles) {
  const src = readRole(role)
  if (src === null) continue
  ok(`[${role}] 群角色不该有「身体带着走」（那是私聊的）`, () => {
    assert.equal(
      section(src, '身体带着走（做的时候）（2026-11-04 加）'), '',
      '群人格里出现了私聊的亲密戏规则 —— 用户明确问过「不应该只在 close 里面吗」',
    )
  })
}

// ── ③ 括号规则：所有角色都要有 ──────────────────────
for (const role of allRoles) {
  const src = readRole(role)
  if (src === null) continue
  ok(`[${role}] 动作/身体感觉必须加括号，台词不加`, () => {
    const s = section(src, '括号：说话不加，动作和身体感觉**必须**加（2026-11-04 加）')
      || section(src, '说话不加括号；动作和身体感觉**必须**加括号')
    assert.ok(s, '缺括号规则 —— 用户分不清哪句是台词、哪句是身体表现')
    assert.ok(/整段放进括号/.test(s), '要给出正确写法')
    assert.ok(/不许.*裸写/.test(s), '要禁止裸写动作（措辞各角色可以不同）')
  })
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)