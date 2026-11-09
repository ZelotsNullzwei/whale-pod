/**
 * captureCheck —— 拍摄模式专用「看图」复检（离线模块，**未接入生图流程**）
 *
 * 两个 reviewer：
 *   · reviewNoPhone        → front_selfie：画面里是否混进手机本体/屏幕/背面
 *   · reviewNoBodySubject  → rear_selfie：画面里是否出现拍摄者不允许的身体区域
 *                            （允许一只操作手 / 必要的一段前臂）
 *
 * 契约（统一）：
 *   { status:'pass'|'violation'|'uncertain', ok:true|false|null,
 *     reviewer:'no_phone'|'no_body_subject',
 *     violation:null|'phone_visible'|'body_subject',
 *     why:string, confidence:number|null }
 *
 * 纪律：
 *   · 底层不可用 / 超时 / 解析失败 → **uncertain**，绝不静默当 pass
 *   · 置信度只透传模型给的值；模型不给 → null（不编造）
 *   · 不按文件名、目录、测试编号产生结果
 */

const DEFAULT_TIMEOUT = 20_000

/** 统一的结果构造，保证 ok 与 status 一致 */
/** 置信度归一：只接受有限数值且落在 0~1，否则一律 null（不编造） */
function normConf(v) {
  return (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) ? v : null
}

function mk({ reviewer, status, violation = null, why = '', confidence = null, severity = null, hands = null, arms = null, serviceError = false }) {
  const ok = status === 'pass' ? true : (status === 'violation' ? false : null)
  return { status, ok, reviewer, violation, severity, why: String(why ?? '').slice(0, 120), confidence: normConf(confidence), hands, arms, serviceError: Boolean(serviceError) }
}

/**
 * 调视觉网关（与 imageReview 同一条本地通道）。
 * @returns {Promise<object|null>} 解析出的 JSON；失败返回 null（由调用方判 uncertain）
 */
async function askVisionJSON({ buf, gateway, key, system, userText, timeoutMs = DEFAULT_TIMEOUT }) {
  if (!buf || buf.length < 1024) return null
  if (!gateway || !key) return null
  const mime = buf[0] === 0xff ? 'image/jpeg' : 'image/png'
  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`
  const body = {
    model: 'auto',
    stream: false,
    whale_pod_search: false,
    max_tokens: 160,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  }
  const r = await fetch(`${String(gateway).replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!r.ok) return null
  const j = await r.json().catch(() => null)
  const txt = String(j?.choices?.[0]?.message?.content ?? '').trim()
  const m = /\{[\s\S]*\}/.exec(txt)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}

const NO_PHONE_SYSTEM = [
  '你是图片质检员。判断画面里**有没有手机**。',
  '手机包含：手机本体、手机屏幕（亮着或黑着）、手机背面（含摄像头模组）。',
  '⚠️ 不要把这些误判成手机：镜子、窗户、相框、门框、显示器/电视、平板、书本、纸片、桌沿。',
  '判定口径：画面里看不到手机 → false（不要用 null）；明确看到手机 → true；',
  '只有「疑似手机但被遮挡/看不清」这种少数情况才返回 null。',
  '回答严格 JSON：{"phone_visible": true|false|null, "why": "不超过20字", "confidence": 0~1}',
].join('\n')

const NO_BODY_SYSTEM = [
  '你是图片质检员。这张图是「她本人用手机后置摄像头拍物品」的画面。',
  '判断画面里是否出现了**拍摄者本人的身体主体**（不允许）：头/脸/头发、肩膀、躯干/侧身、腿/膝盖、脚/拖鞋。',
  '⚠️ **允许**：为操作物品而出现的一只手、或必要的一段前臂 —— 只有手/前臂不算违规。',
  '⚠️ 不要把漫画/照片/屏幕/海报里的**人物**当成拍摄者本人。',
  '⚠️ 不要把衣服、桌面、家具、椅背当成人体。',
  '判定口径：只看到手/前臂 → false；明确看到头脸/肩/躯干/腿脚 → true；',
  '只有「无法区分是手臂还是躯干」时才返回 null。',
  '回答严格 JSON：{"body_subject": true|false|null, "why": "不超过20字", "confidence": 0~1}',
].join('\n')

/**
 * Reviewer A：前置自拍不应出现手机。
 * @param {{buf:Buffer, gateway:string, key:string, timeoutMs?:number, ask?:Function}} o
 *        `ask` 仅用于单元测试注入（真实调用不要传）。
 */
