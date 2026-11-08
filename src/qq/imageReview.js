/**
 * 生成图审核（2026-11-05）。
 *
 * ## 为什么要有
 * 用户实测：同一段提示词画出来的图里**多出一只手**（自拍臂两只 + 脸旁一只 +
 * 举起一只 = 四条手臂），看着"诡异"。生成前的规则校验（photo-validator）
 * 管的是"拍摄方案合不合理"，管不了"画出来的手有几只" —— 那只能看图。
 *
 * ## 做法
 * 生成完 → 调一次本地网关（`/v1/chat/completions`，带图），让模型检查：
 *   ① 手脚数量/手指正常吗（多手、多指、拧成麻花）
 *   ② 脸崩了吗（五官错位、瞳孔对不上、脖子接不上）
 *   ③ 有没有多余肢体/悬浮物
 * 不合格 → 调用方**重画一次**；再不行就不发。
 *
 * ## 两个纪律
 * · **审核失败放行** —— 宁可发一张可能有瑕疵的图，也不能因为审核挂了什么都不发。
 * · **自拍臂不算多手** —— 提示词里明说，否则每张自拍都会被误判。
 */
const PROMPT = `你在检查一张 AI 生成的"生活照"有没有硬伤。只看下面四项，别评价美不美：

1. 手脚：有没有**明显多出来的整根手指**、手拧成麻花、手指粘连成一片？
   ⚠️ **数手指必须保守**（2026-11-07 实测踩过误判：一张五根指头的手被判成"六根"）：
   - 只数**完整、清晰、单独可见**的手指
   - 被遮挡、弯曲叠在一起、只露半截、在画面边缘被切掉的，**一律不算**
   - 俯拍整只手、手占满画面时最容易数错 —— **拿不准就判 OK**
   - 只有能看出"**多出一整根带掌骨的独立手指**"才算 BAD
   ⚠️ **也要查"缺"**（2026-11-08 用户：「我嘞个手不见啦」）：
   - 手臂伸出来的那一侧，末端**必须有手**；小臂直接接进裙子/身体/画面外，却没有手 = BAD
   - 两只手臂都要数一遍：一条手在脸边，另一条垂在身侧时，那条**别丢**
   - 只判"看得很清楚确实没有手"；被身体挡住、插兜、藏在身后（能看懂是藏起来）= OK
   ⚠️ **也要数手臂和手掌**（2026-11-08 用户：「手多了」「手臂和手掌的问题」）：
   - 一条手臂 = 从肩膀连到手；正常最多两条。**出现第三条手臂 = BAD**
   - 胸前/腰侧多出一只**不连着身体的手臂或手掌** = BAD
   - 这只手掌可能只有半只手、或只露一段小臂 —— **别因为"被挡了一半"就放过**
   - 这一条**不适用上面的"保守"原则**：只要看起来多出一条完整的臂/一只多余的手，就判 BAD

2. 脸：五官有没有错位、两只眼睛瞳孔对不上、脖子接不上头、嘴歪得不自然？
3. 多余东西：有没有不该出现的肢体（第三只手从画面边缘伸进来）、悬空的物体、
   **画面里不该有的人**（自拍/独居场景里冒出别人、凭空多出一个摄影师）。
4. 手的朝向（用户两次反馈"手反了"，2026-11-07 加）：
   - 俯拍自己的手 → 应该看到**手背 + 指节**；整只摊开的掌心朝上就算可疑
   - **反手**：拇指跑到外侧、手腕与手背接不上、一只手同时露出手心和手背 = BAD
   - 手指的弯曲方向要和手掌一致，不能"手指从手背长出来"

回答格式（只回这两行，不要别的）：
第一行：OK 或 BAD
第二行：如果 BAD，一句话说哪里不对（不超过 20 字）

⚠️ **自拍时伸向镜头的两条手臂是正常的，不算多手。**
⚠️ **画面里有没有她，不归你判断** —— 拍什么由拍摄方案决定（第一人称/俯拍本来就看不到她）。
   你只管"多出来的人"，不要因为"没看到她"就判 BAD。
⚠️ **倾向判 OK**：这张是要发出去的，误判会把好图丢掉；只有你也觉得"确实明显不对"才判 BAD。`

/**
 * @param {object} o
 * @param {Buffer} o.buf      图（JPEG/PNG 字节）
 * @param {string} o.gateway  本地网关地址（如 http://127.0.0.1:18899/v1）
 * @param {string} o.key      网关 key
 * @param {object} [o.log]
 * @returns {Promise<{ok:boolean, why:string}>}
 */
