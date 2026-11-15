/**
 * 统一入口：一次拍摄的完整决策链
 *
 *   生活事件 → 拍摄动机 → 拍摄方式 → 相机位置 → 人物动作 → 构图 → 提示词
 *
 * 调用方（bridge.js）只需要：
 *   const shot = planShot({ scene, slot, outfit, hair, weather, mood, scope, request })
 *   if (shot.skip) { 不画 }
 *   generateImage({ prompt: shot.prompt, refImage: shot.refImage, size: shot.size })
 *
 * 这样 bridge.js 里原来那一大坨 drawPrompt 就可以整段替换掉。
 */

import { MODES } from './photo-modes.js'
import { planPhoto, shouldSkipPhoto, planIntent, projectMode } from './photo-planner.js'
import { validatePhotoPlan, applyFix } from './photo-validator.js'
import { composeFraming } from './photo-composer.js'
import { composePhotoPrompt } from './photo-prompt.js'
import { PhotoContinuity, detectLocation } from './photo-continuity.js'
import { fallbackText } from './character-profile.js'
import { pickEmotion, renderExpression, ExpressionHistory } from './photo-expression.js'
import { canonFor } from './canon.js'
import { buildShotPlan } from './plan-photo-v3.js'
import { resolveReference } from './reference-manager.js'
import { analyzeHands, planHands, capability, framingCapacity } from './hand-intent.js'
import { needsActionDetail, actionForScene } from './action-pool.js'
import { validatePrompt } from './prompt-validator.js'
import fs from 'node:fs'
import crypto from 'node:crypto'

/** A 版身体基准的完整 SHA256（version-a-original-body/body-3view.png） */
export const A_BODY_SHA256 = 'f75c7d779c173f738e18e11fe236b637c272626de4627e32f34c372c21279d69'

/**
 * B 版身体基准的完整 SHA256（2026-11-10）。
 *
 * 来源：用户新提供的「无头饰、写实」六格三视图，按白缝切成单图后，
 * 取**正面全身**那张（`_scratch/refs/her-body-front.png`）作为 B 版身体基准。
 *
 * ⚠️ 认的是**文件内容的完整 SHA256**，不是配置字段、不是文件名：
 *    · 换一张图/重新裁一次 → 哈希变了 → 仍判 UNKNOWN（fail closed，绝不猜）
 *    · 想启用新版本，必须把新文件的 SHA256 显式登记在这里
 */
export const B_BODY_SHA256 = '0c014113d427cb1675057dfff2695b2e0b0a2b6651696dfbe62041744ab7cb0a'

/**
 * 由**文件内容**判定 body 参考图版本（不读配置、不猜）。
 * @param {string} p 文件路径
 * @returns {''|'A'|'B'|'UNKNOWN'} 空路径 → ''；匹配基准 → 'A'/'B'；其余 → 'UNKNOWN'
 */
export function bodyRefVersionOf(p) {
  if (!p) return ''
  try {
    const h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
    if (h === A_BODY_SHA256) return 'A'
    if (h === B_BODY_SHA256) return 'B'
    return 'UNKNOWN'
  } catch { return 'UNKNOWN' }
}

/** 全局唯一的连续性记录器（进程内有效） */
export const continuity = new PhotoContinuity()
/** 表情防重复记录 */
export const expressionHistory = new ExpressionHistory()

/**
 * @param {object} o
 * @param {string} o.scene       她写的场景（`[画图:]` 内容）
 * @param {string} [o.slot]      当前时段 id
 * @param {string} [o.outfit]    今天穿着
 * @param {string} [o.hair]      今天发型
 * @param {string} [o.weather]
 * @param {string} [o.mood]
 * @param {string} [o.request]   用户原话（"看看你/自拍/站起来"）
 * @param {string} [o.scope]     会话标识（private:xxx / group:xxx）
 * @param {boolean} [o.sceneOnly] `[场景图:]`
 * @param {boolean} [o.anime]    `[插画:]`
 * @param {object} [o.imageCfg]  qq.image 配置（取 faceRef / bodyRef 路径）
 * @returns {{
 *   skip:boolean, skipReason:string,
 *   mode:string, modeLabel:string, framing:string,
 *   prompt:string, refImage:string, size:string,
 *   issues:Array, fixedFrom?:string, fixReason?:string, continuityStrength?:string,
 *   plan:object, framingInfo:object,
 * }}
 */
