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
 * 发送门禁：只拦"结构性致命错误 / 审核不可用"，**不**把普通旧审核失败当严重。
 *   · fatal：extra_hands / limb_count / hand_mismatch / hand_anatomy（手部专项）
 *   · 任何 reviewSkipped（审核不可用）→ 阻断（fail closed，需 requireReview）
 *   · phone_visible / body_subject 属于既有"重拍后放行"策略，不在此阻断
 */
export function shouldBlockSend({ legacy = null, capture = null, retryCapture = null, reviewSkipped = false } = {}) {
  const FATAL = new Set(['extra_hands', 'limb_count', 'hand_mismatch', 'hand_anatomy'])
  if (reviewSkipped) return { block: true, reason: '审核不可用' }
  /* 有重拍图时以重拍图为准（重拍修好了就不该被初审拖住）；否则看初审 */
  const finalC = retryCapture ?? capture
  if (finalC) {
    const fatal = finalC.severity === 'fatal' || FATAL.has(String(finalC.violation ?? ''))
    if (finalC.status === 'violation' && fatal) return { block: true, reason: `${retryCapture ? '复审' : '初审'}:${finalC.violation}` }
  }
  return { block: false, reason: null }
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
    retry: retry ? { legacy: retry.legacy ?? null, capture: brief(retry.capture), skipped: retry.skipped ?? null } : null,
    finalChoice,
    cacheKey,
    ms,
  }
}

/**
 * 缩图结果是否**真的可用**。
 * imageShrink.shrinkForReview 失败时**不抛异常，而是原样返回入参**（同一引用），
 * 所以不能只看 length>0 —— 必须排除「同一个 Buffer」「没变小」「空/非 Buffer」。
 */
function isUsableShrink(out, src) {
  return Buffer.isBuffer(out) && Buffer.isBuffer(src) && out !== src && out.length > 1024 && out.length < src.length
}

/**
 * 审核编排（接线可测版）：串起「旧审核 + Capture Check → 唯一重拍 → 复审只记录」
 *
 * 关键纪律（评审要求）：
 *   · 旧审核与 Capture Check **各自 try/catch**，任一异常不得覆盖另一个已得结果
 *   · 旧审核异常 → 放行（ok:true，沿用既有原则）
 *   · Capture Check 异常 → uncertain（不触发重拍）
 *   · 重拍最多一次；重拍失败（返回 null）→ 保留原图
 *   · 重拍后复审只记录，不阻断、不再重拍
 *
 * @param {{buf:Buffer, mode?:string, reviewEnabled?:boolean,
 *          legacyCheck?:(buf:Buffer)=>Promise<{ok:boolean,why?:string}>,
 *          captureReviewer?:(o:{buf:Buffer})=>Promise<object>,
 *          retry?:()=>Promise<Buffer|null>, log?:object}} o
 * @returns {Promise<{finalBuf:Buffer, retried:boolean, finalChoice:'original'|'retry',
 *           qcFirst:{legacy:any,capture:any}, qcRetry:{legacy:any,capture:any}|null, decision:object|null}>}
 */

