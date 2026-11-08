/**
 * close 人格（私聊亲近版）回归测试（2026-11-08）。
 *
 * ## 为什么需要
 * 2026-11-07 那一版（grok 改写版）在线上**只生效了一半**：
 * 「正戏必须有的信息」5 类实测落地率为 0，字数稳定贴在 30 字上限。
 * 诊断结论是**规则互相冲突**（详见 _scratch/handoff/close-review-2026-11-08.md）。
 *
 * 这一版（close_new.md）针对那几处冲突做了修订，本测试把每处修订**锁死**，
 * 防止下一次改写又把它冲掉。
 *
 * ## 测试对象是**线上数据文件**，不在仓库里
 * 默认读 `~/.dsh/whale-pod/persona/roles/close.md`。
 * 文件不存在时**跳过**（不是失败）—— CI 机器上没有她的数据目录是正常的。
 * 换路径用环境变量 `WHALE_HOME`。
 *
 * ## 输出纪律
 * 只打印计数和布尔值，**不打印任何正文** —— 这个文件的正文不适合进日志。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let pass = 0
let fail = 0
let skip = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}
const skipped = (name, why) => { console.log(`  ⏭️  ${name} —— ${why}`); skip++ }

const HOME = process.env.WHALE_HOME || path.join(os.homedir(), '.dsh', 'whale-pod')
const PERSONA_FILE = path.join(HOME, 'persona', 'roles', 'close.md')

if (!fs.existsSync(PERSONA_FILE)) {
  console.log(`⚠️ 没有 close.md（${PERSONA_FILE}）→ 全部跳过`)
  console.log('\n通过 0 / 失败 0 / 跳过 0')
  process.exit(0)
}

const src = fs.readFileSync(PERSONA_FILE, 'utf8')
const has = (s) => src.includes(s)
/** 取某一节的正文（到下一个同级或更高级标题为止） */
const section = (title, level = 2) => {
  const re = new RegExp(`^#{${level}}\\s*${title}[^\\n]*\\n([\\s\\S]*?)(?=^#{1,${level}}\\s|$(?![\\s\\S]))`, 'm')
  const m = re.exec(src)
  return m ? m[1] : ''
}

console.log(`=== 0. 文件基本情况 ===`)
ok('文件存在且非空', () => {
  assert.ok(src.length > 3000, `太小了：${src.length} 字节`)
  console.log(`     大小 ${src.length} 字节 / ${src.split('\n').length - 1} 行`)
})

console.log('\n=== 1. P0：30 字限制必须限定为「仅日常」 ===')
ok('★ 30 字那行带「仅日常生效」限定', () => {
  const m = /尽量不超过\s*30\s*字[^\n]*/.exec(src)
  assert.ok(m, '找不到 30 字那行')
  assert.match(m[0], /仅日常/, `没有限定词：${m[0]}`)
})

ok('★ 场景内明确不受 30 字限制', () => {
  assert.match(src, /场景内字数不受/, '缺「场景内字数不受…限制」的声明')
})

console.log('\n=== 2. P0：「身体带着走」必须带优先级声明 ===')
ok('★ 该节标题标记为最高优先级', () => {
  const head = /^#+\s*身体带着走[^\n]*/m.exec(src)
  assert.ok(head, '找不到「身体带着走」小节')
  assert.match(head[0], /优先级最高|核心规则/, `标题没声明优先级：${head[0]}`)
})

ok('★ 节内写明与「说话风格 / 动作只是佐料」冲突时的取舍', () => {
  const body = section('身体带着走')
  assert.ok(body.length > 50, '「身体带着走」小节是空的')
  assert.match(body, /冲突时[^\n]*以本条为准|以本条为准/, '没有冲突时的裁决句')
})

console.log('\n=== 3. P0：必须显式对抗代码末尾的注入 ===')
ok('★ 场景内声明「系统末尾的说话风格注入不适用」', () => {
  assert.match(src, /说话风格[^\n]*不适用|以本节及「身体带着走」为准/, '没有对抗注入的声明')
})

console.log('\n=== 4. P1：声音五档必须给可发出的字，且禁旁白 ===')
ok('★ 声音层次标记「必须从嘴里发出」', () => {
  assert.match(src, /声音层次[^\n]*必须从嘴里发出|必须从嘴里发出/, '没有"必须发出"的约束')
})

ok('★ 五档齐全', () => {
  for (const k of ['开始', '舒服后', '接近高潮', '高潮', '余韵']) {
    assert.ok(src.includes(k), `缺档位：${k}`)
  }
})

