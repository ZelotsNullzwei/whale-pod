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
    resolution: {
      /* core：拍什么/怎么拍/多远 都能定下来（不含姿势细节） */
      resolved: Boolean(intent.subject && camera.mode && framing.band),
      core: Boolean(intent.subject && camera.mode && framing.band),
      /* strict：core + 可见性没有未决项、没有冲突 —— 才叫"全链路解决" */
      /*
       * strict（评审第 3 条）：必须检查**整条链**的未决项，不只是 visibility。
       *   core 说的是"三件事能定"，strict 说的是"全链路没有未决/冲突"。
       */
      strict: Boolean(intent.subject && camera.mode && framing.band)
        && (visibility.unresolved || []).length === 0
        && (visibility.conflicts || []).length === 0
        && unresolved.length === 0,
      mode: camera.mode,
      band: framing.band,
      posture: pose.pose.posture,
      handsRequired: pose.hands.requiredCount,
      handsVisible: (visibility.hands || []).length,
    },
    unresolved,
  }
}
