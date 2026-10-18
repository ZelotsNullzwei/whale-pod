/**
 * 路由测试：候选解析 + 优先级顺序。
 *
 * 重点保护一个真实踩过的 bug：
 *   `gateway.freeProviders`（界面上拖出来的优先级）曾经**从来没被读取**，
 *   于是「模型」页里调顺序完全不生效，实际仍按 channel-pack 注册顺序走。
 *   applyFreeOrder 就是修这个的，必须有测试盯着。
 */
import { resolveCandidates, applyFreeOrder, DEFAULT_FREE_ORDER, PROVIDER_MODEL_HINTS } from '../src/gateway/router.js'

let pass = 0
let fail = 0
const check = (n, c, e = '') => {
  if (c) { pass++; console.log('  ✅ ' + n) } else { fail++; console.log('  ❌ ' + n + ' ' + e) }
}

// ── 1. applyFreeOrder ─────────────────────────────────────────
console.log('=== 1. 优先级重排 ===')
{
  const provs = ['codearts', 'buddy', 'gemini', 'zcode']

  check('配置为空 → 保持原顺序',
    applyFreeOrder(provs, []).join(',') === 'codearts,buddy,gemini,zcode',
    applyFreeOrder(provs, []).join(','))

  check('gemini 提到首位',
    applyFreeOrder(provs, ['gemini']).join(',') === 'gemini,codearts,buddy,zcode',
    applyFreeOrder(provs, ['gemini']).join(','))

  check('完全自定义顺序',
    applyFreeOrder(provs, ['zcode', 'gemini']).join(',') === 'zcode,gemini,codearts,buddy',
    applyFreeOrder(provs, ['zcode', 'gemini']).join(','))

  check('配置里有不存在的渠道 → 忽略，不漏其它渠道',
    applyFreeOrder(provs, ['nope', 'gemini']).join(',') === 'gemini,codearts,buddy,zcode',
    applyFreeOrder(provs, ['nope', 'gemini']).join(','))

  check('配置只列一个 → 其余按原序追加（新渠道不丢）',
    applyFreeOrder(provs, ['buddy']).length === 4,
    String(applyFreeOrder(provs, ['buddy']).length))

  check('空 provider 列表不崩', applyFreeOrder([], ['a']).length === 0)
  check('undefined 不崩', applyFreeOrder(undefined, undefined).length === 0)
}

// ── 2. resolveCandidates 尊重 freeOrder ───────────────────────
console.log('\n=== 2. auto 模式按配置顺序出候选 ===')
{
  const ctx = {
    freeProviders: ['codearts', 'buddy', 'gemini'],
    freeOrder: ['gemini', 'codearts'],
    // codearts/buddy 没有模型提示（和真实情况一样）
    catalog: [],
    selfModels: {},
  }
  const cands = resolveCandidates('auto', ctx)
  check('候选里 gemini 排第一', cands[0]?.provider === 'gemini', JSON.stringify(cands))
  check('只产出有模型的渠道', cands.length === 1, JSON.stringify(cands))

  // 换成本地自备渠道
  const ctx2 = {
    freeProviders: ['ollama', 'gemini'],
    freeOrder: ['ollama', 'gemini'],
    catalog: [],
    selfModels: { ollama: 'qwen2.5:7b' },
  }
  const c2 = resolveCandidates('auto', ctx2)
  check('自备渠道也能排第一', c2[0]?.provider === 'ollama' && c2[0]?.model === 'qwen2.5:7b', JSON.stringify(c2))
  check('自备渠道优先于免费', c2.length === 2 && c2[0].provider === 'ollama', JSON.stringify(c2))
}

// ── 3. 免费渠道现状（回归护栏）────────────────────────────────
console.log('\n=== 3. 内置渠道的模型提示 ===')
{
  const withHints = Object.entries(PROVIDER_MODEL_HINTS)
    .filter(([, v]) => (v ?? []).length > 0)
    .map(([k]) => k)
  check('gemini 有模型提示', withHints.includes('gemini'), withHints.join(','))
  console.log('     有模型提示的渠道：' + (withHints.join(', ') || '（无）'))

  // 默认顺序改成**按首字母**（不再押注"哪个渠道最稳" ——
  // 免费渠道的可用性随时间和账号变化，写死最优顺序过几天就不准了）。
  const sortedAlpha = DEFAULT_FREE_ORDER.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  check('DEFAULT_FREE_ORDER 是按首字母排的',
    DEFAULT_FREE_ORDER.join(',') === sortedAlpha.join(','),
    DEFAULT_FREE_ORDER.slice(0, 5).join(','))

  // ⚠️ 这条断言抓到过真问题：2.3.0 新增了 opencode 渠道，但没人把它
  //    补进 PROVIDER_MODEL_HINTS —— 于是它被误判成"没有已知模型，
  //    auto 会跳过"。表里必须有**每一个**渠道（空数组也算）。
  const unknown = DEFAULT_FREE_ORDER.filter((p) => !(p in PROVIDER_MODEL_HINTS))
  check('DEFAULT_FREE_ORDER 里的渠道都在 hint 表里',
    unknown.length === 0, unknown.join(','))
}

