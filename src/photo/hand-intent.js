/**
 * 手部意图（hand intent）—— **唯一真源**（2026-11-10，v10 方案）
 *
 * 职责：
 *   ① `analyzeHands(scene)`：从场景文本判定「原动作需求」的手数（动作手 / 摆拍手）
 *   ② `capability(mode)`：模式的手部能力（占用手 / 可见持机手 / 上限）
 *   ③ `framingCapacity(name)`：取景能容纳的可见手数
 *   ④ `degradeToSingleHand(hp)`：白名单内的结构化单手降级（返回具体数值+左右手职责）
 *   ⑤ `planHands({...})`：纯决策（不读写全局），产出状态机结果
 *
 * ⚠️ 计数类型是 `0|1|2|null`，**null 表示未知，禁止任何地方用 `?? 0` 折算**。
 */

import { HAND_CONTRACTS } from './handContract.js'

/** 摆拍姿势动词（计入 poseHands，不计入 actionHands） */
const POSE_VERBS = /(比心|比耶|比个耶|挥手|摆手|叉腰|拎裙摆|提裙摆|摆姿势|托腮|捧脸|比个心)/
/** 动作必须两只手、且**没有合理单手替代**（不可降级） */
const NON_DEGRADABLE = /(抱(纸箱|箱子|大件|一箱|一摞|一叠)|搬(箱|柜|桌子)|撑伞|系鞋带|拆快递箱|拆箱|端(大碗|一大盆|大盆|锅|砂锅))/
/** 双手动作但有单手替代（可降级） */
const DEGRADABLE_TWO = /(双手比心|双手比耶|双手拎裙摆|双手叉腰|双手捧(小碗|杯|杯子)|双手拿)/

/** 动词 + 对象 → 双手（P2） */
const TWO_HAND_PAIRS = [
  /捧(着)?[^，。；\n]{0,6}(碗|盆|锅|花束|一摞书|一叠书)/,
  /抱(着)?[^，。；\n]{0,6}(纸箱|箱子|大件|一箱|一摞|一叠)/,
  /端(着)?[^，。；\n]{0,6}(大碗|一大盆|大盆|锅|砂锅)/,
  /* 2026-11-12：补“撑着伞/系着鞋带/搬着箱子”这类变体，否则落进 unknown 不降级 */
  /撑(着|起|开)?[^，。；\n]{0,3}伞/,
  /系(着|好|上)?[^，。；\n]{0,3}鞋带/,
  /(搬|抬)(着|起)?[^，。；\n]{0,4}(箱|柜|桌子|桌)/,
  /* 2026-11-12：切菜/炒菜这类实际要两只手的动作，也要退回单手 */
  /切(着)?[^，。；\n]{0,4}(菜|肉|水果|丝|片|葱|姜|蒜)/,
  /(炒菜|翻炒|炒(个|两个)?菜|包饺子|揉面|擀面)/,
  /(撑伞|系鞋带|拆快递|拆箱|搬箱)/,
]
/** 动词 + 对象 → 单手（P2） */
const ONE_HAND_PAIRS = [
  /端(着|在)?[^，。；\n]{0,8}(杯|杯子|小碗|碟|茶|碗)/,
  /(拿|提|拎|翻|点|刷|握|托|举着)[^，。；\n]{0,8}(杯|瓶|书|手机|袋|包|碗|筷子)/,
  /(翻书|翻页|刷手机|看手机|翻手机|端杯|端在手里|端在手上|拎在手里|提在手里|拿在手里)/,
  /(塑料袋|袋子|拎袋|纸袋|袋子|包|瓶子)[^，。；\n]{0,6}(拎|提|拿)/,
  /抓(着)?(扶手|栏杆|把手|吊环)/,
  /(洗碗|洗锅|洗菜|洗水果|洗手|洗脸|刷牙|吹头发|擦桌子|擦台面|拖地|扫地)/,
]
/** 显式数量 */
const EXPLICIT_TWO = /(双手|两只手|两手|左右手一起|左右手同时)/
const EXPLICIT_ONE = /(一只手|单手|单手版)/
/** 否定 */
const NEGATED = /(不用双手|别用两只手|不要双手|不必两只手|不用两只手)/

