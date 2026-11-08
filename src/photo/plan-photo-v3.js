/**
 * buildShotPlan · V3.0 四层静态合并（不接生图）
 *
 * 只做"串联 + 汇总"，**不产生任何新的判断**：
 *   intent → camera → framing → pose
 * 每一层的输出原样保留在自己的命名空间下，便于静态审查"谁覆盖了谁"。
 */

import { planIntent } from './photo-planner.js'
import { planCamera } from './camera-planner.js'
import { planFraming } from './framing-planner.js'
import { planPose } from './pose-planner.js'
import { resolveVisibility } from './visibility-resolver.js'

/**
 * 计算 core / strict。抽出来是为了可以**逐条件**验证（评审第 3 条）：
 *   strict 必须同时满足：core && 整链无 unresolved && visibility 无 conflicts。
 */
export function computeResolution({ intent = {}, camera = {}, framing = {}, visibility = {}, unresolved = [] } = {}) {
  const core = Boolean(intent.subject && camera.mode && framing.band)
  const noUnresolved = (unresolved || []).length === 0 && (visibility.unresolved || []).length === 0
  const noConflict = (visibility.conflicts || []).length === 0
  return {
    resolved: core,
    core,
    strict: core && noUnresolved && noConflict,
    reasons: {
      core,
      noUnresolved,
      noConflict,
    },
  }
}

export function buildShotPlan({ scene = '', slot = 'afternoon', sceneOnly = false, raw = null } = {}) {
  const intent = planIntent({ scene, slot, sceneOnly })
  if (raw) intent._raw = raw
  const camera = planCamera(intent)
  const framing = planFraming(intent, camera)
  const pose = planPose(intent, camera, framing)
  /* 可见性唯一出口：合并 camera 上限与 pose 内容，并把冲突记下来 */
  const visibility = resolveVisibility({ intent, camera, framing, pose })

  const unresolved = []
  for (const [layer, list] of [
    ['intent', intent.diagnostics?.unresolved ?? []],
    ['camera', camera.unresolved ?? []],
    ['framing', framing.unresolved ?? []],
    ['pose', pose.unresolved ?? []],
  ]) {
    for (const u of list) unresolved.push({ layer, item: u })
  }

  return {
    schemaVersion: '3.0.0-shot',
    intent,
    camera,
    framing,
    pose,
    visibility,
    /* Composition 暂不独立：只占位，不参与决策（评审 2026-11-09） */
    composition: { layout: null, source: null, unresolved: [] },
    resolution: {
      ...computeResolution({ intent, camera, framing, visibility, unresolved }),
      mode: camera.mode,
      band: framing.band,
      posture: pose.pose.posture,
      handsRequired: pose.hands.requiredCount,
      handsVisible: (visibility.hands || []).length,
    },
    unresolved,
  }
}
