/**
 * photoCapturePipeline —— 生图后处理 + 审核决策 + 审核记录（**纯函数，无 IO**）
 *
 * 从 bridge.js 抽出来，目的是：
 *   ① 原图 / 重拍图**共用同一套图片处理**（部位裁切、全身裁底、擦角水印）
 *   ② 旧审核（reviewImage/countLimbs）与 Capture Check **共用一个重拍名额**
 *   ③ 审核记录结构化，便于排查
 *
 * 约定：
 *   · uncertain **不触发重拍**（沿用"审核失败放行"）
 *   · 已经重拍过一次 → 不再重拍（最多 1 次）
 */

/** 部位特写裁切区间（与原 bridge 内联表一致；锁骨/胸部/肩颈故意不裁） */
const BODY_PART_CROP = {
  腿: [0.42, 1.0],
  脚: [0.62, 1.0],
  小腹: [0.35, 0.78],
  腰: [0.30, 0.72],
}

/**
 * 统一的图片后处理。
 * @param {Buffer} buf 原始生成图
 * @param {{shot?:object, imgCfg?:object, ops?:{cropRegion?:Function,cropBottom?:Function,eraseCornerWatermark?:Function,log?:object}}} o
 * @returns {Promise<{ok:boolean, buf:Buffer, reason?:string}>}
 */
export async function processImage(buf, { shot = {}, imgCfg = {}, ops = {} } = {}) {
  if (!buf || buf.length <= 1024) return { ok: false, buf, reason: `图片过小/空（${buf ? buf.length : 0} B）` }
  if (buf.length >= 8 * 1024 * 1024) return { ok: false, buf, reason: `图片过大（${buf.length} B）` }

  const { cropRegion, cropBottom, eraseCornerWatermark, log } = ops
  let out = buf

  const part = shot?.framingInfo?.bodyPart
  const bp = part ? BODY_PART_CROP[part] : null
  if (bp && typeof cropRegion === 'function') out = await cropRegion(out, bp[0], bp[1], log)

  if (out.length > 1024 && out.length < 8 * 1024 * 1024) {
    if (shot?.framingInfo?.feet) {
      if (typeof cropBottom === 'function') out = await cropBottom(out, 0.06, log)
      if (typeof eraseCornerWatermark === 'function') out = await eraseCornerWatermark(out, log)
    } else {
      if (typeof cropBottom === 'function') out = await cropBottom(out, Number(imgCfg.cropBottom ?? 0.1), log)
      if (typeof eraseCornerWatermark === 'function') out = await eraseCornerWatermark(out, log)
    }
    return { ok: true, buf: out }
  }
  return { ok: false, buf: out, reason: '处理后可发送尺寸异常' }
}

/**
 * 是否重拍（唯一决策点）。
 * @param {{legacyViolation?:boolean, legacyWhy?:string, capture?:object|null, alreadyRetried?:boolean}} o
 * @returns {{retry:boolean, reasons:string[], record:object}}
 */
export function decideRetry({ legacyViolation = false, legacyWhy = '', capture = null, alreadyRetried = false } = {}) {
  const reasons = []
  if (alreadyRetried) return { retry: false, reasons: ['已重拍过一次'], record: { legacyViolation, legacyWhy, captureStatus: capture?.status ?? null } }

  if (legacyViolation) reasons.push(`旧审核:${legacyWhy || '不合格'}`)
  if (capture && capture.status === 'violation') reasons.push(`capture:${capture.violation || 'violation'}`)

  return {
    retry: reasons.length > 0,
    reasons,
    record: {
      legacyViolation,
      legacyWhy,
      captureStatus: capture?.status ?? null,
      captureViolation: capture?.violation ?? null,
      captureWhy: capture?.why ?? '',
    },
  }
}

/**
 * 结构化审核记录（用于日志；默认不落两份大图，避免缓存膨胀）。
 */
export function buildAuditRecord({ scope = '', mode = '', original = null, retried = false, retry = null, finalChoice = 'original', cacheKey = '', ms = 0 } = {}) {
  const brief = (c) => (c ? { status: c.status, violation: c.violation ?? null, why: (c.why ?? '').slice(0, 80), confidence: c.confidence ?? null } : null)
  return {
    at: new Date().toISOString(),
    scope,
    mode,
    original: original ? { legacy: original.legacy ?? null, capture: brief(original.capture) } : null,
    retried: Boolean(retried),
    retry: retry ? { legacy: retry.legacy ?? null, capture: brief(retry.capture) } : null,
    finalChoice,
    cacheKey,
    ms,
  }
}