export function planShot(o = {}) {
  let {
    scene = '', slot = 'afternoon', outfit = '', hair = '', weather = '', mood = '',
    request = '', scope = '', sceneOnly = false, anime = false, imageCfg = {}, bodyOverride = '',
    mode = 'daily',   // V3 第三层：daily(默认) | close —— 带默认值，旧调用行为不变
    forceMode = '',   // 说说配图用：按"拍摄动机"显式指定模式（front_selfie / mirror_selfie …）
    subjectMode = '', // v2：person | first_person | object | environment（空则由 mode/sceneOnly 推导）
    forceFraming = '', // 显式指定最终景别（如对镜穿搭固定半身；'' = 由 composer 决定）
    faceOnlyRef = false, // 有固定外出服时：只喂脸参考，避免身体参考把衣服带偏
  } = o

  /* ① 该不该拍（没有值得分享的内容就不拍） */
  const last = continuity.peek(scope)
  const skipCheck = shouldSkipPhoto({ scene, lastScene: last?.lastScene ?? '' })
  if (skipCheck.skip) {
    /*
     * ⚠️ 早退分支**必须把字段补全**（2026-11-06 修）。
     * 以前只返回 5 个字段，调用方读 `shot.emotion` / `shot.framing` / `shot.issues`
     * 就全是 undefined（日志里打成 "undefined"，排查时一头雾水）。
     */
    return {
      skip: true,
      skipReason: skipCheck.reason,
      mode: '',
      modeLabel: '不拍',
      framing: '',
      prompt: '',
      refImage: '',
      size: '',
      issues: [],
      emotion: '',
      emotionId: '',
      continuityStrength: last ? (last.strength ?? '') : '',
      plan: {},
      framingInfo: {},
    }
  }

  /*
   * ★ 2026-11-12 用户：「双手才做得完的动作直接拍物」。
   *   切菜/炒菜/揉面这类，第一人称单手根本不成立 —— 改成**纯物品照**（无人无手），
   *   比让模型硬画"一只手切菜"稳定。只影响这些动作，其他场景不动。
   */
  const OBJ_ACTION = /(切(着)?(菜|肉|水果|丝|片|葱|姜|蒜)|炒(着)?菜|包饺子|揉面|擀面|拆快递箱|拆箱)/.test(String(scene))
  /*
   * ★ 2026-11-12 用户方案 2：第一人称「要用手操作」的场景（挑饮料/翻找/拿取）
   *   混元画手不稳定（偏男性、多手）—— 改成纯物品照，只拍台面物品，不再画手。
   *   ⚠️ 例外：明确要拍人（全身/自拍/穿搭），以及吃/喝（第一人称本来就是看碗，手不抢镜）不转换。
   */
  const handScene = String(scene)
  const wantsPerson = /(全身|自拍|穿搭|这一身|站直|拍我|看看我)/.test(handScene)
  const eatingDrinking = /(吃|喝|尝|端(着|起)|夹(起|菜))/ .test(handScene)
  const HAND_ACTION = !wantsPerson && !eatingDrinking
    && /(挑(选|饮料|东西|货)|翻找|翻(货架|包|抽屉)|(拿|取)(着|起|一瓶|一盒|件|瓶)|伸手|拎(起|着)|抓(起|着)|递)/.test(handScene)
  if ((OBJ_ACTION || HAND_ACTION) && !sceneOnly) {
    const isHand = !OBJ_ACTION && HAND_ACTION
    sceneOnly = true
    subjectMode = 'object'
    forceMode = 'rear_selfie'
    /* 换成"好看的成品物照"，别只拍一把孤零零的刀 */
    if (/切/.test(scene)) scene = '砧板上切好的胡萝卜和青菜、一把菜刀、旁边一小碗切好的菜，厨房台面干净整洁；只拍这些物品，画面里没有人也没有手'
    else if (/炒/.test(scene)) scene = '锅里翻炒好的菜、锅铲和灶台，热气自然，厨房台面干净；只拍这些物品，画面里没有人也没有手'
    else if (isHand) scene = `${scene}——只拍这些物品和台面/货架，像拍物一样俯拍，画面里没有人、没有手`
    else scene = `${scene}（改成拍物：只拍这件事相关的物品和台面，画面里没有人、没有手）`
  }

  /*
   * ★ 动作池：模糊动作（伸懒腰/护肤/化妆…）补一条**具体、单手成立**的动作描写，
   *   否则模型容易退化成坐着/对镜自拍。2026-11-12 用户「动作补充任务」。
   */
  let actionSpec = null
  if (!sceneOnly && needsActionDetail(scene)) {
    const act = actionForScene(scene)
    if (act) {
      actionSpec = act
      scene = act.replacesScene ? act.scene : `${scene}；${act.scene}`
      if (act.mode) forceMode = act.mode
      if (act.mode === 'mirror_selfie') forceFraming = '三分之二身'
    }
  }

  /* 2026-11-15：给 planner 的 scene 先剔除"不要出现镜子/别拍到镜子"这类否定语境，
     否则 planner 看到"镜子"二字就把前置自拍判成镜子自拍（图文对不上的根因）。 */
  const sceneForPlan = String(scene).replace(/不(?:要|用|出现|拍|带)[^，。；,\n]{0,6}镜[子面]?/g, '')
  /* ② 规划拍摄方式 */
  let plan = planPhoto({ scene: sceneForPlan, slot, sceneOnly, anime })
  if (actionSpec) plan.actionSpec = actionSpec

  /*
   * ★★ **V3.0 影子对比**（2026-11-08，GPT 建议的低风险接入）：
   *
   * 新 intent **只算不用** —— 行为完全不变，只把「新逻辑会判成什么、跟旧的差在哪」
   * 记录到 `shot.plan.__v3Shadow`，供调用方打日志 / 观察一段时间。
   * 确认零意外之后，再切成真正使用 projectMode(intent)。
   */
  try {
    const __intent = planIntent({ scene, slot, sceneOnly })
    /* camera=null 表示"新逻辑认为还需上下文决定"，不要用 fallback 伪装成 mode */
    const __resolved = Boolean(__intent && __intent.camera && __intent.camera.mode)
    const __shadowMode = __resolved ? projectMode(__intent) : null
    plan.__v3Shadow = {
      intent: __intent,
      shadowMode: __shadowMode,
      modeDiff: __resolved ? __shadowMode !== plan.mode : false,
      unresolved: __intent && __intent.diagnostics ? __intent.diagnostics.unresolved : [],
      resolved: __resolved,
    }
  } catch (e) {
    plan.__v3Shadow = { error: String(e && e.message ? e.message : e) }
  }

  /* ③ 物理可行性检查 + 自动修正 */
  const loc = detectLocation(scene)
  // 2026-11-15：先剔除"不要出现镜子/别拍到镜子/不要镜子"这类否定语境，
  // 否则 homeEnvelope 给前置自拍加的"画面里不要出现镜子"里的"镜子"会被误判成"要照镜子"，
  // 把前置自拍硬掰成镜子自拍·全身（图文对不上的根因）。
  const sceneNoNegMirror = String(scene).replace(/不(?:要|用|出现|拍|带)[^，。；,\n]{0,6}镜[子面]?/g, '')
  const hasMirror = /(镜子|照镜子|穿衣镜|镜前|对着镜子|镜子里|对镜自拍)/.test(sceneNoNegMirror) || loc.id === 'mirror'
  const check = validatePhotoPlan(plan, {
    scene, hasMirror, timeOfDay: slot,
    /* ★ 2026-11-07：判断"他想看身形"要看那句请求，光看场景不够 */
    request,
  })
  plan = applyFix(plan, check.fix, MODES)

  /*
   * ★ 显式拍摄动机（2026-11-11）：说说配图按"自拍/穿搭"指定模式，
   *   覆盖 planner/validate 的选择（但仍走后面的手数/取景/参考图流程）。
   */
  /* 2026-11-12：first_person 不在 MODES 里，单独处理；否则会被当成前置自拍画出整个人 */
  if (forceMode === 'first_person') {
    plan = {
      ...plan,
      mode: 'first_person', modeLabel: '第一人称', shooter: '她自己', device: '手机后置',
      faceVisible: false, needsCharacterRef: false,
      fixedFrom: plan.mode, fixReason: '说说配图：第一人称视角',
    }
  }

  if (forceMode && MODES[forceMode]) {
    const tm = MODES[forceMode]
    plan = {
      ...plan,
      mode: tm.id, modeLabel: tm.label, shooter: tm.shooter, device: tm.device,
      camera: tm.camera, look: tm.look, framing: tm.framing, rules: tm.rules, needs: tm.needs,
      faceVisible: ['front_selfie', 'mirror_selfie', 'video_call'].includes(tm.id),
      needsCharacterRef: ['front_selfie', 'mirror_selfie', 'video_call'].includes(tm.id),
      fixedFrom: plan.mode, fixReason: '说说配图：按拍摄动机指定模式',
    }
  }

  /*
   * ★ 姿势可行性（2026-11-06 用户：「e 的身体逻辑都不对」）：
   *   躺着 + 举手机自拍是矛盾的 —— 实测把"躺着/伸手/托脸"三件事粘一起，身体崩了。
   *   现实里醒来是**靠着床头坐起来**再举手机。
   */
  const selfieMode = plan.mode === 'front_selfie' || plan.mode === 'mirror_selfie' || plan.mode === 'video_call'
  let sceneFixed = String(scene)
  if (selfieMode && /(躺在|躺着|窝在被子里|窝在被子|趴着|还没起来)/.test(sceneFixed)) {
    /*
     * 躺姿自拍是成立的，只是要写清楚：身体躺着、一只手把手机举在脸侧。
     * 不写清楚模型会把"躺着 + 伸手 + 托脸"粘成一个崩掉的姿势。
     */
    sceneFixed = `${sceneFixed}（姿势：她**躺着/半靠在枕头上**，一只手把手机举在脸侧拍，
      另一只手自然放在被子或腿上；被子盖到腰以下。手臂要和肩膀连得上，别出现第二条手臂）`
  }

  /* ④ 构图 */
  /*
   * ★ 连身睡裙要给到三分之二身（2026-11-06 实测）：
   *   半身 + 被子盖住下半身 → 模型只看到上衣，把睡裙画成了灰 T 恤。
   */
  const needSkirtVisible = /连身.*睡裙/.test(String(outfit ?? ''))
  let framing = composeFraming(plan, {
    request: needSkirtVisible ? `${request} 看看这一身` : request,
    /* ★ 场景也传进去：她会自己写「怼脸特写」而用户只说了「看看你的脸」（2026-11-06） */
    scene,
  })
  /* v2：唯一最终景别可被显式指定（对镜穿搭固定半身，避免全身用身体参考导致脸漂） */
  if (forceFraming) {
    framing = { ...framing, framing: forceFraming, feet: forceFraming === '全身', desc: forceFraming === '半身' ? '半身（到腰胯）' : (framing.desc ?? forceFraming) }
  }

  /*
   * ★★ 手部契约决策（2026-11-10 v10）：唯一真源 `hand-intent`
   *   · actionHands/poseHands 只由文本判定；容量由模式上限 + 取景容量决定
   *   · 需要换模式时（双手动作 + 手持模式）用**新模式**的契约与取景重算
   *   · unknown（抱枕头等）不改模式、不算验证通过
   */
  /* 主体类型：object/environment 不注入人物相关模块（2026-11-11 v2） */
  const subjectModeFinal = subjectMode
    || (sceneOnly ? 'object' : (plan.mode === 'rear_selfie' ? 'object' : (plan.mode === 'first_person' ? 'first_person' : 'person')))
  const handPlan = (subjectModeFinal === 'object' || subjectModeFinal === 'environment')
    ? { certainty: 'known', actionHands: 0, poseHands: 0, negated: false, verb: null, object: null, evidence: ['subject_' + subjectModeFinal], source: 'subject-mode' }
    : (sceneOnly
      ? { certainty: 'known', actionHands: 0, poseHands: 0, negated: false, verb: null, object: null, evidence: ['scene_only'], source: 'scene-only' }
      : analyzeHands(scene))
  const handDecision = planHands({
    hp: handPlan,
    mode: plan.mode,
    framingName: framing.framing,
    capOf: (m) => capability(m).maxVisibleHands,
    placeholderOf: (m) => capability(m).placeholder,
    framingCapOf: (m, name) => {
      if (m === plan.mode) return framingCapacity(name)
      const mp = MODES[m]
      if (!mp) return framingCapacity(name)
      const f2 = composeFraming({ ...mp }, { request, scene })
      return framingCapacity(f2.framing)
    },
  })

  /* 换模式（tripod）：必须重算取景与容量 */
  if (handDecision.mode && handDecision.mode !== plan.mode && plan.mode !== 'first_person') {
    const tm = MODES[handDecision.mode]
    plan = {
      ...plan,
      mode: tm.id, modeLabel: tm.label, shooter: tm.shooter, device: tm.device,
      camera: tm.camera, look: tm.look, framing: tm.framing, rules: tm.rules, needs: tm.needs,
      needsCharacterRef: true, faceVisible: true,
      fixedFrom: plan.mode, fixReason: '双手动作 → 自拍+物体（动作降为单手）',
    }
    /* 场景里的"双手/两只手"要同步改成一只手，否则提示词自相矛盾 */
    sceneFixed = String(sceneFixed).replace(/双手/g, '一只手').replace(/两只手/g, '一只手')
    framing = composeFraming(plan, { request: needSkirtVisible ? `${request} 看看这一身` : request, scene })
  }

  /*
   * ★ 降级成单手时，无论有没有换模式、也不管是不是第一人称，场景文本都要把
   *   "双手/两只手"改成"一只手"（2026-11-12 用户：「动作全部退回成单手」）。
   *   现场：对镜双手比心 → 模式没换（mirror），场景仍是"双手比心"，
   *   模型就画了 手机手 + 两只比心手 = 3 只手（2026-11-10 用户抓到的）。
   */
  if (handDecision.status === 'degraded_action') {
    let sf = String(sceneFixed).replace(/双手/g, '一只手').replace(/两只手/g, '一只手')
    /*
     * 2026-11-12：「切菜/炒菜/捧碗」这类词本身就在暗示两只手，光改手数不够。
     *   把动作本身改写成**单手也成立**的说法，否则模型照样画两只手。
     */
    const REWRITE = [
      [/切(着)?(菜|肉|水果|丝|片|葱|姜|蒜)/g, (m, _z, o) => `一只手用刀切砧板上已经放稳的${o}`],
      [/炒(着)?菜/g, '一只手拿锅铲翻炒锅里的菜'],
      [/捧(着)?(一碗|碗|一盆|盆)/g, (m, _z, o) => `一只手托着${o}`],
      [/抱(着)?(一个|一只)?(纸箱|箱子|大件)/g, (m, _z, _q, o) => `一只手抱着${o}`],
      [/端(着)?(大碗|一大盆|大盆|锅|砂锅)/g, (m, _z, o) => `一只手端着${o}`],
    ]
    for (const [re, rep] of REWRITE) sf = sf.replace(re, rep)
    sceneFixed = sf
  }

  /*
   * ★ 抱物/卧床（unknown 手数）**仍用第一人称**，但场景必须改写成 POV 写法：
   *   主体=怀里抱着的那个东西（占前景）+ 画面一侧一只手搭着，镜头在她眼位朝下，
   *   看不到她本人（2026-11-10 用户给的两版 GPT 参考图）。
   *   只写"抱着枕头靠在床头"会被模型拍成桌面/食物（动作丢失）。
   */
  if (handDecision.status === 'unknown_fail_open' && plan.mode === 'first_person'
      && /(抱|搂|怀里|窝在|靠|躺)/.test(String(scene ?? ''))) {
    const m = String(scene).match(/(?:抱着|搂着|怀里抱着|抱着一只|抱着一个)\s*([^，。；\n]{1,14})/)
    const obj = (m && m[1] ? m[1] : '抱枕').replace(/^(一只|一个|一条)/, '')
    sceneFixed = `她低头看着**怀里抱着的一只${obj}**：它占据画面**前景主体**，绒面材质清晰可见；`
      + '画面**左下方出现她的一只手**，轻轻搭在它边缘、手指自然弯曲（符合抱着它的动作）；'
      + '镜头就在她的双眼位置、朝下看，画面里只有这个物体、她的手和床铺/被褥，'
      + '**看不到她本人（没有脸、头发、肩膀、上半身）**。'
  }

  /* 无法生成的情形：明确 skip（不得静默按 ok 生成） */
  const handSkip = handDecision.status === 'skipped_conflict' || handDecision.status === 'skipped_pending' || handDecision.status === 'skipped_unknown'
    || (handDecision.status === 'pending_product' && handDecision.canGenerate !== true)
  if (handSkip) {
    const skipReason = handDecision.status === 'skipped_pending'
      ? 'back_view_capture_pending'
      : (handDecision.status === 'skipped_unknown' ? 'hand_unknown_deferred' : 'hand_conflict_unsolvable')
    return {
      skip: true,
      skipReason,
      mode: plan.mode,
      modeLabel: plan.modeLabel,
      framing: framing.framing,
      prompt: '',
      refImage: '',
      refDecision: null,
      posePlan: null,
      size: imageCfg.size,
      issues: check.issues,
      fixedFrom: plan.fixedFrom,
      fixReason: plan.fixReason,
      continuityStrength: last ? (last.strength ?? '') : '',
      emotion: '',
      emotionId: '',
      plan,
      framingInfo: framing,
      handPlan,
      handDecision,
      handStatus: handDecision.status,
      actionSatisfied: handDecision.actionSatisfied,
      planVerified: handDecision.planVerified,
    }
  }

  /* ⑤ 表情：先看他说了什么，再看场景/心情/时段，并防止和上一张重复 */
  const expression = pickEmotion({
    request,
    scene,
    mood,
    slot,
    lastEmotion: expressionHistory.last(scope),
  })
  expressionHistory.set(scope, expression.id)

  /* ⑥ 参考图：按"人要不要出现在画面里"决定 */
  /*
   * ★★ **定妆照优先**（2026-11-06 A 方案）。
   *
   * 文字锁压不住款式漂移和"长出两条尾巴"（实测加了最硬的措辞仍然翻车），
   * 所以对**指定过的衣服**改用图生图：`<数据目录>/canon.json` 里按正则匹配
   * 衣柜原文，命中就把那张定妆照当参考图，只对齐「款式 + 体型 + 尾巴数量」。
   * 没配 canon 的衣服走老路（日常穿搭未受影响）。
   */
  const baseRef = pickRefImage(plan, framing, imageCfg, anime)
  const canon = sceneOnly ? null : canonFor(String(outfit ?? ''))
  /*
   * ★★ P1-1b 第 5 步（5B）：参考图选择的唯一决策走 reference-manager。
   *   · 开关：只有配置了 `qq.image.faceRef` 才启用；anime 档一律走旧逻辑
   *   · sceneOnly / needsCharacterRef===false → 明确映射为"无人物"，不只看 plan.mode
   *     （实测：sceneOnly 的 plan.mode 是 rear_selfie，直接透传会被当成拍物模式）
   *   · canon 元数据来自**命中条目自身**（canonFor 透传），不用全局 imageCfg 伪造
   *   · bodyRef 用真实配置字段 bodyRefImage；其版本经 sha256 校验等于 A 版 body
   */
  /*
   * body 参考图版本：**只由文件内容决定**，不允许配置覆盖。
   *   · 完整 SHA256 与 A 版基准一致 → A
   *   · 其他/读不到 → UNKNOWN（resolver 判 body_version_invalid 并拒绝，绝不猜）
   */
  const BODY_REF_VERSION = bodyRefVersionOf(String(imageCfg.bodyRefImage ?? ''))
  const resolverMode = (sceneOnly || subjectModeFinal === 'object' || subjectModeFinal === 'environment' || plan.needsCharacterRef === false)
    ? 'scene_only'
    : (plan.mode === 'rear_selfie' ? 'rear_object' : plan.mode)
  const refDecision = (!anime && imageCfg.faceRef)
    ? resolveReference({
        outfitText: String(outfit ?? ''),
        outfitId: '',                    // 当前日程服装没有稳定 ID → 走完整文本比较
        canon: canon
          ? { file: canon.file, outfitId: canon.outfitId, outfitText: canon.outfitText, version: canon.version }
          : null,
        faceRef: String(imageCfg.faceRef),
        faceRefKind: String(imageCfg.faceRefKind ?? 'unknown'),
        mode: resolverMode,
        characterVersion: imageCfg.characterVersion ?? '',
        bodyRef: String(imageCfg.bodyRefImage ?? ''),
        bodyRefVersion: BODY_REF_VERSION,
        /* 构图档：头肩/面部特写要用头像，不能用全身图（2026-11-10） */
        framing: String(framing?.framing ?? ''),
      })
    : null
  /* resolver 启用时：它的决定就是最终决定（fallback 也不偷偷退回旧 refImage） */
  let refImage = refDecision ? (refDecision.refImage || '') : (canon ? canon.file : baseRef)
  /*
   * ★ 对镜自拍"人设优先"（2026-11-11）：半身/三分之二/局部用**脸参考**锁长相；
   *   只有明确全身（秀穿搭）才用身体参考。全身用身体图脸会漂。
   */
  /*
   * ★ 自拍/对镜一律"脸参考优先 + 身体参考一起喂"（2026-11-11 用户：
   *   「眼睛怎么一会黑一会蓝」）。身体参考那张全身图眼睛偏深，
   *   只喂它就会把蓝瞳画成深色；脸图放第一位锁五官。
   */
  const __personModes = ['front_selfie', 'mirror_selfie']
  if (!anime && plan.mode === 'mirror_selfie' && framing?.framing !== '全身' && imageCfg.faceRef && refDecision?.strategy !== 'canon') {
    refImage = String(imageCfg.faceRef)
  }
  /* 2026-11-12 用户：每次都要把脸部参考图喂给模型（压 CG 感、锁同一张脸） */
  const __facePerson = !anime && imageCfg.faceRef && plan.needsCharacterRef !== false && !sceneOnly && subjectModeFinal === 'person'
  /*
   * ★ 2026-11-12 修：身体参考只在「身体入画的构图」才追加。
   *   之前不判 framing —— 头肩/面部特写也会把整张全身图当第二参考喂进去，
   *   直接推翻 resolver 的 face 决定（reference-manager：喂全身图会把脸和耳鳍细节拉糊）。
   */
  const __bodyVisibleFraming = ['半身', '三分之二身', '全身'].includes(String(framing?.framing ?? ''))
  let refImages = (__facePerson && refDecision?.strategy !== 'canon' && __bodyVisibleFraming)
    ? [String(imageCfg.faceRef), imageCfg.bodyRefImage ? String(imageCfg.bodyRefImage) : ''].filter(Boolean)
    : []
  if (__facePerson && !refImage) refImage = String(imageCfg.faceRef)
  /* 固定外出服：只喂脸参考，避免身体参考里的白背心/短裤带偏衣服 */
  if (faceOnlyRef && imageCfg.faceRef && refDecision?.strategy !== 'canon') {
    refImage = String(imageCfg.faceRef)
    refImages = []
  }

  /* ⑥ 连续性说明（只继承状态，不继承构图） */
  const note = continuity.continuityNote(scope, { outfit, hair, slot })

  /* ⑥.5 旁路计算 Pose Planner 的手部职责（纯函数，无副作用；失败不影响生成） */
  let posePlan = null
  try {
    posePlan = buildShotPlan({ scene, slot, raw: null }).pose
  } catch (e) {
    this?.log?.warn?.('planShot：pose 规划旁路失败 — ' + String(e?.message ?? e).slice(0, 60))
  }
  /*
   * ★ 用 handDecision 覆盖 pose 的手部职责（唯一真源，2026-11-10）
   *   pose-planner 自己解析的计数不再作为最终依据。
   */
  if (posePlan && posePlan.hands) {
    posePlan.hands.needVisibleHands = handDecision.requestedNeed == null ? null : handDecision.effectiveNeed
    posePlan.hands.actionHands = handDecision.effective ? handDecision.effective.actionHands : null
    posePlan.hands.poseHands = handDecision.effective ? handDecision.effective.poseHands : null
    posePlan.hands.cameraHands = capability(plan.mode).occupiesHand ? 1 : 0
    if (handDecision.assignment) {
      posePlan.hands.left = handDecision.assignment.left ?? null
      posePlan.hands.right = handDecision.assignment.right ?? null
    }
  }

  /* ⑦ 组装提示词 */
  const prompt = composePhotoPrompt({
    plan, framing, scene: sceneFixed, outfit, hair, weather, mood,
    continuity: note, hasRef: Boolean(refImage), anime, bodyOverride, sceneOnly,
    expression,
    pose: posePlan,
    subjectMode: subjectModeFinal,
    objectSubject: sceneFixed,
    environmentSubject: sceneFixed,
    canonRef: refDecision ? refDecision.strategy === 'canon' : Boolean(canon),
    mode,
    slot,
    character: {
      faceRef: refDecision
        ? (refDecision.strategy === 'face' ? (refDecision.identityRef || '') : '')
        : imageCfg.refImage,
      bodyRef: imageCfg.bodyRefImage,
    },
  })

  /* ⑧ 记录本次状态（供下一张用） */
  if (scope) continuity.record({ scope, scene, outfit, hair, slot, mode: plan.mode, weather })

  /* ⑨ 尺寸：全身要更长的画布（脚才不会在裁水印时被切掉） */
  const size = framing.feet ? (imageCfg.size || '1024x1536') : imageCfg.size
  /* v2：输出前静态检查（不阻断，只记录；有 issues 会随 shot 返回/进日志） */
  const promptAudit = validatePrompt(prompt, { subjectMode: subjectModeFinal, mode: plan.mode, framing: framing.framing })

  return {
    skip: false,
    skipReason: '',
    mode: plan.mode,
    modeLabel: plan.modeLabel,
    framing: framing.framing,
    prompt,
    refImage,
    refImages,
    refDecision,
    posePlan,
    canonRef: refDecision ? refDecision.strategy === 'canon' : Boolean(canon),
    size,
    issues: check.issues,
    fixedFrom: plan.fixedFrom,
    fixReason: plan.fixReason,
    continuityStrength: last ? (last.strength ?? '') : '',
    emotion: expression.label,
    emotionId: expression.id,
    plan,
    framingInfo: framing,
    /* 手部契约决策结果（2026-11-10 v10） */
    handPlan,
    handDecision,
    handStatus: handDecision.status,
    actionSatisfied: handDecision.actionSatisfied,
    planVerified: handDecision.planVerified,
    capacityVisibleHands: handDecision.capacityVisibleHands,
    finalVisibleHands: handDecision.finalVisibleHands,
    promptIssues: promptAudit.issues,
    subjectMode: subjectModeFinal,
  }
}