export async function runCaptureReview({
  buf,
  mode = '',
  reviewEnabled = true,
  shrink = null,          // async (buf) => Buffer，审核专用缩图（如 640）
  legacyCheck = null,     // async (reviewBuf) => { ok, why }
  captureReviewer = null, // async ({ buf: reviewBuf }) => captureResult
  retry = null,           // async () => Buffer|null（已生成并处理好的重拍图，全分辨率）
  requireReview = false,
  log = {},
} = {}) {
  const qcFirst = { legacy: null, capture: null }
  let qcRetry = null
  let retried = false
  let finalChoice = 'original'
  let finalBuf = buf

  if (!reviewEnabled || !buf) {
    return { finalBuf, retried, finalChoice, qcFirst, qcRetry, decision: null, block: Boolean(requireReview) }
  }

  /* ① 统一缩图（旧审核与 Capture Check 共用同一份）——缩图失败按"审核异常放行" */
  let reviewBuf = buf
  if (typeof shrink === 'function') {
    let small = null
    try {
      small = await shrink(buf)
    } catch (e) {
      log.warn?.(`capture-review：审核缩图抛异常，按放行处理 — ${String(e?.message ?? e).slice(0, 60)}`)
      return { finalBuf, retried, finalChoice, qcFirst: { legacy: { ok: true, why: '缩图失败放行' }, capture: null }, qcRetry, decision: null, block: Boolean(requireReview) }
    }
    if (!isUsableShrink(small, buf)) {
      /* 生产环境真实的失败形态：shrinkForReview 返回原图同一引用 */
      log.warn?.('capture-review：缩图结果不可用（返回原图/为空/未变小）→ 按放行处理')
      return { finalBuf, retried, finalChoice, qcFirst: { legacy: { ok: true, why: '缩图失败放行' }, capture: null }, qcRetry, decision: null, block: Boolean(requireReview) }
    }
    reviewBuf = small
  }

  /* ② 旧审核：独立捕获 */
  if (typeof legacyCheck === 'function') {
    try {
      qcFirst.legacy = await legacyCheck(reviewBuf)
    } catch (e) {
      log.warn?.(`capture-review：旧审核异常，按放行 — ${String(e?.message ?? e).slice(0, 60)}`)
      qcFirst.legacy = { ok: true, why: '审核异常放行' }
    }
  }

  /* ③ Capture Check：独立捕获 → uncertain，绝不覆盖 legacy */
  if (typeof captureReviewer === 'function') {
    try {
      qcFirst.capture = await captureReviewer({ buf: reviewBuf })
    } catch (e) {
      qcFirst.capture = { status: 'uncertain', ok: null, reviewer: 'unknown', violation: null, why: '审核异常:' + String(e?.message ?? e).slice(0, 40), confidence: null }
    }
  }

  const decision = decideRetry({
    legacyViolation: qcFirst.legacy ? !qcFirst.legacy.ok : false,
    legacyWhy: qcFirst.legacy?.why ?? '',
    capture: qcFirst.capture,
    alreadyRetried: false,
  })

  /* ④ 唯一一次重拍；重拍后复审同样用**缩图** */
  if (decision.retry && typeof retry === 'function') {
    let buf2 = null
    try {
      buf2 = await retry()
    } catch (e) {
      log.warn?.(`capture-review：重拍异常，保留原图 — ${String(e?.message ?? e).slice(0, 60)}`)
    }
    if (buf2 && buf2.length > 1024) {
      let rImg = buf2
      if (typeof shrink === 'function') {
        let s2 = null
        try { s2 = await shrink(buf2) } catch { /* 复审缩图异常：下面统一按不可用处理 */ }
        rImg = isUsableShrink(s2, buf2) ? s2 : null
      }
      /* 复审缩图不可用：不把全分辨率重拍图交给审核器（只记录，不阻断、不二次重拍） */
      const r = rImg ? { legacy: null, capture: null } : { legacy: null, capture: null, skipped: '复审缩图不可用' }
      if (rImg && typeof legacyCheck === 'function') {
        try { r.legacy = await legacyCheck(rImg) } catch { r.legacy = null }
      }
      if (rImg && typeof captureReviewer === 'function') {
        try { r.capture = await captureReviewer({ buf: rImg }) } catch {
          r.capture = { status: 'uncertain', ok: null, reviewer: 'unknown', violation: null, why: '审核异常', confidence: null }
        }
      }
      qcRetry = r
      finalBuf = buf2
      retried = true
      finalChoice = 'retry'
    }
  }

  /* 审核不可用：requireReview 且（无审核器 或 视觉服务异常导致 uncertain）→ fail closed */
  const finalCapture = qcRetry?.capture ?? qcFirst.capture
  const reviewUnavailable = Boolean(requireReview) && (
    (!captureReviewer)
    || (finalCapture && finalCapture.status === 'uncertain' && /异常|失败|网关|超时/.test(String(finalCapture.why ?? '')))
  )
  const gate = shouldBlockSend({ legacy: qcRetry?.legacy?.ok === false ? qcRetry.legacy : qcFirst.legacy, capture: qcFirst.capture, retryCapture: qcRetry?.capture, reviewSkipped: reviewUnavailable })
  return { finalBuf, retried, finalChoice, qcFirst, qcRetry, decision, ...gate, block: Boolean(requireReview) && gate.block }
}
