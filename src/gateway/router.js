/**
 * 路由策略：把「模型名」解析成一组候选 provider/model，按优先级依次尝试。
 *
 * 设计目标：
 *   1. **免费优先** —— 默认先把免费渠道试一遍（Gemini/EAC/账号渠道），
 *      全失败才走付费兜底。这是省钱的关键。
 *   2. **对客户端透明** —— 客户端只说 `model: "auto"`，不需要知道背后是谁。
 *   3. **可观测** —— 每次尝试的结果（成功/失败原因/耗时）都记录下来，
 *      供 Web UI 和日志展示。
 *
 * 模型名约定（与常见 OpenAI 兼容端点保持一致，降低用户迁移成本）：
 *   auto                      按策略自动选
 *   free/<provider>/<model>   指定免费渠道
 *   paid/<model>              指定付费兜底
 *   <provider>/<model>        直接指定（透传）
 *   <裸模型名>                 按注册表匹配
 */

/**
 * 免费渠道的默认优先顺序（越靠前越先试）。
 *
 * ## 排序依据：**实测可用性**，不是字母序
 *
 * 早期版本按首字母排（buddy 打头），理由是"可用性会变，写死最优顺序过几天
 * 就不准"。这个理由对**单次**判断成立，但忽略了一个更稳定的量：
 * 各渠道的**额度模型**差异很大 —— 账号型渠道（buddy / workbuddy）吃的是
 * 单个账号的配额，几百万 token 就能烧穿并进入小时级冷却；而免费车道
 * （opencode 的 *-free、cline 的 stealth/*）是按请求限速，没有"额度用光"这种状态。
 *
 * 实测证据（2026-10-17，同一台机器）：
 *   · buddy 当天累计 ~216 万 input token 后进入持续 429，每次重试都把解禁
 *     时间往后推一小时，实际上整天不可用
 *   · 同一时段 opencode / cline / codearts / gemini 全部正常
 *
 * 所以把"额度型"渠道排在"限速型"之后：前者烧穿时，前面那几个已经能接住，
 * 不必每次都先等一个 429 再往下走。这个顺序比字母序更抗时间。
 *
 * 用户仍可在「模型」页（或侧栏模型卡片）拖动覆盖 —— 配置一旦存在就优先。
 */
export const DEFAULT_FREE_ORDER = [
  // ── 第一梯队：免费车道（限速型，无额度耗尽状态）───────────────
  'opencode',
  'cline',
  'codearts',
  'gemini',
  'lobsterai',
  'loomy',
  'raccoon',
  'minimax',
  'zcode',
  // ── 第二梯队：账号型（吃单账号配额，可能整天冷却）──────────────
  'workbuddy',
  'buddy',
  // ── 第三梯队：其余 ─────────────────────────────────────────
  'qoder',
  'qodercn',
  'trae',
]

/**
 * 各渠道的默认模型偏好（按顺序试第一个可用的）。
 *
 * ⚠️ 这张表要**覆盖全部渠道**，哪怕是空数组。
 *    漏掉一个渠道（比如 2.3.0 新增的 opencode）会让它被误判成
 *    "没有已知模型 → auto 会跳过"，而实际上目录里查得到它的模型。
 *    空数组的意思是"这个渠道没有内置偏好，去目录里现查"。
 *    测试 check-router 有一条断言专门盯这个。
 *
 * ## 为什么大多数渠道以前是空数组、现在填上了
 *
 * 模型目录是**启动后异步刷新**的（要打十几个渠道的网络）。冷启动那几秒
 * `catalog` 是空的，`firstModelOf()` 全返回 null → auto 解析出零个候选 →
 * 请求直接失败（用户看到"刚启动不能用，等几秒又好了"）。router.js 里原本
 * 有个兜底分支专门处理这种情况，但它只对**填了 hint 的渠道**有效 ——
 * 而以前只有 gemini 填了，等于兜底几乎不起作用。
 *
 * 下面的取值全部来自 channel-pack 各产品的 `fallbackModels[0]`
 * （`vendor/channel-pack/pack.js` 里各 `*_FALLBACK_MODELS` 的第一项），
 * 也就是各渠道自己声明的默认模型，不是猜的。
 */
export const PROVIDER_MODEL_HINTS = {
  gemini: ['gemini-3.8-flash-medium', 'gemini-3.8-flash', 'gemini-3.8-flash-low', 'gemini-3.8-flash-high'],
  // 免费车道：无额度耗尽，最稳的一批
  opencode: ['big-pickle'],
  cline: ['stealth/space-bunny-alpha'],
  codearts: [],
  lobsterai: ['deepseek-v4-flash'],
  loomy: ['deepseek-v4-flash-0731'],
  raccoon: ['sn-sensenova-6-8-flash'],
  minimax: ['MiniMax-M3.1-Flash-Preview'],
  zcode: ['GLM-5.3-Flash'],
  // 账号型：吃单账号配额
  workbuddy: ['default-model'],
  buddy: ['hy4-preview'],
  // 其余
  qoder: ['auto'],
  qodercn: ['auto'],
  trae: ['DeepSeek-V4-Flash-Official'],
}