/**
 * 参考图选择（v2.0 第一条：三张图分工）
 *   面部自拍/半身 → 面部三视图优先，没有就退回头肩图
 *   全身          → 全身三视图
 *   背影          → 全身三视图
 *   第一人称/拍物  → 不带
 */
function pickRefImage(plan, framing, cfg = {}, anime = false) {
  if (plan.needsCharacterRef === false) return ''
  /*
   * ★ 插画档用自己的参考图（2026-11-05）：
   *   用户提供了完整 anime 设定图（4096×2804），按卡片框裁出正脸/正面全身/侧身。
   *   插画档不能再用写实版参考图 —— 风格会串（写实脸套插画会崩）。
   */
  /*
   * ⚠️ anime 的 head 用**全身图**（2026-11-05 用户指正：「头身比问题」）：
   *   用头像当 head 时，模型只看到一张脸 → 画成"大头小身子"。
   *   全身图才能把头身比带过去。头像只在面部特写/头肩时用。
   */
  const head = String((anime && cfg.animeBodyRefImage) || cfg.refImage || '')
  const face3 = String((anime && cfg.animeFaceRefImage) || cfg.faceRefImage || '')
  const body = String((anime && cfg.animeBodyRefImage) || cfg.bodyRefImage || '')

  /*
   * ★ 露脸就优先用**头像那张**（2026-11-05）：
   *   三视图里的脸太小，模型参考不到就自己编一张脸（用户：「主要是脸不对」）。
   *   ⚠️ 但「身材靠文字压」这条**已被证伪**（2026-11-06）：三围每张都不一样。
   *      现在**身体入画就优先三视图**，见下面的 body 分支。
   */
  const faceVisible = plan.mode === 'front_selfie' || plan.mode === 'mirror_selfie' || plan.mode === 'video_call'
  /*
   * ⚠️ 但 **anime 档例外**（2026-11-05 用户指正：「anime 上面不是有标准女仆装全身吗」）：
   *   设定图的正面全身里脸也在，用它当参考能同时带上「脸 + 头身比 + 服装」，
   *   用头像只会画出"大头小身子"。所以 anime 档即使露脸也走全身图。
   */
  if (anime && body) {
    if (framing.framing === '面部特写' || framing.framing === '头肩') return face3 || body
    return body
  }
  /*
   * ★★ **身体入画就必须喂身体参考图**（2026-11-06 用户：「三围不固定」）。
   *
   * 原来露脸的一律回头像，注释写着"身材靠提示词里的尺寸段压，不靠三视图"。
   * 实测结果就是**每张图三围都不一样**：全身照只有一张头像当参考，
   * 82/58/85 那三个数字每次都被模型重新发明一遍。
   * 三视图里脸也在，用它一次把「脸 + 头身比 + 三围」带过去。
   * 只有脸/头肩特写才回头像（那种构图身体本来就不入画）。
   */
  if (framing.feet || framing.framing === '三分之二身' || framing.framing === '半身') {
    if (body) return body
  }
  if (faceVisible && (face3 || head)) {
    return face3 || head
  }
  if (framing.feet) return body || head || face3
  if (framing.framing === '面部特写' || framing.framing === '头肩') return face3 || head
  if (framing.framing === '半身') return head || face3
  if (framing.framing === '三分之二身') return body || head
  return head || face3 || body
}

/** 调试用：把决策链打印成一行 */
export function describeShot(shot) {
  if (shot.skip) return `不拍（${shot.skipReason}）`
  const fix = shot.fixedFrom ? `（原 ${shot.fixedFrom} → 修正：${shot.fixReason}）` : ''
  return `${shot.modeLabel}｜${shot.framing}｜参考图=${shot.refImage ? shot.refImage.split(/[\\/]/).pop() : '无'}${fix}`
}

export { fallbackText }