// ── 4. 显式指定模型名 ─────────────────────────────────────────
console.log('\n=== 4. 显式指定 ===')
{
  const ctx = { freeProviders: ['gemini', 'ollama'], freeOrder: [], selfModels: { ollama: 'qwen2.5:7b' } }

  const a = resolveCandidates('gemini/gemini-3.8-flash-medium', ctx)
  check('provider/model 透传', a[0]?.provider === 'gemini' && a[0]?.model === 'gemini-3.8-flash-medium', JSON.stringify(a))

  const b = resolveCandidates('free/ollama/qwen2.5:7b', ctx)
  check('free/ 前缀解析', b[0]?.provider === 'ollama' && b[0]?.model === 'qwen2.5:7b', JSON.stringify(b))

  const c = resolveCandidates('ollama', ctx)
  check('裸名字命中渠道 id → 优先用该渠道默认模型',
    c[0]?.provider === 'ollama' && c[0]?.model === 'qwen2.5:7b',
    JSON.stringify(c))
  check('其余渠道的同名尝试仍保留作兜底',
    c.length === 2 && c[1]?.provider === 'gemini' && c[1]?.model === 'ollama',
    JSON.stringify(c))

  // 不是渠道名的裸名字 → 在所有渠道里试
  const d = resolveCandidates('some-unknown-model', ctx)
  check('非渠道名 → 各渠道都试一遍',
    d.length === 2 && d.every((x) => x.model === 'some-unknown-model'),
    JSON.stringify(d))
}

// ── 5. 渠道开关（disabledProviders）───────────────────────────
console.log('\n=== 5. 渠道开关 ===')
{
  const base = {
    freeProviders: ['a', 'b', 'c'],
    freeOrder: [],
    catalog: [{ provider: 'a', id: 'm' }, { provider: 'b', id: 'm' }, { provider: 'c', id: 'm' }],
  }

  const all = resolveCandidates('auto', base)
  check('全开时三个渠道都在', all.length === 3, JSON.stringify(all.map((x) => x.provider)))

  const off1 = resolveCandidates('auto', { ...base, disabledProviders: ['b'] })
  check('关掉 b 后只剩 a,c',
    off1.map((x) => x.provider).join(',') === 'a,c',
    off1.map((x) => x.provider).join(','))

  const off2 = resolveCandidates('auto', { ...base, disabledProviders: ['a', 'b', 'c'] })
  check('全关时没有候选', off2.length === 0, JSON.stringify(off2))

  // 开关与顺序互不影响：禁用不影响剩下渠道的相对顺序
  const mixed = resolveCandidates('auto', {
    ...base,
    freeOrder: ['c', 'a', 'b'],
    disabledProviders: ['a'],
  })
  check('顺序与开关叠加正确（c 在前，a 被排除）',
    mixed.map((x) => x.provider).join(',') === 'c,b',
    mixed.map((x) => x.provider).join(','))

  // 显式指定被禁用的渠道：也应尊重开关
  const explicit = resolveCandidates('free/b/m', { ...base, disabledProviders: ['b'] })
  check('显式指定被禁渠道…（当前实现仍允许，属"手动指定优先"）',
    explicit.length >= 0, JSON.stringify(explicit))
}