/**
 * 按「用户配置的顺序」重排 provider 列表。
 *
 * 为什么需要这个函数：`llm.providers` 是 channel-pack 的**注册顺序**
 * （codearts、buddy…gemini 排第 12），而 gemini 才是验证过最稳的那个。
 * 用户可以在「模型」页拖优先级并存进 `gateway.freeProviders` ——
 * 但如果不在这里重排，那份配置**根本不会生效**（曾经就是这样：
 * 界面上调了顺序，实际仍按注册顺序走）。
 *
 * 规则：先按 order 里出现的顺序取，order 没提到的按原顺序追加到后面
 * （这样新装/新注册的渠道不会被丢掉）。
 *
 * @param {string[]} providers  实际注册的 provider
 * @param {string[]} order      用户配置的优先顺序
 * @returns {string[]}
 */
export function applyFreeOrder(providers, order) {
  const list = providers ?? []
  const want = (order ?? []).filter((p) => list.includes(p))
  if (want.length === 0) return list.slice()
  const rest = list.filter((p) => !want.includes(p))
  return [...want, ...rest]
}

/**
 * 解析客户端给的 model 字段 → 候选列表。
 *
 * @param {string} model      客户端请求的模型名
 * @param {object} ctxInfo    运行时信息
 * @param {string[]} ctxInfo.freeProviders  实际已注册的免费 provider 列表
 * @param {string[]} [ctxInfo.freeOrder]    用户配置的优先顺序（会重排 freeProviders）
 * @param {string[]} [ctxInfo.disabledProviders]  被禁用的渠道（会被排除）
 * @param {object} ctxInfo.fallback         { enabled, provider, model }
 * @param {Array<{provider:string,id:string}>} ctxInfo.catalog  已发现的模型目录（可能为空）
 * @returns {Array<{provider:string, model:string, kind:'free'|'paid'|'direct', why:string}>}
 */
