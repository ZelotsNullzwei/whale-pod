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
import { planPhoto, shouldSkipPhoto } from './photo-planner.js'
import { validatePhotoPlan, applyFix } from './photo-validator.js'
import { composeFraming } from './photo-composer.js'
import { composePhotoPrompt } from './photo-prompt.js'
import { PhotoContinuity, detectLocation } from './photo-continuity.js'
import { fallbackText } from './character-profile.js'
import { pickEmotion, renderExpression, ExpressionHistory } from './photo-expression.js'

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
  const {
    scene = '', slot = 'afternoon', outfit = '', hair = '', weather = '', mood = '',
    request = '', scope = '', sceneOnly = false, anime = false, imageCfg = {}, bodyOverride = '',
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

  /* ② 规划拍摄方式 */
  let plan = planPhoto({ scene, slot, sceneOnly, anime })

  /* ③ 物理可行性检查 + 自动修正 */
  const loc = detectLocation(scene)
  const hasMirror = /(镜子|照镜子|穿衣镜|镜前|对着镜子|镜子里|对镜自拍)/.test(scene) || loc.id === 'mirror'
  const check = validatePhotoPlan(plan, {
    scene, hasMirror, timeOfDay: slot,
  })
  plan = applyFix(plan, check.fix, MODES)

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
  const framing = composeFraming(plan, {
    request: needSkirtVisible ? `${request} 看看这一身` : request,
    /* ★ 场景也传进去：她会自己写「怼脸特写」而用户只说了「看看你的脸」（2026-11-06） */
    scene,
  })

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
  const refImage = pickRefImage(plan, framing, imageCfg, anime)

  /* ⑥ 连续性说明（只继承状态，不继承构图） */
  const note = continuity.continuityNote(scope, { outfit, hair, slot })

  /* ⑦ 组装提示词 */
  const prompt = composePhotoPrompt({
    plan, framing, scene: sceneFixed, outfit, hair, weather, mood,
    continuity: note, hasRef: Boolean(refImage), anime, bodyOverride, sceneOnly,
    expression,
    character: { faceRef: imageCfg.refImage, bodyRef: imageCfg.bodyRefImage },
  })

  /* ⑧ 记录本次状态（供下一张用） */
  if (scope) continuity.record({ scope, scene, outfit, hair, slot, mode: plan.mode, weather })

  /* ⑨ 尺寸：全身要更长的画布（脚才不会在裁水印时被切掉） */
  const size = framing.feet ? (imageCfg.size || '1024x2048') : imageCfg.size

  return {
    skip: false,
    skipReason: '',
    mode: plan.mode,
    modeLabel: plan.modeLabel,
    framing: framing.framing,
    prompt,
    refImage,
    size,
    issues: check.issues,
    fixedFrom: plan.fixedFrom,
    fixReason: plan.fixReason,
    continuityStrength: last ? (last.strength ?? '') : '',
    emotion: expression.label,
    emotionId: expression.id,
    plan,
    framingInfo: framing,
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