/**
 * 分析场景的手数需求。
 * @param {string} scene
 * @returns {{certainty:'known'|'unknown', actionHands:0|1|2|null, poseHands:0|1|2|null,
 *            negated:boolean, verb:string|null, object:string|null, evidence:string[], source:string}}
 */
export function analyzeHands(scene = '') {
  const text = String(scene ?? '')
  const ev = []
  const negated = NEGATED.test(text)
  if (negated) ev.push('negated')

  /* 摆拍动作优先分流（P4）：双手比心 → poseHands=2，绝不进 actionHands */
  if (POSE_VERBS.test(text)) {
    const verb = (text.match(POSE_VERBS) ?? [''])[0]
    ev.push('pose:' + verb)
    if (EXPLICIT_TWO.test(text) || /(双手|两只手|两手)/.test(text)) {
      return { certainty: 'known', actionHands: 0, poseHands: 2, negated, verb, object: null, evidence: ev, source: 'explicit' }
    }
    if (EXPLICIT_ONE.test(text)) {
      return { certainty: 'known', actionHands: 0, poseHands: 1, negated, verb, object: null, evidence: ev, source: 'explicit' }
    }
    /* 单独一个姿势词（如"比心"）默认单手比心 */
    return { certainty: 'known', actionHands: 0, poseHands: 1, negated, verb, object: null, evidence: ev, source: 'lexicon' }
  }

  /* P0/P1：否定 + 显式数量（显式最高权威） */
  if (EXPLICIT_ONE.test(text) || (negated && EXPLICIT_ONE.test(text))) {
    const verb = (text.match(ONE_HAND_PAIRS[0]) ?? [''])[0] || null
    ev.push('explicit:one')
    return { certainty: 'known', actionHands: 1, poseHands: 0, negated, verb, object: null, evidence: ev, source: 'explicit' }
  }
  if (negated) {
    return { certainty: 'unknown', actionHands: null, poseHands: null, negated, verb: null, object: null, evidence: ev, source: 'negated-unknown' }
  }
  if (EXPLICIT_TWO.test(text)) {
    const verb = (text.match(TWO_HAND_PAIRS[0]) ?? [''])[0] || null
    ev.push('explicit:two')
    return { certainty: 'known', actionHands: 2, poseHands: 0, negated, verb, object: null, evidence: ev, source: 'explicit' }
  }
  /* 否定但没有显式单手 → 未知（不擅自记 1） */
  if (negated) {
    return { certainty: 'unknown', actionHands: null, poseHands: null, negated, verb: null, object: null, evidence: ev, source: 'negated-unknown' }
  }

  /* P2：动词+对象词典 */
  for (const re of TWO_HAND_PAIRS) {
    if (re.test(text)) {
      const verb = (text.match(re) ?? [''])[0]
      ev.push('lexicon:two:' + verb.slice(0, 6))
      return { certainty: 'known', actionHands: 2, poseHands: 0, negated, verb, object: null, evidence: ev, source: 'lexicon' }
    }
  }
  for (const re of ONE_HAND_PAIRS) {
    if (re.test(text)) {
      const verb = (text.match(re) ?? [''])[0]
      ev.push('lexicon:one:' + verb.slice(0, 6))
      return { certainty: 'known', actionHands: 1, poseHands: 0, negated, verb, object: null, evidence: ev, source: 'lexicon' }
    }
  }

  /* P5：场景里**完全没提手/动作** → 已知不需要手（0/0，可正常生成） */
  const ANY_HAND = /(手(?!机)|抱|捧|端|拿|提|拎|夹|握|托|翻书|翻页|撑|系|拆|搬|比心|比耶|叉腰|摆姿势|抓)/
  if (!ANY_HAND.test(String(text).replace(/手机|随手|手边/g, ' '))) {
    return { certainty: 'known', actionHands: 0, poseHands: 0, negated, verb: null, object: null, evidence: ['no-action'], source: 'default-no-action' }
  }

  /* 提到手/动作但判不出具体手数 → unknown（禁止默认 0/1） */
  return { certainty: 'unknown', actionHands: null, poseHands: null, negated, verb: null, object: null, evidence: ['default-unknown'], source: 'default-unknown' }
}