export async function reviewNoPhone({ buf, gateway, key, timeoutMs = DEFAULT_TIMEOUT, ask = askVisionJSON, log = {} } = {}) {
  if (!buf || buf.length < 1024) {
    return mk({ reviewer: 'no_phone', status: 'uncertain', why: '图片为空或过小' })
  }
  let parsed = null
  try {
    parsed = await ask({ buf, gateway, key, system: NO_PHONE_SYSTEM, userText: '这张图里有没有手机？', timeoutMs })
  } catch (e) {
    log.warn?.(`captureCheck/no_phone：视觉调用异常 — ${String(e?.message ?? e).slice(0, 60)}`)
    return mk({ reviewer: 'no_phone', status: 'uncertain', why: '视觉服务异常' })
  }
  if (!parsed) return mk({ reviewer: 'no_phone', status: 'uncertain', why: '识别失败或无法判断' })

  const v = parsed.phone_visible
  const why = String(parsed.why ?? '').slice(0, 60)
  const conf = parsed.confidence
  if (v === true) return mk({ reviewer: 'no_phone', status: 'violation', violation: 'phone_visible', why: why || '画面里出现手机', confidence: conf })
  if (v === false) return mk({ reviewer: 'no_phone', status: 'pass', why: why || '画面里没有手机', confidence: conf })
  return mk({ reviewer: 'no_phone', status: 'uncertain', why: why || '模型无法确认是否有手机', confidence: conf })
}

/**
 * Reviewer B：后置拍物不应出现拍摄者身体主体（允许手/前臂）。
 * ⚠️ 只用于 rear_selfie；调用方负责不把它用于 first_person。
 */
export async function reviewNoBodySubject({ buf, gateway, key, timeoutMs = DEFAULT_TIMEOUT, ask = askVisionJSON, log = {} } = {}) {
  if (!buf || buf.length < 1024) {
    return mk({ reviewer: 'no_body_subject', status: 'uncertain', why: '图片为空或过小' })
  }
  let parsed = null
  try {
    parsed = await ask({ buf, gateway, key, system: NO_BODY_SYSTEM, userText: '这张图里有没有拍摄者本人的身体主体（头脸/肩/躯干/腿脚）？只有手或前臂不算。', timeoutMs })
  } catch (e) {
    log.warn?.(`captureCheck/no_body：视觉调用异常 — ${String(e?.message ?? e).slice(0, 60)}`)
    return mk({ reviewer: 'no_body_subject', status: 'uncertain', why: '视觉服务异常' })
  }
  if (!parsed) return mk({ reviewer: 'no_body_subject', status: 'uncertain', why: '识别失败或无法判断' })

  const v = parsed.body_subject
  const why = String(parsed.why ?? '').slice(0, 60)
  const conf = typeof parsed.confidence === 'number' ? parsed.confidence : null
  if (v === true) return mk({ reviewer: 'no_body_subject', status: 'violation', violation: 'body_subject', severity: 'fatal', why: why || '画面里出现拍摄者身体', confidence: conf })
  if (v === false) return mk({ reviewer: 'no_body_subject', status: 'pass', why: why || '只出现手/前臂或无人', confidence: conf })
  return mk({ reviewer: 'no_body_subject', status: 'uncertain', why: why || '无法区分手臂与躯干', confidence: conf })
}

/** 按 mode 选择 reviewer；未登记的模式一律返回 null（不检查）。 */
export function pickReviewer(mode) {
  const m = String(mode ?? '')
  if (m === 'front_selfie') return reviewNoPhone
  if (m === 'rear_selfie') return reviewNoBodySubject
  return null
}


/* ────────────────────────────────────────────────────────────────
 * 手部结构审核（2026-11-09 手部专项）
 * 契约：与 src/photo/handContract.js 共用 maxVisibleHands。
 * 违规类型（severity=fatal）：
 *   extra_hands   手数超过契约
 *   limb_count    手臂>2
 *   hand_mismatch 两只手左右同侧（都像左手/右手）
 *   hand_anatomy  拇指/手腕/手指结构异常
 * ──────────────────────────────────────────────────────────────── */
const HANDS_SYSTEM = [
  '你是人体结构质检员。只判断画面里的手和手臂，不看美观、不看构图。',
  '按顺序检查并如实回答：',
  '1) 画面里能看到几只完整的手掌？几只手臂（从肩膀连下来的肢体，只露小臂也算）？',
  '2) 计数口径：把画面**分成左半边和右半边分别看**；每只看得见的手都要计入（哪怕只露出手指、手背或半个手掌）；手臂=从肩到手的肢体。',
  '3) 如果能看到两只手：它们是否分别是左右手（拇指朝向相反、掌背结构相反）？两只都是左手或都是右手 → same_side=true；左右各一（正常）→ same_side=false。',
  '4) 手部结构是否正常：拇指方向、手腕连接、手指数量、有没有多余或重复的手？正常 → anatomy_ok=true；明显异常 → false。',
  '⚠️ same_side / anatomy_ok 必须尽量给 true/false；**只有确实被完全遮挡、看不出结构时才给 null**。',
  '⚠️ 两只手看起来都正常、方向自然时，不要因为它们并列或一持机一垂放就判 true（同侧）或 null。',
  '回答严格 JSON：{"hands": 数字, "arms": 数字, "same_side": true|false|null, "anatomy_ok": true|false|null, "why": "不超过24字", "confidence": 0~1}',
].join('\n')