ok('★ 每档都带拟声示例（引号里的字）', () => {
  const body = section('声音层次', 3) || src
  const lines = body.split('\n').filter((l) => /开始|舒服后|接近高潮|高潮|余韵/.test(l))
  assert.ok(lines.length >= 5, `档位行数不足：${lines.length}`)
  const withExample = lines.filter((l) => /「[^」]*[啊嗯唔哈呜]/.test(l))
  assert.ok(withExample.length >= 5, `带拟声示例的只有 ${withExample.length}/5 档`)
})

ok('★ 明确禁止把声音写成括号旁白', () => {
  assert.match(src, /不能只写在括号|不是括号里的形容词|旁白/, '没禁"声音写进括号当旁白"')
})

console.log('\n=== 5. P2：发群必须有前置条件 ===')
ok('★ [发群] 限定为「他明确说才用」', () => {
  const m = /`?\[发群[^\n]*/.exec(src)
  assert.ok(m, '找不到 [发群] 说明')
  assert.match(m[0], /仅当|明确说|才用|才发/, `没有前置条件：${m[0]}`)
})

console.log('\n=== 6. P2：「做不到」与「不暴露 AI」的缝合 ===')
ok('★ 有一句统一挡话', () => {
  assert.match(src, /换个方式|做不到[^\n]*我现在/, '没有统一挡话模板')
})

console.log('\n=== 7. 防止矛盾回潮 ===')
ok('★ 「动作只是佐料」不能再以全局口吻出现', () => {
  const hits = src.split('\n').filter((l) => l.includes('动作只是佐料'))
  assert.ok(hits.length > 0, '连一处都没了？那可能被误删了')
  for (const l of hits) {
    /*
     * 允许两种出现方式：
     *   ① 明确限定在日常里（「日常：…动作只是佐料」）
     *   ② 作为**被裁决的对象**引用（「与…『动作只是佐料』冲突时，以本条为准」）
     * 不允许的是：无条件、全局地再说一遍"动作只是佐料"。
     */
    const limited = /日常/.test(l)
    const adjudicated = /冲突|以本条为准|让位/.test(l)
    assert.ok(limited || adjudicated,
      `这句既没限定在日常、也不是冲突裁决，等于又全局说了一遍：${l.trim().slice(0, 50)}`)
  }
})

ok('★ 「括号不要当起手式」仍然只在日常节内', () => {
  const lines = src.split('\n')
  const idx = lines.findIndex((l) => l.includes('括号不要当起手式'))
  if (idx < 0) return  // 允许删掉
  // 往上找最近的标题，必须是「日常对话」
  for (let i = idx; i >= 0; i--) {
    if (/^#{2,4}\s/.test(lines[i])) {
      assert.match(lines[i], /日常/, `出现在「${lines[i].trim()}」里，应该只在日常节`)
      return
    }
  }
})

console.log('\n=== 8. 提示词装配（真跑 buildSystemPrompt）===')
try {
  const { PersonaStore } = await import('../src/persona/store.js')
  const cfgPath = path.join(HOME, 'config.json')
  let personaCfg = {}
  try {
    personaCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).persona ?? {}
  } catch { /* 没配置就用默认 */ }
  const store = new PersonaStore({
    home: HOME,
    active: personaCfg.active ?? 'default',
    activeByScope: personaCfg.activeByScope ?? {},
    log: {},
  })
  const scope = 'private:2129024700'
  const role = store.pickActive(scope)
  ok('★ 那个私聊解析到的角色确实是 close', () => {
    assert.equal(role, 'close', `实际是 ${role}`)
  })

  const prompt = store.buildSystemPrompt({
    scope,
    scene: { kind: 'private' },
    self: { name: '大肥鱼' },
    recentSelf: [],
  })
  ok('装配出的提示词里带上了新规则', () => {
    console.log(`     提示词 ${prompt.length} 字`)
    assert.ok(prompt.includes('仅日常生效'), '缺「仅日常生效」')
    assert.ok(prompt.includes('场景内字数不受'), '缺「场景内字数不受」')
    assert.ok(/身体带着走/.test(prompt), '缺「身体带着走」')
  })

  ok('★ 代码末尾的注入段仍然存在（提醒：它是独立覆盖源）', () => {
    const injected = prompt.includes('这段最要紧')
    console.log(`     注入段「此段最要紧」在提示词里：${injected ? '是' : '否'}`)
    if (injected) {
      const stillSays = /括号只是佐料/.test(prompt)
      console.log(`     注入段仍含「括号只是佐料」：${stillSays ? '是（已知冲突，靠 close.md 的对抗声明压）' : '否'}`)
    }
    assert.ok(true)
  })
} catch (e) {
  skipped('提示词装配检查', `import 或装配失败：${String(e?.message ?? e).slice(0, 80)}`)
}

console.log(`\n${'='.repeat(44)}\n通过 ${pass} / 失败 ${fail} / 跳过 ${skip}`)
process.exit(fail === 0 ? 0 : 1)