/** 模式手部能力（唯一来源：HAND_CONTRACTS 的扩展字段） */
export function capability(mode) {
  const m = String(mode ?? '')
  const table = HAND_CONTRACTS
  const c = table[m]
  if (!c) return { mode: m, occupiesHand: false, holderVisible: false, maxVisibleHands: null, placeholder: true }
  return {
    mode: m,
    occupiesHand: c.occupiesHand === true,
    holderVisible: c.holderVisible === true,
    maxVisibleHands: c.maxVisibleHands === undefined ? null : c.maxVisibleHands,
    placeholder: c.status === 'placeholder_pending_product',
  }
}

/** 取景能容纳几只可见手（按取景名） */
export function framingCapacity(framingName = '') {
  const f = String(framingName ?? '')
  if (f === '面部特写' || f === '头肩') return 1
  return 2
}

/**
 * 结构化单手降级：只接受白名单内动作；返回具体数值与左右手职责。
 * 不在白名单 → 返回 null（调用方必须 skip，不得伪装成单手）。
 */
export function degradeToSingleHand(hp, { preferredHand = 'right' } = {}) {
  if (!hp || hp.certainty !== 'known') return null
  const poseMode = Number(hp.poseHands ?? 0) > 0
  const n = poseMode ? Number(hp.poseHands) : Number(hp.actionHands)
  if (n < 2) return null
  const other = preferredHand === 'right' ? 'left' : 'right'
  return {
    actionHands: poseMode ? 0 : 1,
    poseHands: poseMode ? 1 : 0,
    assignment: {
      [preferredHand]: { role: 'action', action: String(hp.verb || '动作').replace(/双手|两只手/g, '一只手') + '（单手版）' },
      [other]: { role: 'rest', action: '自然垂着或扶着支撑物' },
    },
    dropped: [{ hand: other, reason: '持机/取景只剩一只手可用' }],
  }
}

/**
 * 纯决策（v10 状态机）。所有外部依赖可注入，便于合成用例测试。
 *
 * @param {object} o
 * @param {object} o.hp analyzeHands 结果
 * @param {string} o.mode 当前模式
 * @param {string} o.framingName 当前取景名
 * @param {(m:string)=>(0|1|2|null)} o.capOf 模式可见手上限
 * @param {(m:string)=>number} o.framingCapOf 每个模式的取景容量
 * @param {string} [o.switchMode='tripod']
 * @param {boolean} [o.allowPending=false] 产品是否允许 cap=null 时临时生成
 */
