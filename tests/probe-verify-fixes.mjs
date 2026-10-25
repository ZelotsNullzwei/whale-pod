/**
 * 重启后的端到端验证。
 * 直接复用运行中实例的配置，测两个修复点：
 *   1) 图片下载（代理兜底）
 *   2) model 判断（providerId 自动推导）
 */
import fs from 'node:fs'
import { fetchWithProxyFallback, checkProxyHealth } from '../src/net.js'
import { ModelDecisionProvider, parseVerdict } from '../src/decision/model.js'
import { createFallbackLlm } from '../src/gateway/fallback.js'

// ── 1. 代理自检 ─────────────────────────────────────────────
const h = await checkProxyHealth()
console.log('=== 代理自检 ===')
console.log(`  ${h.ok ? '✅' : '⚠️'} ${h.detail}`)

// ── 2. 图片下载 ─────────────────────────────────────────────
console.log('\n=== 图片下载（真实 QQ URL）===')
const body = JSON.stringify({ user_id: 2129024700, count: 10 })
const hist = await fetch('http://127.0.0.1:3000/get_friend_msg_history', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body,
}).then((r) => r.json())

let imgUrl = null
for (const m of hist.data?.messages ?? []) {
  for (const seg of m.message ?? []) {
    if (seg.type === 'image' && seg.data?.url) imgUrl = seg.data.url
  }
}

if (!imgUrl) {
  console.log('  （历史里没有图片 URL，跳过）')
} else {
  try {
    const r = await fetchWithProxyFallback(imgUrl, {
      timeoutMs: 25000,
      log: (m) => console.log(`  ${m}`),
    })
    const buf = r.body ? Buffer.from(r.body) : null
    const head = buf ? buf.subarray(0, 4).toString('hex') : ''
    const isJpeg = head.startsWith('ffd8ff')
    const isPng = head === '89504e47'
    console.log(`  结果: ${r.ok ? '✅' : '❌'} HTTP ${r.status}, ${buf?.length ?? 0} bytes`)
    console.log(`  格式: ${isJpeg ? 'JPEG' : isPng ? 'PNG' : head}  ${buf && buf.length > 5000 ? '（真实图片）' : ''}`)
  } catch (e) {
    console.log(`  ❌ ${e.message}`)
  }
}

// ── 3. model 判断（providerId 自动推导）─────────────────────
console.log('\n=== model 判断（不传 providerId，验证自动推导）===')
const cfg = JSON.parse(fs.readFileSync('C:/Users/Null_zwei/.dsh/whale-pod/config.json', 'utf8'))
const llm = createFallbackLlm({
  channels: [{
    id: 'magpie', baseUrl: 'http://127.0.0.1:3425/v1', apiKey: 'dsh-local',
    model: 'magpie/auto/deepseek-v4.1-flash', models: ['magpie/auto/deepseek-v4.1-flash'],
  }],
  log: () => {},
})

// ⚠️ 故意不传 providerId —— 真实代码路径也没传
const p = new ModelDecisionProvider(
  { model: cfg.decision.model.model, maxTokens: 512, timeoutMs: 25000 },
  { llm, log: { warn: (m) => console.log(`  [warn] ${m}`) } },
)

const cases = [
  ['私聊：发图片问"是你吗"', '[图片]是你吗', true],
  ['私聊：能看见吗', '能看见吗', true],
  ['群里别人互聊', '你服务器配好了吗', false],
]

for (const [name, text, isPrivate] of cases) {
  const t0 = Date.now()
  try {
    const d = await p.decide({
      messages: [{ sender: '1', senderName: 'Null_zwei.', text, isMe: false, mentionsMe: false, at: 1 }],
      self: { qq: '3039392113', nickname: '蓝色大肥鱼' },
      scene: isPrivate ? { kind: 'private', userId: '1' } : { kind: 'group', groupName: '神秘黄豆群' },
      sinceMyLastMessage: 30000,
      consecutiveTurns: 0,
    })
    console.log(`  【${name}】${d.reply ? '发言' : '沉默'} verdict=${d.raw?.verdict} (${Date.now() - t0}ms)`)
  } catch (e) {
    console.log(`  【${name}】❌ ${e.message}`)
  }
}

console.log('\n  统计:', JSON.stringify(p.stats))
