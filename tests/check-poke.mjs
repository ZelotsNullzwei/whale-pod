/**
 * 戳一戳测试。
 *
 * OneBot（NapCat）的结构：
 *   收：{ post_type:'notice', notice_type:'notify', sub_type:'poke',
 *         group_id, user_id:<戳的人>, target_id:<被戳的人> }
 *   发：send_poke { group_id, target_id }
 *
 * 几个必须成立的行为：
 *   · 只理"戳我"的（别人互相戳、机器人自己戳别人 → 都不理）
 *   · 遵守白名单（不在名单里的群/人戳它 → 不理）
 *   · 有概率不理（保留真人感）
 *   · 戳回去用对参数（群聊带 group_id，私聊不带）
 */
import { QQBridge } from '../src/qq/bridge.js'

let pass = 0, fail = 0
const check = (n, ok, extra = '') => {
  if (ok) { pass++; console.log('  ✅ ' + n) }
  else { fail++; console.log('  ❌ ' + n + ' ' + extra) }
}

const SELF = '1000000001'
const GROUP = '200000001'
const POKER = '1000000002'

/** 造一个 bridge，记录所有发出的 action。 */
function mk(cfg = {}, opts = {}) {
  const calls = []
  const sent = []
  const br = new QQBridge({
    cfg: { allow: { private: [POKER], groups: [GROUP], allowAllWhenEmpty: false }, poke: {}, ...cfg },
    onebot: {
      connected: true,
      call: async (action, params) => {
        calls.push({ action, params })
        if (action === 'send_poke' && opts.pokeFails) return { status: 'failed', retcode: 100, message: 'no perm' }
        return { status: 'ok', retcode: 0 }
      },
      sendGroup: async (g, m) => { sent.push({ to: 'group:' + g, msg: m }); return { status: 'ok', retcode: 0 } },
      sendPrivate: async (u, m) => { sent.push({ to: 'private:' + u, msg: m }); return { status: 'ok', retcode: 0 } },
    },
    gateway: { providers: [], catalog: [], defaultModels: () => ({}) },
    decision: {}, memory: {}, persona: {},
    log: { info: () => {}, warn: () => {}, debug: () => {} },
  })
  br.selfId = SELF
  br.selfName = '蓝色大肥鱼'
  return { br, calls, sent }
}

const pokeEv = (o = {}) => ({
  post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
  group_id: GROUP, user_id: POKER, target_id: SELF, ...o,
})

console.log('=== 1. 戳我 → 戳回去 ===')
{
  const { br, calls } = mk({ poke: { chance: 1, textChance: 0 } })
  await br.onEvent(pokeEv())
  const p = calls.find((c) => c.action === 'send_poke')
  check('发出了 send_poke', Boolean(p), JSON.stringify(calls))
  check('群聊带 group_id', p?.params?.group_id === Number(GROUP), JSON.stringify(p?.params))
  check('target_id 是戳我的人', p?.params?.target_id === Number(POKER), JSON.stringify(p?.params))
  check('记录进了最近交互', br.recent.some((r) => r.text === '[戳一戳]' && r.outcome === 'poke-back'))
}

console.log('\n=== 2. 别的事件一律不理 ===')
{
  const cases = [
    ['别人互相戳（target 不是我）', pokeEv({ target_id: '999' }), 'send_poke'],
    ['机器人自己戳别人', pokeEv({ user_id: SELF }), 'send_poke'],
    ['群成员变动通知', { post_type: 'notice', notice_type: 'group', sub_type: 'increase', group_id: GROUP, user_id: '1' }, 'send_poke'],
    ['别的 notify 子类型', { post_type: 'notice', notice_type: 'notify', sub_type: 'honor', group_id: GROUP, user_id: POKER, target_id: SELF }, 'send_poke'],
  ]
  for (const [label, ev, forbidden] of cases) {
    const { br, calls } = mk({ poke: { chance: 1, textChance: 0 } })
    await br.onEvent(ev)
    check(`${label} → 不戳回去`, !calls.some((c) => c.action === forbidden), JSON.stringify(calls))
  }
}

