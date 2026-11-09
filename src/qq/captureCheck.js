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
function mk({ reviewer, status, violation = null, why = '', confidence = null }) {
  const ok = status === 'pass' ? true : (status === 'violation' ? false : null)
  return { status, ok, reviewer, violation, why: String(why ?? '').slice(0, 120), confidence: typeof confidence === 'number' ? confidence : null }
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
  const conf = typeof parsed.confidence === 'number' ? parsed.confidence : null
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
  if (v === true) return mk({ reviewer: 'no_body_subject', status: 'violation', violation: 'body_subject', why: why || '画面里出现拍摄者身体', confidence: conf })
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
