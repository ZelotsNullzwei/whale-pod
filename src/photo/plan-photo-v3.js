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

export function buildShotPlan({ scene = '', slot = 'afternoon', sceneOnly = false, raw = null } = {}) {
  const intent = planIntent({ scene, slot, sceneOnly })
  if (raw) intent._raw = raw
  const camera = planCamera(intent)
  const framing = planFraming(intent, camera)
  const pose = planPose(intent, camera, framing)

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
    resolution: {
      /* 是否已经能确定"拍什么、怎么拍、多远、身体怎么动" */
      resolved: Boolean(intent.subject && camera.mode && framing.band),
      mode: camera.mode,
      band: framing.band,
      posture: pose.pose.posture,
      handsRequired: pose.hands.requiredCount,
      handsVisible: pose.visibility.visibleHands.length,
    },
    unresolved,
  }
}