console.log('\n=== 3. 白名单 ===')
{
  const { br, calls } = mk({ poke: { chance: 1, textChance: 0 } })
  await br.onEvent(pokeEv({ group_id: '111111' }))     // 不在白名单的群
  check('不在白名单的群 → 不理', calls.length === 0, JSON.stringify(calls))

  const { br: br2, calls: c2 } = mk({ poke: { chance: 1 } })
  await br2.onEvent({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: '88888888', target_id: SELF })
  check('不在白名单的人私聊戳 → 不理', c2.length === 0, JSON.stringify(c2))
}

console.log('\n=== 4. 概率：不是每次都理 ===')
{
  const { br } = mk({ poke: { chance: 0.5, textChance: 0 } })
  let replied = 0
  for (let i = 0; i < 400; i++) {
    const before = br.recent.length
    await br.onEvent(pokeEv())
    if (br.recent[0]?.outcome === 'poke-back') replied++
  }
  const rate = replied / 400
  check('理会概率接近配置值（0.5）', rate > 0.4 && rate < 0.6, rate.toFixed(3))
}

console.log('\n=== 5. chance=0 完全不理会；enabled=false 关掉 ===')
{
  const { br, calls } = mk({ poke: { chance: 0 } })
  // chance=0 时 Math.random() > 0 几乎总是成立
  for (let i = 0; i < 20; i++) await br.onEvent(pokeEv())
  check('chance=0 → 基本不理', !calls.some((c) => c.action === 'send_poke'), String(calls.length))

  const { br: br2, calls: c2 } = mk({ poke: { enabled: false, chance: 1 } })
  await br2.onEvent(pokeEv())
  check('enabled=false → 完全不动', c2.length === 0, JSON.stringify(c2))
}

console.log('\n=== 6. 戳回去之后可能补一句话 ===')
{
  const { br, sent } = mk({ poke: { chance: 1, textChance: 1, lines: ['干嘛'] } })
  await br.onEvent(pokeEv())
  check('配置的台词被发出', sent.some((s) => s.msg === '干嘛'), JSON.stringify(sent))
  check('发到群里', sent[0]?.to === 'group:' + GROUP, JSON.stringify(sent))

  const { br: br2, sent: s2 } = mk({ poke: { chance: 1, textChance: 0 } })
  await br2.onEvent(pokeEv())
  check('textChance=0 → 只戳回去不说话', s2.length === 0, JSON.stringify(s2))

  const { br: br3, sent: s3 } = mk({ poke: { chance: 1, textChance: 1, text: false } })
  await br3.onEvent(pokeEv())
  check('text=false → 即使 textChance=1 也不说话', s3.length === 0, JSON.stringify(s3))
}

console.log('\n=== 7. 私聊戳 ===')
{
  const { br, calls } = mk({ poke: { chance: 1, textChance: 0 } })
  await br.onEvent({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: POKER, target_id: SELF })
  const p = calls.find((c) => c.action === 'send_poke')
  check('私聊也能戳回去', Boolean(p), JSON.stringify(calls))
  check('私聊不带 group_id', p?.params?.group_id === undefined, JSON.stringify(p?.params))
  check('私聊 target_id 正确', p?.params?.target_id === Number(POKER), JSON.stringify(p?.params))
}

console.log('\n=== 8. 戳失败不影响其它功能 ===')
{
  const { br } = mk({ poke: { chance: 1, textChance: 0 } }, { pokeFails: true })
  let threw = false
  try { await br.onEvent(pokeEv()) } catch { threw = true }
  check('send_poke 失败不抛出去', threw === false)
  check('记为失败而不是成功', br.recent[0]?.outcome === 'poke-failed', JSON.stringify(br.recent[0]))
}

console.log('\n=== 9. 暂停时不理会戳 ===')
{
  const { br, calls } = mk({ poke: { chance: 1, textChance: 0 } })
  br.paused = true
  await br.onEvent(pokeEv())
  check('暂停中不戳回去', calls.length === 0, JSON.stringify(calls))
}

console.log('\n' + '='.repeat(46))
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
