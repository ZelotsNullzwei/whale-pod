/**
 * 讨钱要能找到人，而且要找对人（2026-11-07）。
 *
 * ## 现场
 * 用户看日志：
 * ```
 * proactive：余额 ¥1.46（阈值 ¥2） —— 偏低
 * proactive：没有白名单群，不讨钱
 * ```
 * 每小时刷一遍，钱一次都没讨出去。用户问「这是不是 bug」—— 是。
 *
 * ## 三个 bug（本节守前两个 + 选人）
 * ① `onBeg()` 只看 `cfg.allow.groups`，白名单为空就直接 return。
 *    而主动发言那条路（`computeScopes`）**早就**处理了
 *    「白名单为空 + allowAllWhenEmpty=true → 用实际聊过天的群」。
 * ② `interactions.json` 只由 shutdown 钩子写，而鲸鱼几乎每次都被硬杀
 *    → 文件一直是 `[]` → 「不知道该找谁」。
 * ③ 选人：用户定的口径是**按好感度**（「按照好感度呢」）：
 *    在「这个群里说过话的人」里挑好感度最高的几个。
 *
 * ## 守什么
 * - 白名单空 + allowAllWhenEmpty=true → 从**聊过天的群**里挑一个讨
 * - 白名单空 + allowAllWhenEmpty=false → 不讨（它谁也不理，别乱发）
 * - 白名单非空 → 只在白名单里挑
 * - 群有多个 → 挑「最近有人说话」的那个
 * - 候选人**按好感度排序**；不在群里说过话的人不能入选（@ 会落空）
 * - 真的 @ 出去的对象必须在好感度前 3 名内
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { QQBridge } from '../src/qq/bridge.js'
import { BegState, InteractionTracker } from '../src/qq/beg.js'

const p = QQBridge.prototype
let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}
async function okAsync(name, fn) {
  try { await fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wp-beg-'))

/**
 * 造一个能跑 startProactive 的最小 bridge。
 */
function mkBridge({ groups = [], allowAll = false, mems = {}, scopes = [], cny = 1.46 } = {}) {
  const dir = tmp()
  const begCalls = []
  const b = Object.assign(Object.create(p), {
    cfg: {
      home: dir,
      allow: { groups, private: [], allowAllWhenEmpty: allowAll },
      beg: { enabled: true },
      search: { lowBalanceCny: 2 },
      proactive: { inGroups: true, inPrivate: false },
    },
    log: { info: () => {}, warn: () => {}, debug: () => {} },
    selfId: '3039392113',
    _balance: { cny },
  })
  b._maybeBeg = async (msg, c) => { begCalls.push({ msg, cny: c }); return true }
  b.startProactive({
    home: dir,
    memoryOf: (s) => mems[s] ?? null,
    scopesSource: () => scopes,
  })
  return { b, begCalls, dir }
}

const memWith = (at) => ({ recent: (n) => (n > 0 ? [{ at, text: 'x' }] : []) })

console.log('=== 1. 白名单空 + allowAllWhenEmpty=true：这才是用户那台机器 ===')
await okAsync('★ 从「聊过天的群」里挑一个，真的去讨（旧代码这里直接 return false）', async () => {
  const { b, begCalls } = mkBridge({
    groups: [],
    allowAll: true,
    scopes: ['group:704291282', 'private:2129024700'],
    mems: { 'group:704291282': memWith(Date.now() - 60_000) },
  })
  const r = await b._proactive.onBeg()
  assert.equal(r, true, '没讨（onBeg 返回 false）')
  assert.equal(begCalls.length, 1, '没走到 _maybeBeg')
  assert.equal(begCalls[0].msg.groupId, '704291282')
  assert.equal(begCalls[0].msg.kind, 'group')
  assert.equal(begCalls[0].msg.scope, 'group:704291282')
})

console.log('\n=== 2. 白名单空 + allowAllWhenEmpty=false：谁也不理，就别乱发 ===')
await okAsync('★ 不讨（返回 false、没调用发送）', async () => {
  const { b, begCalls } = mkBridge({
    groups: [],
    allowAll: false,
    scopes: ['group:704291282'],
    mems: { 'group:704291282': memWith(Date.now() - 60_000) },
  })
  assert.equal(await b._proactive.onBeg(), false)
  assert.equal(begCalls.length, 0)
})

console.log('\n=== 3. 白名单非空：只在白名单里挑 ===')
await okAsync('★ 白名单只有 A，已知群有 A/B → 讨 A，不碰 B', async () => {
  const { b, begCalls } = mkBridge({
    groups: ['111'],
    allowAll: false,
    scopes: ['group:111', 'group:222'],
    mems: {
      'group:111': memWith(Date.now() - 120_000),
      'group:222': memWith(Date.now() - 1000),   // B 更近，但不能选它
    },
  })
  assert.equal(await b._proactive.onBeg(), true)
  assert.equal(begCalls.length, 1)
  assert.equal(begCalls[0].msg.groupId, '111')
})

console.log('\n=== 4. 多个群：挑最近有人说话的那个 ===')
await okAsync('★ 冷群和热群都有记录 → 选热的', async () => {
  const now = Date.now()
  const { b, begCalls } = mkBridge({
    groups: [],
    allowAll: true,
    scopes: ['group:111', 'group:222'],
    mems: {
      'group:111': memWith(now - 5 * 3600_000),
      'group:222': memWith(now - 60_000),
    },
  })
  assert.equal(await b._proactive.onBeg(), true)
  assert.equal(begCalls[0].msg.groupId, '222')
})