export async function reviewImage({ buf, gateway, key, log = {}, timeoutMs = 20_000 }) {
  if (!buf || buf.length < 1024) return { ok: true, why: '' }
  if (!gateway || !key) return { ok: true, why: '' }
  try {
    const mime = buf[0] === 0xff ? 'image/jpeg' : 'image/png'
    const dataUrl = `data:${mime};base64,${buf.toString('base64')}`
    const body = {
      model: 'auto',
      stream: false,
      whale_pod_search: false,
      max_tokens: 120,
      messages: [
        { role: 'system', content: PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: '看看这张图有没有硬伤。' },
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
    if (!r.ok) {
      log.warn?.(`图片审核：网关 ${r.status}，放行`)
      return { ok: true, why: '' }
    }
    const j = await r.json().catch(() => null)
    const text = String(j?.choices?.[0]?.message?.content ?? '').trim()
    const first = (text.split('\n')[0] ?? '').trim()
    if (!/^BAD\b/i.test(first) && !/\bBAD\b/i.test(first)) return { ok: true, why: '' }
    const why = (text.split('\n')[1] ?? '').trim().slice(0, 60)
    log.warn?.(`图片审核：不合格 —— ${why || '（未说明）'}`)
    return { ok: false, why }
  } catch (e) {
    log.warn?.(`图片审核：调用失败，放行 — ${String(e?.message ?? e).slice(0, 60)}`)
    return { ok: true, why: '' }
  }
}

/**
 * **图文一致性核对**（2026-11-08 用户：「她假如要直接发的话，这种细节就没人看，也没人检查」）。
 *
 * 与 `reviewImage` 分工：那个查**硬伤**（多手 / 畸形 / 水印）；这个查**跟她自己描述对不对得上**。
 *
 * 现场事故：她描述「蓝点在**杯口**那圈，不是杯底」，生成图把蓝点画在**杯底** ——
 * 我方靠人工回复核三轮才发现；她自己发的时候没人核。
 *
 * ⚠️ 判据故意**收紧**：只有"明确矛盾"才算不通过（描述说杯口、图里在杯底）。
 *   拿不准一律放行 —— 跟「审核失败放行」同一条纪律：宁可发出去，
 *   也不要因为审核抽风把该发的图卡死。
 */
const MATCH_PROMPT = [
  '你是图片质检员。用户给你一张图 + 一句「画面应该是什么样」。',
  '只判断关键特征对不对：东西对不对、位置对不对、颜色/朝向对不对。',
  '不看美观、不看构图、不评画质。',
  `回答严格 JSON：{"arms": 数字, "hands": 数字, "why": "不超过20字"}`,
  '· 关键特征明显缺失或不一致（描述说杯口、图里在杯底）→ match=false，why 说清差在哪',
  '· 没有明显违反描述 → match=true',
  '· 看不清、拿不准 → match=true',
].join('\n')

export async function reviewMatches({ buf, expect, gateway, key, log = {}, timeoutMs = 20_000 }) {
  const want = String(expect ?? '').trim()
  if (!buf || buf.length < 1024 || !want) return { match: true, why: '没有可比对的内容' }
  if (!gateway || !key) return { match: true, why: '没有视觉通道' }
  try {
    const mime = buf[0] === 0xff ? 'image/jpeg' : 'image/png'
    const dataUrl = `data:${mime};base64,${buf.toString('base64')}`
    const body = {
      model: 'auto',
      stream: false,
      whale_pod_search: false,
      max_tokens: 120,
      messages: [
        { role: 'system', content: MATCH_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: `画面应该是：${want.slice(0, 200)}` },
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
    if (!r.ok) return { match: true, why: `网关 ${r.status}，放行` }
    const j = await r.json().catch(() => null)
    const txt = String(j?.choices?.[0]?.message?.content ?? '').trim()
    const m = /\{[\s\S]*\}/.exec(txt)
    if (!m) return { match: true, why: '解析不出来，放行' }
    const parsed = JSON.parse(m[0])
    return { match: parsed.match !== false, why: String(parsed.why ?? '').slice(0, 80) }
  } catch (e) {
    return { match: true, why: `核对出错（放行）：${String(e?.message ?? e).slice(0, 40)}` }
  }
}

/**
 * 数手臂/手掌（2026-11-08 用户：手多了、我感觉是你审查没写对）。
 * 开放式问"有没有硬伤"模型看不见多出的手臂；改成让它数数。
 */
const COUNT_PROMPT = [
  "数这张图里可见的手臂和手掌。",
  "手臂 = 从肩膀连下来的那条肢体（只露小臂也算一条）；手掌 = 能看到的掌/手。",
  "只数画面里真能看见的，被完全挡住的不要数。",
  `回答严格 JSON：{"arms": 数字, "hands": 数字, "why": "不超过20字"}`,
].join('\n')

export async function countLimbs({ buf, gateway, key, log = {}, timeoutMs = 20_000 }) {
  if (!buf || buf.length < 1024 || !gateway || !key) return { ok: true, why: "跳过" }
  try {
    const dataUrl = "data:image/jpeg;base64," + buf.toString("base64")
    const body = {
      model: "auto", stream: false, whale_pod_search: false, max_tokens: 80,
      messages: [
        { role: "system", content: COUNT_PROMPT },
        { role: "user", content: [{ type: "text", text: "数一下。" }, { type: "image_url", image_url: { url: dataUrl } }] },
      ],
    }
    const r = await fetch(String(gateway).replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!r.ok) return { ok: true, why: "网关 " + r.status }
    const j = await r.json().catch(() => null)
    const txt = String(j?.choices?.[0]?.message?.content ?? "")
    const m = /\{[\s\S]*\}/.exec(txt)
    if (!m) return { ok: true, why: "解析不出来" }
    const p = JSON.parse(m[0])
    const arms = Number(p.arms)
    const hands = Number(p.hands)
    if (Number.isFinite(arms) && arms > 2) return { ok: false, why: "数出 " + arms + " 条手臂" }
    if (Number.isFinite(hands) && hands > 2) return { ok: false, why: "数出 " + hands + " 只手掌" }
    return { ok: true, why: "arms=" + arms + " hands=" + hands }
  } catch (e) {
    return { ok: true, why: "计数出错（放行）" }
  }
}