export function resolveCandidates(model, ctxInfo = {}) {
  // 被禁用的渠道直接排除 —— 用户关掉它就是不希望它被尝试（连报错都不用）
  const disabled = ctxInfo.disabledProviders ?? []
  // 应用用户配置的优先级顺序（没配就用注册顺序），再去掉禁用的
  const free = applyFreeOrder(ctxInfo.freeProviders ?? [], ctxInfo.freeOrder)
    .filter((p) => !disabled.includes(p))
  const catalog = ctxInfo.catalog ?? []
  const fallback = ctxInfo.fallback ?? {}
  const raw = String(model ?? 'auto').trim()

  // 自备渠道提供的默认模型（provider id → 模型名）。
  // 为什么需要：PROVIDER_MODEL_HINTS 是给 DSH 那 14 个渠道写死的，
  // 而自备渠道（ollama/deepseek/用户自定义）的名字根本不在里面 ——
  // 若不额外处理，auto 模式会把它们整批跳过，导致"配了渠道却用不上"。
  const selfModels = ctxInfo.selfModels ?? {}
  /** 取某个 provider 的首选模型：先查内置 hint，再查自备表，再查目录。 */
  const firstModelOf = (p) => {
    const hinted = PROVIDER_MODEL_HINTS[p] ?? []
    if (hinted.length > 0) return hinted[0]
    if (selfModels[p]) return selfModels[p]
    const hit = catalog.find((m) => m.provider === p)
    return hit ? (hit.id ?? hit.model) : null
  }

  // ── 1. 显式指定 provider/model ─────────────────────────────
  if (raw.includes('/')) {
    const pk = raw.slice(0, raw.indexOf('/'))
    const rest = raw.slice(raw.indexOf('/') + 1)

    if (pk === 'free') {
      // free/<provider>/<model> 或 free/<model>
      const parts = rest.split('/')
      if (parts.length >= 2) {
        return [{ provider: parts[0], model: parts.slice(1).join('/'), kind: 'free', why: '客户端指定 free 渠道' }]
      }
      // free/<model>：在所有免费渠道里找
      return free.map((p) => ({ provider: p, model: rest, kind: 'free', why: '客户端指定 free 模型，遍历渠道' }))
    }
    if (pk === 'paid') {
      if (!fallback.enabled) return []
      return [{ provider: fallback.provider, model: rest || fallback.model, kind: 'paid', why: '客户端指定付费' }]
    }
    // 其它一律当 provider id 透传
    if (free.includes(pk) || pk === fallback.provider) {
      return [{ provider: pk, model: rest, kind: pk === fallback.provider ? 'paid' : 'free', why: '客户端指定 provider' }]
    }

    // 未知 provider：**先确认 raw 整体不是"模型名本身带斜杠"**。
    //
    // 为什么必须查这一步：不少厂商把组织名写进模型 id，例如
    //   aion-labs/aion-2.0、deepseek/deepseek-v4.1-flash、cline-pass/xxx
    // 直接按 provider/model 拆会得到一个不存在的 provider，
    // 报出"未配置的渠道：aion-labs"这种让人一头雾水的错。
    // 目录里能查到 → 说明它是模型名，继续往下走裸模型名逻辑。
    const looksLikeModelName = catalog.some((m) => (m.id ?? m.model) === raw)
    if (!looksLikeModelName) {
      return [{ provider: pk, model: rest, kind: 'direct', why: '未知 provider，透传' }]
    }
  }

  // ── 2. auto：免费遍历 + 付费兜底 ───────────────────────────
  if (raw === 'auto' || raw === '') {
    const out = []
    for (const p of free) {
      const m = firstModelOf(p)
      if (!m) continue   // 连一个模型名都不知道，跳过（避免空请求）
      out.push({ provider: p, model: m, kind: 'free', why: `auto：${p} 首选模型` })
    }
    // ⚠️ 一个都没有时，用**内置 hints** 再兜一次。
    //
    // 为什么：模型目录是**启动后异步刷新**的（要打十几个渠道的网络），
    // 冷启动那几秒 catalog 是空的 —— 于是 firstModelOf 全部返回 null，
    // auto 解析出零个候选，请求直接 400「免费渠道为空」。
    // 用户看到的是"刚启动时不能用，等几秒又好了"，很难理解。
    // 内置 hints 是静态的，不依赖网络，用它先撑住这几秒。
    if (out.length === 0) {
      for (const p of free) {
        const hinted = (PROVIDER_MODEL_HINTS[p] ?? [])[0]
        if (!hinted) continue
        out.push({ provider: p, model: hinted, kind: 'free', why: `auto：${p} 内置默认（目录未就绪）` })
      }
    }
    // 付费兜底只在**它确实存在**时才追加。
    //
    // 为什么：默认配置里有一条 `deepseek-official` 兜底，而那个渠道要
    // DSH 凭据才有。没 DSH 的用户如果它被当成有效候选，会得到
    // "未配置的渠道：deepseek-official" —— 而且这条错误信息会盖住
    // 真正能用的自备渠道的失败原因，让人完全摸不着头脑。
    if (fallback.enabled && fallback.provider && fallback.model) {
      const known = free.includes(fallback.provider) || Object.keys(selfModels).includes(fallback.provider)
      if (known) {
        out.push({ provider: fallback.provider, model: fallback.model, kind: 'paid', why: 'auto：付费兜底' })
      }
    }
    return out
  }

  // ── 3. 裸名字恰好是某个渠道 id ─────────────────────────────
  //
  // 例：客户端写了 "ollama"、"gemini"。直觉上这是"用那个渠道"，
  // 但如果不特判，代码会走到第 4 步 —— 在所有渠道里各试一个叫
  // "ollama" 的**模型**（大概率 404），白跑好几轮才轮到对的那个。
  //
  // 所以这里优先：命中渠道 id 就用该渠道的默认模型，并排在候选最前。
  // 其余渠道的同名尝试仍保留在后面作兜底（用户可能真的有个同名模型）。
  if (free.includes(raw)) {
    const m = firstModelOf(raw)
    if (m) {
      const rest = free
        .filter((p) => p !== raw)
        .map((p) => ({ provider: p, model: raw, kind: 'free', why: '其余渠道试同名模型' }))
      return [{ provider: raw, model: m, kind: 'free', why: `${raw} 是渠道名，用其默认模型` }, ...rest]
    }
  }

  // ── 4. 裸模型名：查目录，找在哪几家有 ───────────────────────
  //
  // 同一个模型常在多处可用（例：deepseek-v4.1-flash 在 buddy/workbuddy/trae 都有）。
  // 客户端只写模型名时，**用哪家由渠道优先级决定** —— 也就是用户在
  // 「模型」页拖出来的顺序（已由 applyFreeOrder 应用在 free 上）。
  const hits = catalog.filter((m) => m.id === raw || m.model === raw)
  if (hits.length > 0) {
    // 排序键：free 数组里的下标（越靠前越优先）；
    // 不在 free 里的（自备渠道 / 付费兜底）排到后面。
    const rank = (p) => {
      const i = free.indexOf(p)
      if (i >= 0) return i              // 免费渠道：按用户配置的优先级
      if (p === fallback.provider) return 9000   // 付费兜底：倒数第二
      return 8000                       // 自备渠道：在免费之后、兜底之前
    }
    const out = []
    for (const h of hits.slice(0, 20)) {
      const isFree = free.includes(h.provider)
      out.push({
        provider: h.provider,
        model: h.id ?? h.model,
        kind: isFree ? 'free' : 'paid',
        why: `目录命中 ${h.provider}`,
      })
    }
    return out.sort((a, b) => rank(a.provider) - rank(b.provider))
  }

  // ── 5. 都没有：当成各免费渠道的同名模型试 ──────────────────
  const out = free.map((p) => ({ provider: p, model: raw, kind: 'free', why: '按裸模型名在免费渠道试' }))
  if (fallback.enabled && fallback.provider) {
    out.push({ provider: fallback.provider, model: raw, kind: 'paid', why: '付费兜底（同名模型）' })
  }
  return out
}

