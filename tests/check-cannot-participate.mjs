/**
 * 「参加不了的场子，不许说成"我去了"」的回归测试（2026-11-03）。
 *
 * ## 现场（用户截图 + 群里日志）
 * ```
 * 21:21:43 我「我哪来的码，我又不开房 / 你们开好了喊我」
 * 21:22:46 群友「https://game.misyra.com/?room=APXZ Null_」（卫戍协议的联机房间）
 * 21:22:50 我「来了来了，这就进」        ← 她根本进不去，群里一眼看穿
 * ```
 * 用户原话：「**进不去就不该那么说**」。
 *
 * ## 这条护栏为什么归在「说到做到」里，而不是新开一节
 * 说「我这就进」和说「我已经改名了」是**同一类错**：报了一件没发生的事。
 * 所以它写在模板的 `## 说到做到` 那节里。
 *
 * ## 为什么要测模板（本地人格不是另有一份吗）
 * 本地 `persona/roles/default.md` 是用户自己改过的，**模板更新不会覆盖它** ——
 * 所以那次修复同时改了两处：本地那份（立刻生效）+ 仓库模板这份（新装的、别人装的）。
 * 这条测试守的是**仓库里这份**，本地那份不进仓库、也没法测。
 *
 * ⚠️ 写这条测试时用到的老教训（这仓库吃过两次亏）：
 *    **别用固定字数窗口去切源码**（`src.slice(at, at + 1600)` 那种）——
 *    前面插一段注释就能把要找的那句挤出窗口，然后测试报"功能坏了"，
 *    其实是**量错了地方**。这里按**章节结构**切：从 `## 说到做到` 切到下一个 `## `。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../src/persona/store.js', import.meta.url), 'utf8')

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}
/** 异步版（动态 import 只能用异步）。 */
const okAsync = async (name, fn) => {
  try { await fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

/** 按章节结构切出一整节（切到下一个 `## ` 为止，不用字数窗口）。 */
function section(title) {
  const start = src.indexOf(`## ${title}`)
  assert.ok(start >= 0, `模板里找不到章节「${title}」`)
  const rest = src.slice(start + 3)
  const end = rest.indexOf('\n## ')
  return end < 0 ? rest : rest.slice(0, end)
}

console.log('=== 内置模板：「说到做到」里必须有一条"进不去的场子" ===')

ok('点了名：进不去 / 没有浏览器 / 哪些场子（房间、联机、语音、开黑）', () => {
  const s = section('说到做到（这条最要紧）')
  assert.ok(/进不去/.test(s), '要明说"进不去"')
  assert.ok(/没有浏览器|没有手/.test(s), '要讲清为什么（没有浏览器/没有手）')
  assert.ok(/房间|联机|语音|连麦|开黑/.test(s), `要点名是哪些场子：${s.slice(0, 80)}…`)
})

ok('连"提前承诺"也点掉了（她上一句就是「你们开好了喊我」）', () => {
  const s = section('说到做到（这条最要紧）')
  assert.ok(/这就进/.test(s), '要点名那句错话「来了来了，这就进」')
  assert.ok(/开好了喊我/.test(s), '提前承诺也要点 —— 那等于说"我会到"')
})

ok('给了替代做法：围观式参与', () => {
  const s = section('说到做到（这条最要紧）')
  assert.ok(/围观/.test(s), '要给出该怎么办（围观：聊玩法、问战况、起哄）')
})

ok('⚠️ 提醒"这是内部设定、不是要说出口的话"（人格里还有"不暴露是 AI"的边界）', () => {
  const s = section('说到做到（这条最要紧）')
  assert.ok(/不是要你说出口的话|别(说|讲)出口/.test(s),
    '得提醒她：嘴上只说"我进不去"，别真去解释浏览器 —— 那会撞上"不暴露是 AI"')
})

ok('留下用户原话当依据（这仓库的规矩：护栏要能追到现场）', () => {
  const s = section('说到做到（这条最要紧）')
  assert.ok(s.includes('进不去就不该那么说'), '要留用户原话')
  assert.ok(/2026-11-03/.test(s), '要留日期')
})

/*
 * ⚠️ 这条是**写上面那 5 条时自己踩出来的坑**（2026-11-03）：
 * 我把实测块用 ``` 围栏写进了人格正文 —— 而人格正文整段是**一个 JS 模板字符串**，
 * 反引号直接把字符串截断，`store.js` 变成语法错误，**整个守护进程起不来**，
 * 连 check-boot / check-persona-* / check-prompt-order 一起挂掉 8 个测试，
 * 而报错只是 "missing ) after argument list"，完全看不出是人格文案的锅。
 * （repo 里那些围栏全在 JS 注释里，不在人格正文里 —— 原来是这样才没事。）
 *
 * 这条测试是**按文本读文件**的，所以即使模块已经语法炸了它也能报出真正的原因。
 */
await okAsync('⚠️⚠️ 人格模块必须能被 JS **解析**（反引号会把模板字符串截断）', async () => {
  /*
   * ## 为什么这条必须存在（我自己一天之内踩了两次）
   * 人格正文（`buildSystemPrompt` 里 `parts.push(\`…\`)` 那一段）是**一个 JS 模板
   * 字符串**。往里面写反引号 —— 不管是 ``` 还是单个 `…` —— 都会把字符串截断：
   * `store.js` 变语法错误、**守护进程起不来**，`check-boot` / `check-persona-*` /
   * `check-prompt-order` 连带挂掉 8 个测试，而报错只有一句
   * 「missing ) after argument list」，完全看不出是文案的锅。
   *
   * 第一次我只加了"不许出现 ```" —— **不够**：第二次我用单个反引号写
   * 「`[等:N]`」，照样炸。**真正的判据是"它能被解析"**，所以这里直接 import：
   * 语法坏掉就抛，报错也就直指原因（而不是让 8 个不相干的测试泛红）。
   */
  const m = await import('../src/persona/store.js')
  assert.ok(typeof m.DEFAULT_PERSONA === 'string' && m.DEFAULT_PERSONA.length > 500, '要能载入内置人格')
})

ok('⚠️ 人格正文里不许出现代码围栏（实测块请用缩进写）', () => {
  // 注释里的围栏（` * ```` 那种）是安全的 —— 只找**不在注释里**的围栏
  const bad = src.split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => line.includes('```'))
    .filter(({ line }) => !/^\s*(\*|\/\/)/.test(line))
  assert.equal(bad.length, 0,
    `人格正文里出现了 \`\`\`（第 ${bad.map((b) => b.n).join(', ')} 行）——`
    + '实测块请用缩进写，别用围栏')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)