console.log('\n=== 5. 群都没有聊天记录：仍然不讨（不知道 @ 谁）===')
await okAsync('★ hasHistory 为假 → 不讨', async () => {
  const { b, begCalls } = mkBridge({
    groups: [],
    allowAll: true,
    scopes: ['group:111'],
    mems: { 'group:111': { recent: () => [] } },
  })
  assert.equal(await b._proactive.onBeg(), false)
  assert.equal(begCalls.length, 0)
})

console.log('\n=== 6. 源码锁：讨钱和主动发言必须共用同一套判定 ===')
ok('★ onBeg 里不能再有「只看 cfg.allow.groups」的写法', () => {
  const src = fs.readFileSync('D:/DSH WorkSpace/whale-pod/src/qq/bridge.js', 'utf8')
  // 注释里**引用**那句旧日志是允许的（记录 bug 现场），这里查真的还在打它的代码
  assert.ok(
    !src.includes("this.log.info?.('proactive：没有白名单群，不讨钱')"),
    '旧的日志调用还在 —— 说明还没改成 candidateGroupScopes',
  )
  assert.ok(src.includes('const candidateGroupScopes = ()'), '收口函数不在')
  const i = src.indexOf('onBeg: async () =>')
  assert.ok(src.slice(i, i + 1600).includes('candidateGroupScopes()'), 'onBeg 没用收口函数')
})

console.log('\n=== 7. 选人按好感度（2026-11-07：「按照好感度呢」）===')
ok('★ _begCandidates 按好感度排序，不看谁最近说话', () => {
  const b = Object.assign(Object.create(p), {
    selfId: '3039392113',
    memory: {
      get: () => ({
        recent: () => ([
          // 「最近说话的」1 分钟前说过话，但好感只有 50
          { isMe: false, sender: '11111', senderName: '最近说话的', at: Date.now() - 60_000 },
          // 「好感高的」1 小时前说过话，好感 140
          { isMe: false, sender: '22222', senderName: '好感高的', at: Date.now() - 3600_000 },
        ]),
      }),
    },
    people: { affinityOf: (id) => (String(id) === '22222' ? 140 : 50) },
  })
  const c = p._begCandidates.call(b, { scope: 'group:1' })
  assert.equal(c.length, 2)
  assert.equal(c[0].id, '22222', '好感高的没排第一')
  assert.equal(c[0].affinity, 140)
  assert.equal(c[1].id, '11111')
})

ok('★ 不在这个群里说过话的人不入选（哪怕好感 200）', () => {
  const b = Object.assign(Object.create(p), {
    selfId: '3039392113',
    memory: {
      get: () => ({ recent: () => ([{ isMe: false, sender: '11111', senderName: '群友', at: Date.now() }]) }),
    },
    people: { affinityOf: (id) => (String(id) === '99999' ? 200 : 50) },
    // 互动记录里有 99999，但他没在这个群里说过话 → @ 会落空，必须排除
    _interactions: {
      top: () => ([{ id: '99999', name: '别的人', lastAt: Date.now(), counts: [1, 2, 3] }]),
    },
  })
  const c = p._begCandidates.call(b, { scope: 'group:1' })
  assert.deepEqual(c.map((x) => x.id), ['11111'])
})

ok('★ 自己不能被选（好感再高也不行）', () => {
  const b = Object.assign(Object.create(p), {
    selfId: '3039392113',
    memory: {
      get: () => ({
        recent: () => ([
          { isMe: false, sender: '3039392113', senderName: '我自己' },
          { isMe: false, sender: '11111', senderName: '群友', at: 1 },
        ]),
      }),
    },
    people: { affinityOf: () => 50 },
  })
  const c = p._begCandidates.call(b, { scope: 'group:1' })
  assert.deepEqual(c.map((x) => x.id), ['11111'])
})

ok('★ _saveInteractions 真的写文件（硬杀也别丢）', () => {
  const dir = tmp()
  const tr = new InteractionTracker({})
  tr.hit('2129024700', '阿丙')
  const b = Object.assign(Object.create(p), { cfg: { home: dir }, log: {}, _interactions: tr })
  p._saveInteractions.call(b)
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'interactions.json'), 'utf8'))
  assert.ok(JSON.stringify(j).includes('2129024700'), '没写进去')
})

await okAsync('★ 端到端：真的 @ 出去了，而且 @ 的一定是好感度前 3 名', async () => {
  const dir = tmp()
  const sent = []
  const aff = { 1001: 140, 1002: 120, 1003: 100, 1004: 60, 1005: 50 }
  const b = Object.assign(Object.create(p), {
    cfg: { home: dir, search: { lowBalanceCny: 2 }, beg: { enabled: true } },
    log: { info: () => {}, warn: () => {}, debug: () => {} },
    selfId: '3039392113',
    onebot: {
      sendGroup: async (gid, payload) => { sent.push({ gid, payload }); return { message_id: 7 } },
    },
    _interactions: new InteractionTracker({}),
    _begState: new BegState({ file: path.join(dir, 'beg.json') }),
    people: { affinityOf: (id) => aff[String(id)] ?? 50 },
    memory: {
      get: () => ({
        recent: () => Object.keys(aff).map((id) => ({ isMe: false, sender: id, senderName: 'u' + id })),
      }),
    },
  })
  const r = await p._maybeBeg.call(b, { kind: 'group', groupId: '704291282', scope: 'group:704291282' }, 1.46)
  assert.equal(r, true, '_maybeBeg 没成功')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].gid, '704291282')
  const at = sent[0].payload.find((x) => x.type === 'at')
  const picked = String(at.data.qq)
  // decideBeg 会在「前 3 名里随机挑一个」，所以唯一能保证的是：
  // @ 到的人一定在好感度前 3 名（1001/1002/1003）
  assert.ok(['1001', '1002', '1003'].includes(picked), `@ 到了前 3 名之外的人：${picked}`)
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