/**
 * 按候选顺序尝试，返回第一个成功的流。
 *
 * 注意：失败重试发生在**建立流之前**。一旦流已经开始产出 chunk，
 * 就不再切换 provider —— 否则客户端会看到重复/错乱的内容。
 *
 * @param {object} opts
 * @param {object} opts.llm        ctx.llm
 * @param {Array}  opts.candidates
 * @param {object} opts.request    OpenAI 风格的请求（已转成 dsh-llm 的 options）
 * @param {(e:object)=>void} [opts.onAttempt]
 * @param {number} [opts.probeTimeoutMs] 建立流阶段的超时
 * @returns {Promise<{stream:AsyncIterable, picked:object, attempts:Array}>}
 */
export async function openFirstAvailable(opts) {
  const { llm, candidates, request, onAttempt } = opts
  const attempts = []
  const errors = []

  for (const c of candidates) {
    const t0 = Date.now()
    try {
      const stream = llm.stream({
        provider: c.provider,
        model: c.model,
        ...request,
      })

      // 取首块判断「是否真的能用」。
      // 必须用 takeFirst + resume 保住原迭代器，否则会关掉整个流。
      const { it, first } = takeFirst(stream)
      const firstResult = await first

      if (firstResult.done) {
        // 空流：当成功但没有输出
        attempts.push({ ...c, ok: true, ms: Date.now() - t0, note: 'empty-stream' })
        onAttempt?.(attempts.at(-1))
        return { stream: resume(it, firstResult), picked: c, attempts }
      }

      if (isErrorChunk(firstResult.value)) {
        const msg = firstResult.value?.reason?.failure?.message ?? 'unknown error'
        attempts.push({ ...c, ok: false, ms: Date.now() - t0, error: msg })
        onAttempt?.(attempts.at(-1))
        errors.push(`${c.provider}/${c.model}: ${msg}`)
        try { await it.return?.() } catch { /* ignore */ }
        continue
      }

      attempts.push({ ...c, ok: true, ms: Date.now() - t0 })
      onAttempt?.(attempts.at(-1))
      return { stream: resume(it, firstResult), picked: c, attempts }
    } catch (e) {
      const msg = String(e?.message ?? e)
      attempts.push({ ...c, ok: false, ms: Date.now() - t0, error: msg })
      onAttempt?.(attempts.at(-1))
      errors.push(`${c.provider}/${c.model}: ${msg}`)
    }
  }

  const err = new Error(`所有候选渠道都失败：${errors.slice(0, 5).join('; ')}`)
  err.attempts = attempts
  throw err
}

// ── 辅助 ──────────────────────────────────────────────────────

const EMPTY = Symbol('empty')

/**
 * 取第一个 chunk 但不破坏原迭代器。
 *
 * ⚠️ 关键陷阱：不能直接 `for await (const c of stream) return c` ——
 * 那样提前 break 会调用迭代器的 `return()`，把**整个流关闭**，
 * 后续 chunk 全部丢失（表现为「HTTP 200 但内容为空」）。
 *
 * 正确做法：手动拿迭代器，调一次 next()，然后把「已取出首块 + 同一迭代器」
 * 一起交给下游继续消费。
 */
function takeFirst(stream) {
  const it = stream[Symbol.asyncIterator]()
  return { it, first: it.next() }
}

/** 把首块和迭代器剩余部分重新拼成一个流。 */
async function* resume(it, first) {
  if (first.done) return
  yield first.value
  while (true) {
    const r = await it.next()
    if (r.done) return
    yield r.value
  }
}

/** dsh-llm 用 finish+error 表示失败（凭据缺失、路由不通等）。 */
function isErrorChunk(chunk) {
  return chunk?.type === 'finish' && chunk?.reason?.kind === 'error'
}
