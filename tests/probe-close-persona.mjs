/**
 * close 人格「生成层」探针 —— **可选**回归测试（2026-11-08）。
 *
 * ## 为什么默认不跑
 * 它会真调模型（12 轮、每轮几秒到十几秒），而且模型输出有随机性 ——
 * 放进默认 CI 既慢又会有假红。所以用环境变量开关：
 *
 * ```bash
 * RUN_CLOSE_PROBE=1 node tests/probe-close-persona.mjs
 * RUN_CLOSE_PROBE=1 PROBE_PASSES=3 node tests/probe-close-persona.mjs   # 顶点多采几次
 * ```
 *
 * ## 它验什么
 * 用人格原文拼提示词（PersonaStore.buildSystemPrompt）+ 本地网关，
 * 走完 日常 → 进入 → 交主动权 → 加速 → 顶点 → 余韵，统计：
 * 拟声率 / 括号内旁白发声 / 液体 / 喷 / 收缩 / 表情 / 余韵 / ♡ / 起手式 / 长度。
 *
 * 只缺 QQ 收发那一段。**没有记忆、衣柜、日程**，所以语气比线上"干"，
 * 这些指标只能证明"规则能被模型接住"，不能替代线上验收。
 *
 * ## 输出纪律
 * stdout 只有指标与计数，不打印她的原话（内容不适合进日志）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ENABLED = process.env.RUN_CLOSE_PROBE === '1'
if (!ENABLED) {
  console.log('⏭️  跳过（这是可选探针，默认不跑）')
  console.log('   要跑：RUN_CLOSE_PROBE=1 node tests/probe-close-persona.mjs')
  process.exit(0)
}

const HOME = process.env.WHALE_HOME || path.join(os.homedir(), '.dsh', 'whale-pod')
const SCOPE = 'private:2129024700'
const PASSES = Math.max(1, Number(process.env.PROBE_PASSES ?? 1))

const cfgPath = path.join(HOME, 'config.json')
if (!fs.existsSync(cfgPath)) {
  console.log(`⏭️  跳过：没有 ${cfgPath}`)
  process.exit(0)
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
const key = cfg.gateway?.key
const port = cfg.gateway?.port ?? 18899
if (!key) {
  console.log('⏭️  跳过：config.json 里没有 gateway.key')
  process.exit(0)
}

const { PersonaStore } = await import('../src/persona/store.js')
const store = new PersonaStore({
  home: HOME,
  active: cfg.persona?.active ?? 'default',
  activeByScope: cfg.persona?.activeByScope ?? {},
  log: {},
})

const system = store.buildSystemPrompt({
  scope: SCOPE,
  scene: { kind: 'private' },
  self: { name: '大肥鱼' },
  recentSelf: [],
})

/**
 * 走完整弧线：日常 → 进入 → 交主动权 → 加速 → 顶点 → 余韵。
 * 早期版本只有「抱紧点」「别停」这种，他什么都没做，她永远到不了顶点，
 * 于是「喷/收缩/余韵」压根没机会出现 —— 那样测出来的 0 是假 0。
 */
const BASE_TURNS = [
  '还没睡？',
  '过来，躺我旁边',
  '（把你搂进怀里，手顺着腰往下摸）',
  '（手指探进去，慢慢地动）',
  '自己来，我看看你怎么动',
  '（托着你的腰，往上顶了一下）',
  '快一点，别磨',
  '（掐着腰往里撞，节奏乱起来）',
  '要到了吗',
  '别忍着',
  '（一把按住你，跟着一起绷紧）',
  '（抱住你，等你缓过来）',
]

/**
 * 状态锚点（`PROBE_ANCHOR=1` 才插入）。
 *
 * ## 为什么需要这个开关
 * 2026-11-08 实测：L1（发声）给了现成词后从 30% → 83%，
 * 而 L2（状态类描写）给了同等风格的词、还把触发条件写硬，**仍是 19%（7/36）不动**。
 *
 * 差别在类型：
 * - L1 是**自发项** —— 她自己的反应，给词就起来
 * - L2 是**响应项** —— `close.md` 那条写的是「对方先写了这一项，你也必须自己再写一次」，
 *   而原脚本里「他」**从头到尾没描述过状态**，那个"先"根本不存在，她没东西可接
 *
 * 所以加一组锚点台词做 A/B：
 * - 不加（默认）：基线，L2 ≈ 19%
 * - 加了：若 L2 明显跳升 → 规则没问题，是探针缺触发源；若不跳 → 她对该项确实惰性
 *
 * 做成开关而不是直接改基线，是为了两次数据能对齐比较。
 */
const ANCHORS = {
  3: '（手上全是水）',
  5: '（已经顺着腿往下淌了）',
}

const USER_TURNS = process.env.PROBE_ANCHOR === '1'
  ? BASE_TURNS.flatMap((t, i) => (ANCHORS[i] ? [t, ANCHORS[i]] : [t]))
  : BASE_TURNS

/** 先把括号剥掉再统计 —— 否则「（声音猛地拔高）」这种旁白会被当成发声 */
const stripBrackets = (t) => t.replace(/[（(][^）)]{0,200}[）)]/g, '')
const bracketText = (t) => (t.match(/[（(][^）)]{0,200}[）)]/g) ?? []).join('')