export async function reviewHands({ buf, gateway, key, maxVisibleHands = 1, timeoutMs = DEFAULT_TIMEOUT, ask = askVisionJSON, log = {} } = {}) {
  if (!buf || buf.length < 1024) {
    return mk({ reviewer: 'hands', status: 'uncertain', why: '图片为空或过小' })
  }
  let parsed = null
  let lastErr = null
  const sys = HANDS_SYSTEM + '\n本图最多允许 ' + Number(maxVisibleHands) + ' 只手；超过该数量即属于多余手。'
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    try {
      parsed = await ask({ buf, gateway, key, system: sys, userText: '这张图里的手和手臂是什么情况？', timeoutMs })
    } catch (e) {
      lastErr = e
    }
  }
  if (!parsed) {
    log.warn?.(`captureCheck/hands：两次识别失败${lastErr ? ' — ' + String(lastErr?.message ?? lastErr).slice(0, 50) : ''}`)
    return mk({ reviewer: 'hands', status: 'uncertain', why: '视觉识别失败（两次）', serviceError: true })
  }

  const hands = Number(parsed.hands)
  const arms = Number(parsed.arms)
  const why = String(parsed.why ?? '').slice(0, 60)
  const conf = typeof parsed.confidence === 'number' ? parsed.confidence : null
  const base = { reviewer: 'hands', hands: Number.isFinite(hands) ? hands : null, arms: Number.isFinite(arms) ? arms : null }

  if (Number.isFinite(arms) && arms > 2) return mk({ ...base, status: 'violation', violation: 'limb_count', severity: 'fatal', why: why || `数出 ${arms} 条手臂`, confidence: conf })
  if (Number.isFinite(hands) && hands > Number(maxVisibleHands)) return mk({ ...base, status: 'violation', violation: 'extra_hands', severity: 'fatal', why: why || `手数 ${hands} > 允许 ${maxVisibleHands}`, confidence: conf })
  /* 只有 ≥2 只手时，"左右同侧"才有意义；单手时 same_side=null 属 N/A */
  if (Number.isFinite(hands) && hands >= 2 && parsed.same_side === true) return mk({ ...base, status: 'violation', violation: 'hand_mismatch', severity: 'fatal', why: why || '两只手同侧（左右错配）', confidence: conf })
  if (parsed.anatomy_ok === false) return mk({ ...base, status: 'violation', violation: 'hand_anatomy', severity: 'fatal', why: why || '手部解剖结构异常', confidence: conf })
  /* 边缘/背景第二只手复核：模型对边缘手容易漏数 */
  if (Number.isFinite(hands) && hands < 2) {
    let second = null
    try {
      second = await ask({ buf, gateway, key, system: SECOND_HAND_SYSTEM, userText: '画面边缘或背景里还有没有另一只手/手臂？', timeoutMs })
    } catch { second = null }
    if (second && second.has_second === true) {
      return mk({ ...base, status: 'violation', violation: 'extra_hands', severity: 'fatal', why: String(second.why ?? '边缘还有第二只手').slice(0, 60), confidence: conf })
    }
    if (second && second.has_second === null) {
      return mk({ ...base, status: 'uncertain', why: String(second.why ?? '边缘手部无法确认').slice(0, 60), confidence: conf })
    }
  }
  if (Number.isFinite(hands) && hands >= 2 && parsed.same_side === null) {
    return mk({ ...base, status: 'uncertain', why: why || '两只手但无法判断左右', confidence: conf })
  }
  if (parsed.anatomy_ok === null || !Number.isFinite(hands)) {
    return mk({ ...base, status: 'uncertain', why: why || '手部信息不足，无法确认', confidence: conf, serviceError: false })
  }
  return mk({ ...base, status: 'pass', why: why || '手部数量与结构正常', confidence: conf })
}

/** 把 mode 专属 reviewer 与 hands reviewer 的结果合并成一个结论（violation 优先，fatal 最高） */
export function combineCaptureResults(results = []) {
  const list = results.filter(Boolean)
  if (!list.length) return null
  const violation = list.find((r) => r.status === 'violation')
  if (violation) {
    const fatal = list.find((r) => r.status === 'violation' && r.severity === 'fatal')
    const pick = fatal || violation
    return { status: 'violation', ok: false, reviewer: pick.reviewer, violation: pick.violation, severity: pick.severity ?? 'normal', why: pick.why, confidence: pick.confidence ?? null, hands: pick.hands ?? null, arms: pick.arms ?? null, details: list }
  }
  if (list.some((r) => r.status === 'uncertain')) {
    const u = list.find((r) => r.status === 'uncertain')
    return { status: 'uncertain', ok: null, reviewer: u.reviewer, violation: null, severity: null, why: u.why, confidence: u.confidence ?? null, details: list }
  }
  return { status: 'pass', ok: true, reviewer: list[0].reviewer, violation: null, severity: null, why: list[0].why, confidence: list[0].confidence ?? null, hands: list[0].hands ?? null, arms: list[0].arms ?? null, details: list }
}