export function planHands({ hp, mode, framingName, capOf, framingCapOf, placeholderOf, degradeImpl, switchMode = 'tripod', allowPending = false, allowUnknown = false }) {
  const SWITCHABLE = new Set(['first_person', 'front_selfie', 'mirror_selfie', 'rear_selfie', 'rear_object', 'face_closeup'])
  const capFor = (m) => (typeof capOf === 'function' ? capOf(m) : null)
  const fcapFor = (m, name) => (typeof framingCapOf === 'function' ? framingCapOf(m, name) : framingCapacity(name))

  const cap = capFor(mode)
  const fcap = fcapFor(mode, framingName)
  const capacity = cap == null ? null : Math.min(cap, fcap)

  const base = {
    mode,
    requestedNeed: null,
    effectiveNeed: null,
    capacityVisibleHands: capacity,
    finalVisibleHands: null,
    actionSatisfied: 'unknown',
    effective: null,
    assignment: null,
    dropped: [],
    switchedFrom: null,
    planVerified: false,
  }

  /* unknown：按 planner 的第一人称行为拍摄（不跳过），但**标记未验证**（2026-11-10 用户口径 A） */
  if (!hp || hp.certainty !== 'known') {
    return { ...base, status: 'unknown_fail_open', actionSatisfied: 'unknown', planVerified: false, canGenerate: true }
  }

  const holderVisibleNow = (m) => capability(m).holderVisible
  /* 占位规则（back_view）：不当作正式能力，一律跳过并标待产品 */
  if (typeof placeholderOf === 'function' && placeholderOf(mode)) {
    return { ...base, status: 'skipped_pending', actionSatisfied: 'n/a' }
  }

  const needOf = (m) => Number(hp.actionHands ?? 0) + Number(hp.poseHands ?? 0) + (holderVisibleNow(m) ? 1 : 0)
  const requestedNeed = needOf(mode)
  base.requestedNeed = requestedNeed

  /* cap 未定（video_call） */
  if (cap == null) {
    return { ...base, status: 'pending_product', actionSatisfied: 'unknown', canGenerate: allowPending === true }
  }

  if (requestedNeed <= capacity) {
    return {
      ...base,
      status: 'ok',
      effectiveNeed: requestedNeed,
      finalVisibleHands: Math.min(requestedNeed, capacity),
      actionSatisfied: 'satisfied',
      effective: { actionHands: hp.actionHands, poseHands: hp.poseHands },
      planVerified: true,
    }
  }

  /*
   * 冲突：按用户口径（2026-11-10 A）改为**「自拍 + 物体」半身**，双手动作降为单手。
   *   对镜场景保留 mirror_selfie（镜中可见持机手 1 + 动作 1 = 2 手，正好放得下）；
   *   其余改 front_selfie（持机手在画外，画面最多 1 只动作手）。
   */
  const selfieTarget = (mode === 'mirror_selfie') ? 'mirror_selfie' : 'front_selfie'
  let targetMode = mode
  let targetCapacity = capacity
  let switchedFrom = null
  if (SWITCHABLE.has(mode)) {
    const cap2 = capFor(selfieTarget)
    if (cap2 != null) {
      targetMode = selfieTarget
      targetCapacity = Math.min(cap2, fcapFor(selfieTarget, '半身'))
      switchedFrom = mode
    }
  }

  const need = needOf(targetMode)
  if (need <= targetCapacity) {
    base.requestedNeed = need
    return {
      ...base,
      status: switchedFrom ? 'switched_ok' : 'ok',
      mode: targetMode,
      capacityVisibleHands: targetCapacity,
      requestedNeed: need,
      effectiveNeed: need,
      finalVisibleHands: Math.min(need, targetCapacity),
      actionSatisfied: 'satisfied',
      effective: { actionHands: hp.actionHands, poseHands: hp.poseHands },
      switchedFrom,
      planVerified: true,
    }
  }

  /* 仍放不下 → 白名单降级（显式结果，不推断） */
  const eff = (typeof degradeImpl === 'function' ? degradeImpl : degradeToSingleHand)(hp)
  if (!eff) {
    return { ...base, status: 'skipped_conflict', mode: targetMode, capacityVisibleHands: targetCapacity, switchedFrom, actionSatisfied: 'n/a' }
  }
  const effNeed = eff.actionHands + eff.poseHands + (holderVisibleNow(targetMode) ? 1 : 0)
  if (effNeed > targetCapacity) {
    return { ...base, status: 'skipped_conflict', mode: targetMode, capacityVisibleHands: targetCapacity, switchedFrom, effective: eff, actionSatisfied: 'n/a' }
  }
  return {
    ...base,
    status: 'degraded_action',
    mode: targetMode,
    capacityVisibleHands: targetCapacity,
    effectiveNeed: effNeed,
    finalVisibleHands: Math.min(effNeed, targetCapacity),
    actionSatisfied: 'degraded',
    effective: { actionHands: eff.actionHands, poseHands: eff.poseHands },
    assignment: eff.assignment,
    dropped: eff.dropped,
    switchedFrom,
    planVerified: true,
  }
}

export const __internals = { POSE_VERBS, NON_DEGRADABLE, DEGRADABLE_TWO, TWO_HAND_PAIRS, ONE_HAND_PAIRS }
