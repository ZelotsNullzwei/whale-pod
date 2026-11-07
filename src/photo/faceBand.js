/**
 * 脸部下边界检测（2026-11-07，C 方案）。
 *
 * ## 职责边界（GPT 交接 §1–§7）
 * · **只输出三个字段**：`face_found` / `face_bottom_y` / `confidence`
 * · 坐标是**原图归一化纵坐标 0~1**（0=顶，1=底）
 * · **不参与部位分类**（那是 `detectBodyPart()` 正则的事，不许它插手）
 * · 拿不到可靠结果就明说拿不到 —— 由调用方走安全回退，不许猜
 *
 * ## 为什么不自己起一个新的视觉服务
 * 复用现成的本地网关 `/chat/completions`（和 `imageReview` 同一个通道），
 * 只是换一句 prompt。不新增服务商、不加 key。
 */
const PROMPT = `你是一个坐标标注器。看这张图，只回答人脸的位置。

输出**一行 JSON**，不要别的话、不要解释、不要 markdown：
{"face_found":true,"face_bottom_y":0.62,"confidence":0.85}

字段说明：
- face_found：图里有没有清晰可辨的人脸（有头有脸才算；只有后脑、只有下巴尖、没有人都算 false）
- face_bottom_y：**下巴（或脸部最下沿）在图里的纵向位置**，0=图片最上面，1=图片最下面，保留两位小数
- confidence：你对这个判断的把握，0~1

⚠️ 只有规则：
- 看不见脸就回 {"face_found":false,"face_bottom_y":null,"confidence":1}
- 别把脖子、肩膀、头发算成脸；要的是**脸本身的底边**
- 宁可回 false，也不要编一个看起来合理的数`

/**
 * @param {object} o
 * @param {Buffer} o.buf       图片字节（JPEG/PNG）
 * @param {string} o.gateway   本地网关（如 http://127.0.0.1:18899/v1）
 * @param {string} o.key       网关 key
 * @param {object} [o.log]
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{face_found:boolean, face_bottom_y:number|null, confidence:number, source:string}>}
 */
export async function detectFaceBottom({ buf, gateway, key, log = {}, timeoutMs = 20_000 } = {}) {
  const miss = (source) => ({ face_found: false, face_bottom_y: null, confidence: 0, source })
  if (!buf || buf.length < 1024) return miss('no-buffer')
  if (!gateway || !key) return miss('no-gateway')
  try {
    const mime = buf[0] === 0xff ? 'image/jpeg' : 'image/png'
    const dataUrl = `data:${mime};base64,${buf.toString('base64')}`
    const r = await fetch(`${String(gateway).replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'auto',
        stream: false,
        whale_pod_search: false,
        max_tokens: 80,
        messages: [
          { role: 'system', content: PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: '这张图里的人脸，底边在纵向什么位置？' },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!r.ok) {
      log.warn?.(`脸部检测：网关 ${r.status}，按"没检测到"处理`)
      return miss(`http-${r.status}`)
    }
    const j = await r.json().catch(() => null)
    const text = String(j?.choices?.[0]?.message?.content ?? '').trim()
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) return miss('no-json')
    let o = null
    try { o = JSON.parse(m[0]) } catch { return miss('bad-json') }

    const found = o?.face_found === true
    const conf = Number(o?.confidence)
    const y = Number(o?.face_bottom_y)
    // 三条硬校验：范围、置信度、非法值 —— 任何一条不过就当没检测到
    if (!found) return { face_found: false, face_bottom_y: null, confidence: Number.isFinite(conf) ? conf : 0, source: 'model' }
    if (!Number.isFinite(y) || y <= 0 || y > 1) return miss('bad-range')
    if (!Number.isFinite(conf) || conf < 0.5) return miss('low-confidence')
    return { face_found: true, face_bottom_y: y, confidence: conf, source: 'model' }
  } catch (e) {
    log.warn?.(`脸部检测：调用失败 — ${String(e?.message ?? e).slice(0, 60)}`)
    return miss('error')
  }
}