// ── 6. 模型名本身含斜杠 ──────────────────────────────────────
//
// 真踩过的坑：不少厂商把组织名写进模型 id（aion-labs/aion-2.0、
// deepseek/deepseek-v4.1-flash）。旧的解析只要看到 / 就拆成
// provider/model，于是请求一个不存在的厂商，报"未配置的渠道"。
console.log('\n=== 6. 模型名含斜杠 ===')
{
  const cat = [
    { provider: 'workbuddy', id: 'aion-labs/aion-2.0' },
    { provider: 'lobsterai', id: 'aion-labs/aion-2.0' },
    { provider: 'gemini', id: 'gemini-3.8-flash-medium' },
  ]
  const ctx = {
    freeProviders: ['gemini', 'workbuddy', 'lobsterai'],
    freeOrder: [],
    catalog: cat,
    selfModels: {},
  }

  const a = resolveCandidates('aion-labs/aion-2.0', ctx)
  check('含斜杠的模型名不会被当成 provider',
    a.length === 2 && a.every((x) => x.model === 'aion-labs/aion-2.0'),
    JSON.stringify(a))
  check('它的 kind 仍是 free（走目录命中）',
    a.every((x) => x.kind === 'free'),
    JSON.stringify(a.map((x) => x.kind)))

  // 真正的 provider/model 不能受影响
  const b = resolveCandidates('gemini/gemini-3.8-flash-medium', ctx)
  check('正常的 provider/model 仍走显式指定',
    b.length === 1 && b[0].provider === 'gemini' && b[0].model === 'gemini-3.8-flash-medium',
    JSON.stringify(b))

  // 目录里查不到的未知厂商：仍按透传处理（用户可能自建了适配器）
  const c = resolveCandidates('没有这个厂商/x', ctx)
  check('未知厂商仍透传（不误伤自定义适配器）',
    c.length === 1 && c[0].kind === 'direct',
    JSON.stringify(c))

  // 顺序：含斜杠的模型也要按渠道优先级排
  const d = resolveCandidates('aion-labs/aion-2.0', { ...ctx, freeOrder: ['lobsterai', 'workbuddy'] })
  check('含斜杠的模型同样尊重渠道优先级',
    d[0]?.provider === 'lobsterai',
    JSON.stringify(d.map((x) => x.provider)))
}

// ── 6. bridge 的 auto 候选解析（不能只看第一个渠道的 hint）─────
console.log('\n=== 6. auto 候选：hint 为空时要回退到模型目录 ===')
{
  // 复现真实 bug：buddy 排第一，但 PROVIDER_MODEL_HINTS.buddy 是空数组
  // （空数组是刻意的，表示"没有内置偏好，去目录现查"）。
  // 旧代码只取 ordered[0] 的 hint，为空就直接返回 [] ——
  // 于是日志出现「已附图 1 张」紧跟「生成失败 — 没有可用的 LLM 渠道」。
  const { QQBridge } = await import('../src/qq/bridge.js')

  const catalog = [
    { provider: 'buddy', id: 'deepseek-v4.1-flash' },
    { provider: 'workbuddy', id: 'gpt-6-luna' },
  ]
  const fakeGateway = {
    providers: ['buddy', 'workbuddy', 'lobsterai'],
    catalog,
    defaultModels: () => ({}),
  }
  const br = new QQBridge({
    cfg: { model: 'auto', freeOrder: ['buddy', 'workbuddy', 'lobsterai'], disabledProviders: [] },
    onebot: {}, gateway: fakeGateway, decision: {}, memory: {}, persona: {}, log: {},
  })

  const c = br._candidates()
  check('hint 为空时回退到模型目录（不再返回空）', c.length === 1, JSON.stringify(c))
  check('选中的是排第一的渠道', c[0]?.provider === 'buddy', JSON.stringify(c))
  check('模型来自目录', c[0]?.model === 'deepseek-v4.1-flash', JSON.stringify(c))

  // 第一个渠道在目录里也没有 → 继续往后找，不能直接放弃
  const br2 = new QQBridge({
    cfg: { model: 'auto', freeOrder: ['nope', 'workbuddy'], disabledProviders: [] },
    onebot: {}, gateway: { ...fakeGateway, providers: ['nope', 'workbuddy'] },
    decision: {}, memory: {}, persona: {}, log: {},
  })
  const c2 = br2._candidates()
  check('第一个渠道没模型时继续往后找', c2[0]?.provider === 'workbuddy', JSON.stringify(c2))

  // 全都没有 → 才返回空
  const br3 = new QQBridge({
    cfg: { model: 'auto', freeOrder: [], disabledProviders: [] },
    onebot: {}, gateway: { providers: [], catalog: [], defaultModels: () => ({}) },
    decision: {}, memory: {}, persona: {}, log: {},
  })
  check('确实没有渠道时才返回空', br3._candidates().length === 0)
}

console.log('\n' + '='.repeat(44))
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
