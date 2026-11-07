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