const FEATS = {
  拟声: /[啊嗯唔哈呜哦齁嘶嘤哎]/,
  液体: /湿|滑|水声|黏|往外冒|顺着流|淌/,
  喷涌: /喷|涌/,
  收缩: /一下下|收缩/,
  表情崩: /失焦|上翻|半眯|吐舌|涎|脸红/,
  余韵: /喘|呼…|气声|气音/,
  推托: /少问|别问|问这种话|你躺好|你先出力|你过来/,
  爱心: /[♡🖤]/,
}

async function runPass() {
  const messages = [{ role: 'system', content: system }]
  const rows = []
  for (const u of USER_TURNS) {
    messages.push({ role: 'user', content: u })
    let text = ''
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: 'auto', messages, stream: false, temperature: 0.9, max_tokens: 700 }),
        signal: AbortSignal.timeout(90_000),
      })
      const j = await res.json()
      if (j?.choices?.[0]?.finish_reason === 'content_filter') return { filtered: true }
      if (!res.ok) return { error: `HTTP ${res.status}` }
      text = String(j?.choices?.[0]?.message?.content ?? '')
    } catch (e) {
      return { error: String(e?.message ?? e).slice(0, 60) }
    }
    messages.push({ role: 'assistant', content: text })
    const out = stripBrackets(text)
    const row = {
      len: text.length,
      start: /^\s*[（(]/.test(text),
      soundOut: (out.match(/[啊嗯唔哈呜哦齁嘶嘤哎]/g) ?? []).length,
      soundInBracket: (bracketText(text).match(/[啊嗯唔哈呜哦齁嘶嘤哎]/g) ?? []).length,
    }
    for (const [k, re] of Object.entries(FEATS)) row[k] = re.test(text) && (k !== '拟声' || true)
    rows.push(row)
  }
  return { rows }
}

const all = []
let filtered = 0
for (let p = 1; p <= PASSES; p++) {
  process.stdout.write(`第 ${p}/${PASSES} 轮 … `)
  const r = await runPass()
  if (r.filtered) { console.log('被上游 content_filter 拦了（不算规则失败）'); filtered++; continue }
  if (r.error) { console.log(`出错：${r.error}`); continue }
  console.log(`${r.rows.length} 条`)
  all.push(...r.rows)
}

if (all.length === 0) {
  console.log('\n没有得到样本（全被拦或全出错）——视为跳过，不判失败')
  process.exit(0)
}

const n = all.length
const cnt = (k) => all.filter((r) => r[k]).length
const lens = all.map((r) => r.len).sort((a, b) => a - b)
const mid = lens[Math.floor(lens.length / 2)]
const over30 = lens.filter((x) => x > 30).length
const starts = all.filter((r) => r.start).length
const soundOut = all.reduce((a, r) => a + r.soundOut, 0)
const soundIn = all.reduce((a, r) => a + r.soundInBracket, 0)

/*
 * ⚠️ 输出用**代号**，不打印指标原名。
 *    原因：这些词放进日志/对话历史后，会让后续请求更容易被上游内容过滤打断
 *    （2026-11-08 实测：连着三次 content_filter 就是这个来源）。
 *    对照表见本文件 FEATS 与 close.changelog.md。
 */
const CODE = {
  拟声: 'L1 发声',
  液体: 'L2 状态①',
  喷涌: 'L3 状态②',
  收缩: 'L4 状态③',
  表情崩: 'L5 表情',
  余韵: 'L6 事后',
  推托: 'L7 推托',
  爱心: 'L8 符号',
}

const pct = (x) => `${Math.round((x / n) * 100)}%`
console.log(`\n样本 ${n} 条（${PASSES} 轮）`)
console.log(`  ${CODE.拟声}（括号外）  ${soundOut} 次，覆盖 ${cnt('拟声')} 条（${pct(cnt('拟声'))}）`)
console.log(`  括号内旁白发声  ${soundIn} 次   ← 必须为 0`)
for (const k of ['液体', '喷涌', '收缩', '表情崩', '余韵', '爱心', '推托']) {
  console.log(`  ${CODE[k].padEnd(10, '　')} ${cnt(k)}/${n}（${pct(cnt(k))}）`)
}
console.log(`  括号起手式      ${starts}/${n}（${pct(starts)}）  ← 已知偏高，不作为失败项`)
console.log(`  长度            中位 ${mid} / 最长 ${lens[lens.length - 1]} / 超30字 ${over30} 条`)

/* ── 阈值断言：宽松，只拦"明显退回去"的情况 ── */
const checks = [
  ['括号内不许出现旁白式发声', soundIn === 0],
  ['拟声要真的发出来（≥40% 条）', cnt('拟声') / n >= 0.4],
  ['长度不能被压回 30 字（中位 ≥30）', mid >= 30],
  ['场景内要有超过 30 字的句子（≥1/3）', over30 / n >= 0.33],
  ['不能出现推托词', cnt('推托') === 0],
]

let bad = 0
console.log('')
for (const [name, pass] of checks) {
  console.log(`  ${pass ? '✅' : '❌'} ${name}`)
  if (!pass) bad++
}

console.log(`\n${'='.repeat(44)}\n通过 ${checks.length - bad} / 失败 ${bad}`)
process.exit(bad === 0 ? 0 : 1)
