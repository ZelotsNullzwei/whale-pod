/**
 * 「身体带着走 + 括号」在**真正会被用到的那几个角色文件**里都必须有（2026-11-04）。
 *
 * ## 为什么重写过一次（本仓库最贵的一次"改错了文件"）
 * 2026-11-03 晚上我改了三刀：括号规则、身体带着走、30 字豁免 —— 全打在
 * `persona/roles/default.md` 上。第二天用户说「昨天的改动没有生效」。
 *
 * 根因在 `config.json`：
 * ```
 * persona.activeByScope = { group: 'default', private: 'default',
 *                           'private:2129024700': 'close' }   ← 你俩的私聊用 close
 * ```
 * **私聊绑的是 `close` 角色**，`default.md` 那三刀对私聊一个字都没生效。
 * （群聊吃到了，所以群里看着正常 —— 这个假象让我没起疑。）
 *
 * ## 所以改成"按配置解析角色文件"
 * 不再硬编码 `default.md`，而是从 `config.json` 读出各 scope 用哪个角色，
 * **逐个**检查它的文件里有没有那两节。以后再把规则写错文件，这条会立刻红。
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

/** 实际会被用到的角色名（群、私聊，以及显式绑定的具体会话）。 */
const roles = [...new Set([
  byScope.group ?? active,
  byScope.private ?? active,
  ...Object.entries(byScope).filter(([k]) => k.includes(':')).map(([, v]) => v),
])]

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

console.log(`按配置解析出的角色：${roles.join(', ')}`)

for (const role of roles) {
  const file = `${HOME}/persona/roles/${role}.md`
  if (!fs.existsSync(file)) continue          // 文件不在 → 上游回落 default，不算错
  const src = fs.readFileSync(file, 'utf8')

  ok(`[${role}] 有「身体带着走」，且点明主线是身体、状态要可读`, () => {
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