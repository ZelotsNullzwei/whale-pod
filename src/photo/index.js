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
    request = '', scope = '', sceneOnly = false, anime = false, imageCfg = {},
  } = o

  /* ① 该不该拍（没有值得分享的内容就不拍） */
  const last = continuity.peek(scope)
  const skipCheck = shouldSkipPhoto({ scene, lastScene: last?.lastScene ?? '' })
  if (skipCheck.skip) {
    return { skip: true, skipReason: skipCheck.reason, prompt: '', refImage: '', size: '', plan: {}, framingInfo: {} }
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

  /* ④ 构图 */
  const framing = composeFraming(plan, { request })

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
  const refImage = pickRefImage(plan, framing, imageCfg)

  /* ⑥ 连续性说明（只继承状态，不继承构图） */
  const note = continuity.continuityNote(scope, { outfit, hair, slot })

  /* ⑦ 组装提示词 */
  const prompt = composePhotoPrompt({
    plan, framing, scene, outfit, hair, weather, mood,
    continuity: note, hasRef: Boolean(refImage), anime,
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
function pickRefImage(plan, framing, cfg = {}) {
  if (plan.needsCharacterRef === false) return ''
  const head = String(cfg.refImage || '')
  const face3 = String(cfg.faceRefImage || '')
  const body = String(cfg.bodyRefImage || '')

  /*
   * ★ 露脸就优先用**头像那张**（2026-11-05）：
   *   三视图里的脸太小，模型参考不到就自己编一张脸（用户：「主要是脸不对」）。
   *   身材靠提示词里的尺寸段压，不靠三视图。
   */
  const faceVisible = plan.mode === 'front_selfie' || plan.mode === 'mirror_selfie' || plan.mode === 'video_call'
  if (faceVisible && (face3 || head)) {
    // 全身照也先给头像（脸最重要）；确实要全身时三视图只能当补充，这里不选
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
