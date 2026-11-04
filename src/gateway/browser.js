/**
 * 最小 CDP 驱动 —— 用系统装好的 Chromium 内核浏览器（Edge/Chrome）**看一眼网页**。
 *
 * ## 为什么需要它
 * 有些页面**不用浏览器根本看不到内容**。实测（禁漫阅读器）：
 * ```
 * · 图片地址是 JS 拼出来的（base_url + name + expires），静态 HTML 里没有
 * · 图还被 scramble（切成横条打乱），要靠站点自己的 JS 还原
 * · 整页是**滚动按需加载**的 —— 不滚就不给图
 * ```
 * 逆向前端 JS 能做，但**前端一改就废**。用真浏览器则这些全免：
 * **JS 照跑、图照还原、滚一下照加载**。
 *
 * 用户的原话是「只单独页面抓取看呢，看完就扔，用 ego」—— 对，
 * 而且「看完就扔」这条正好：**用完把临时 profile 整个删掉，什么都不留**。
 *
 * ## ★ 为什么自己写，不用 puppeteer/playwright
 * whale-pod 是**零依赖**的（`package.json` 里 dependencies 是空的），
 * 这是刻意的 —— 装一个 puppeteer 会拖进一两百兆。
 *
 * 而 CDP 只需要**一个 WebSocket**，**Node 22+ 自带 `WebSocket`** ✓
 * 所以这里只有：启动进程 + 连 WebSocket + 发 JSON 命令，**零依赖**。
 *
 * ## 实测过的零件（2026-11-02）
 * ```
 * Node WebSocket        function（v24.20.0）
 * Edge --headless=new + --remote-debugging-port  → 200，webSocketDebuggerUrl 有
 * Chrome                没装（所以**候选里要带 Edge**）
 * ```
 *
 * ## 边界（刻意不做的事）
 * · 不做通用爬虫 —— 只做「打开一页、跑点 JS、截个图、关掉」
 * · 不复用 profile —— 每次都新建临时的，**用完就删**（"看完就扔"）
 * · 不装扩展、不登账号、不持久化 cookie
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

/** 可能的 Chromium 内核浏览器。⚠️ **Edge 一定要在列表里** —— 这台机器只有 Edge。 */
const CANDIDATES = [
  process.env.WHALE_BROWSER_EXE,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)

/** 找一个能用的浏览器。找不到返回 null（调用方据此降级，别抛）。 */
export function findBrowser() {
  for (const c of CANDIDATES) {
    try { if (fs.existsSync(c)) return c } catch { /* ignore */ }
  }
  return null
}

/** 一个极小的 CDP 客户端：连上、发命令、等回包。 */
class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') } catch { return }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        clearTimeout(timer)
        if (msg.error) reject(new Error(msg.error.message ?? 'cdp error'))
        else resolve(msg.result)
      }
    })
  }

  /**
   * 发一条 CDP 命令。
   *
   * ⚠️⚠️ **`sessionId` 必须带上**（2026-11-02 实测踩的）。
   *
   * 用 `Target.attachToTarget({flatten:true})` 建的会话，**所有页面级命令
   * 都要在报文里带 `sessionId`**。不带的话命令会被当成**浏览器级**的发出去，
   * 于是报：
   *     `Error: 'Runtime.evaluate' wasn't found`
   * —— 因为 `Runtime.evaluate` 是**页面级**方法，浏览器级根本没有这个名字。
   *
   * 这个错很有迷惑性：看着像"这个 CDP 方法不存在/版本不支持"，
   * 其实是**会话没对上**。而且它只在 flatten 模式下出现。
   */
  send(method, params = {}, timeoutMs = 30000, sessionId = null) {
    const id = ++this.id
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try { this.ws.send(JSON.stringify(payload)) } catch (e) { reject(e) }
    })
  }

  close() { try { this.ws.close() } catch { /* ignore */ } }
}

/**
 * 一个**绑定了会话**的页面句柄 —— 把 sessionId 藏起来，别每次手写。
 *
 * 有它之后调用点就干净了：
 *     await p.eval('document.title')
 *     await p.screenshot()
 * 而不是每次记得传第四个参数（**忘了就是上面那个 `wasn't found`**）。
 */
export class PageHandle {
  #cdp
  #sessionId
  targetId

  constructor(cdp, targetId, sessionId) {
    this.#cdp = cdp
    this.targetId = targetId
    this.#sessionId = sessionId
  }

  send(method, params = {}, timeoutMs = 30000) {
    return this.#cdp.send(method, params, timeoutMs, this.#sessionId)
  }

  /** 跑一段 JS，返回值（`returnByValue`）。 */
  async eval(expression, timeoutMs = 15000) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs)
    if (r?.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? '页面里那段 JS 抛错了')
    }
    return r?.result?.value
  }

  /** 截图，返回 base64（jpeg）。 */
  async screenshot({ quality = 72 } = {}) {
    const r = await this.send('Page.captureScreenshot', { format: 'jpeg', quality }, 30000)
    return r?.data ?? ''
  }

  /**
   * ★ **按当前视口截图，并在浏览器里就缩好。**
   *
   * 为什么用 `clip.scale` 而不是截完再拿 sharp 缩：
   * ```
   * · 少一个依赖（sharp 是 DSH 那边提取出来的，whale-pod 自己不该依赖它）
   * · 少一次解码/编码（原图 1000x1300 再缩，白费 CPU）
   * · 拿到的 base64 直接就是"能给视觉模型看的尺寸"
   * ```
   * 实测（2026-11-02 无头 Edge）：视口 968x1304，
   * scale 0.6 → 约 580x780，jpeg 40KB 上下。
   *
   * ⚠️ `clip` 的坐标是**CSS 像素**，且要带 `captureBeyondViewport: false` ——
   *    否则它会去截"整页"（11 万像素高那种），又慢又没意义。
   */
  async screenshotViewport({ scale = 0.6, quality = 70 } = {}) {
    const box = await this.eval('JSON.stringify({x:window.scrollX||0,y:window.scrollY||0,w:innerWidth,h:innerHeight})')
    const { x, y, w, h } = JSON.parse(String(box ?? '{}'))
    if (!w || !h) throw new Error('拿不到视口尺寸')
    const r = await this.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality,
      captureBeyondViewport: false,
      clip: { x, y, width: w, height: h, scale },
    }, 30000)
    return r?.data ?? ''
  }

  /** 滚到某个位置（返回实际落点，用于判断有没有滚到底）。 */
  async scrollTo(y) {
    await this.eval(`window.scrollTo(0, ${Number(y) || 0}); 0`)
    return Number(await this.eval('window.scrollY')) || 0
  }

  /** 页面总高。 */
  async scrollHeight() {
    return Number(await this.eval('document.documentElement.scrollHeight')) || 0
  }

  /**
   * 把多张截图**拼成一张网格图**（省 token）。
   *
   * ## 为什么在页面里拼
   * whale-pod 是**零依赖**的，没有 sharp / canvas 库 ✗。
   * 但图本来就在浏览器里 —— 所以**在页面上下文用 canvas 拼** ✓，
   * 不用引任何东西（`page.eval` 已经带 `awaitPromise: true` ✓，见上面 138 行）。
   *
   * ## ⚠️⚠️ 为什么是**网格**不是竖排（2026-11-03 实测结论）
   * ```
   *   竖排 6 屏（各 456px 高）= 339 × 2736 → 比例 1:8 **窄长条**
   *      → 视觉模型会把长条缩得更狠，每屏只剩很薄一条 ✗
   *   网格 3 列 × 2 行       = 1017 × 912 → 比例 **≈1:1**
   *      → 缩得最少，每格还能看出"在干嘛" ✓
   * ```
   * **一张图的 token 是固定的**，所以要把格子摆成**接近方形**，不是拉成条 ——
   * 跟 B 站分镜图（10×10 网格）是同一个道理。
   *
   * @param {string[]} parts 各张图的 base64（jpeg）
   * @param {object} [opts]
   * @param {number} [opts.cols]       列数；默认按数量取近似方阵（6 → 3 列 × 2 行）
   * @param {number} [opts.quality]    jpeg 质量，默认 0.72
   * @param {number} [opts.timeoutMs]  默认 60s（加载 + 绘制 6 张图要时间）
   * @returns {Promise<string>} 拼好的 base64；**一张或零张时原样返回**
   */
  async stitchGrid(parts, opts = {}) {
    const list = (Array.isArray(parts) ? parts : []).filter(Boolean)
    if (list.length === 0) return ''
    if (list.length === 1) return list[0]   // 一张就别拼（多一次编解码没意义）
    const { cols, quality = 0.72, timeoutMs = 60_000, maxWidth = 1200 } = opts
    const n = list.length
    const c = Math.max(1, Math.min(n, Number(cols) || Math.ceil(Math.sqrt(n))))
    /*
     * ⚠️ base64 只含 `A-Za-z0-9+/=`，塞进字符串表达式是安全的（无需额外转义）。
     * ⚠️ 拼图宽高按**实际图片尺寸**算（各屏高度可能不完全一致）。
     */
    const expr = `(async () => {
      const b64s = ${JSON.stringify(list)};
      const cols = ${c};
      const imgs = [];
      for (const b of b64s) {
        const im = new Image();
        im.src = 'data:image/jpeg;base64,' + b;
        await im.decode();
        imgs.push(im);
      }
      const cw = Math.max(...imgs.map((i) => i.width));
      const ch = Math.max(...imgs.map((i) => i.height));
      const rows = Math.ceil(imgs.length / cols);
      /*
       * ★★ **必须缩到 maxWidth 以内**（2026-11-03 实测教训）。
       * 快路直下的是**全分辨率**页（960×1403），6 页拼成 3×2 = **2880×2806 / 810KB**
       * —— 太大，上游会挂死 ✗。缩到总宽 ≤ maxWidth 之后约 1200×1170 / 一两百 KB ✓
       */
      const totalW = cw * cols;
      const k = Math.min(1, ${Number(maxWidth) || 1200} / totalW);
      const tw = Math.max(1, Math.round(cw * k));
      const th = Math.max(1, Math.round(ch * k));
      const cv = document.createElement('canvas');
      cv.width = tw * cols;
      cv.height = th * rows;
      const g = cv.getContext('2d');
      g.fillStyle = '#000';
      g.fillRect(0, 0, cv.width, cv.height);
      imgs.forEach((im, i) => {
        const x = (i % cols) * tw;
        const y = Math.floor(i / cols) * th;
        g.drawImage(im, x, y, tw, th);
      });
      return cv.toDataURL('image/jpeg', ${quality}).split(',')[1] || '';
    })()`
    const out = String((await this.eval(expr, timeoutMs)) ?? '')
    return out
  }

  /**
   * 导航并**等到页面基本就绪**。
   *
   * ⚠️ 2026-11-02 实测踩的：只在 `Target.createTarget({url})` 里给 URL
   *    **不等于加载完了** —— 紧接着 `eval('document.title')` 拿到的是空串、
   *    `imgs: 0`，看着像"页面是空的"，其实是**还没开始加载**。
   *    所以这里显式 `Page.navigate` 并**轮询 `document.readyState`**。
   *
   * ⚠️ 但「readyState === complete」**不等于"图都出来了"** ——
   *    这个站的整页是**滚动按需加载**的，就绪之后还得滚。
   *    所以这里只保证"文档就绪"，**业务层要自己再等/再滚**
   *    （见 jm-read 那边的用法）。
   *
   * @returns {boolean} 是否等到就绪（超时返回 false，不抛）
   */
  async goto(url, timeoutMs = 40000) {
    try { await this.send('Page.navigate', { url }, timeoutMs) } catch { return false }
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const st = await this.eval('document.readyState', 5000)
        if (st === 'complete' || st === 'interactive') return true
      } catch { /* 导航中 eval 会失败，属正常 */ }
      await sleep(300)
    }
    return false
  }
}

/**
 * 无头模式下浏览器**自报家门**会带 `HeadlessChrome` —— 抹掉它。
 *
 * ## 为什么
 * 实测（2026-11-02）无头 Edge 打开禁漫：
 * ```
 * navigator.userAgent.includes('Headless')  →  true   ★ 唯一暴露的一处
 * navigator.webdriver                       →  false  ✓ 没暴露
 * navigator.plugins.length                  →  5      ✓ 像正常浏览器
 * ```
 * `UA 里带 Headless` 是**最常被反爬用来一刀切**的特征 —— 而且被挡之后
 * 表现是"页面空的/挑战页"，用户根本猜不到是**因为无头**。
 *
 * ## 这不是"绕过检测"，是"别自报家门"
 * 它只是让浏览器**不去声明自己是无头**，UA 其余部分照实写。
 * 目的很实际：**避免被误挡**，而不是骗过什么风控。
 * （同类思路见别处那条：**宁可明说"我打不开"，也不要让它猜内容**。）
 *
 * ⚠️ 用 `--user-agent=` 而不是 CDP 的 `Emulation.setUserAgentOverride` ——
 *    前者从**第一个请求**就生效（有些站看首页请求的 UA 就决定给不给内容），
 *    后者要等页面创建后才覆盖，可能已经晚了。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/**
 * 打开一个**一次性的**浏览器会话。
 *
 * @param {object} [opts]
 * @param {(lv:string,msg:string)=>void} [opts.log]
 * @param {number} [opts.width]  视口宽（默认 1000 —— 够看，又别太大）
 * @param {number} [opts.height]
 * @param {number} [opts.startTimeoutMs]
 * @param {boolean} [opts.headless]  默认 true；false = 开有界面的窗口（登录用）
 * @param {string} [opts.profileDir] 持久 profile 目录；给了就不删（登录态留着）
 * @returns {Promise<{cdp:Cdp, exe:string, profileDir:string, close:()=>Promise<void>}|null>}
 */
export async function openBrowser(opts = {}) {
  const log = opts.log ?? (() => {})
  const exe = findBrowser()
  if (!exe) {
    log('warn', 'browser：没找到 Chrome/Edge，用不了"真浏览器看图"这条路')
    return null
  }

  // 随机端口：避免跟用户自己开的调试端口撞
  const port = 19000 + Math.floor(Math.random() * 900)
  /*
   * ★ 持久 profile（2026-11-04）：登录态要留得住。
   *   给了 `opts.profileDir` 就用它、**关掉也不删**；没给就还是临时目录（用完即删）。
   *   配合 `headless:false` 可以开一个有界面的窗口让用户手动登录一次。
   */
  const persistent = typeof opts.profileDir === 'string' && opts.profileDir.trim() !== ''
  const profileDir = persistent ? opts.profileDir : fs.mkdtempSync(path.join(os.tmpdir(), 'whale-browser-'))
  if (persistent) { try { fs.mkdirSync(profileDir, { recursive: true }) } catch { /* ignore */ } }
  const headless = opts.headless !== false

  const args = [
    ...(headless ? ['--headless=new'] : []),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    // ★ 抹掉无头痕迹：默认 UA 是 `HeadlessChrome/...`，很多站直接一刀切。
    //   用启动参数而不是 CDP 覆盖 —— 它从**第一个请求**就生效（见上面注释）。
    `--user-agent=${opts.userAgent ?? UA}`,
    // ⚠️ 别用 --no-sandbox（Windows 上不需要，写上去反而会被某些版本拒绝）
    `--window-size=${opts.width ?? 1000},${opts.height ?? 1400}`,
    'about:blank',
  ]

  const child = spawn(exe, args, { stdio: 'ignore', windowsHide: true, detached: false })

  const cleanup = async () => {
    try { child.kill('SIGKILL') } catch { /* ignore */ }
    // 持久 profile 绝不删 —— 删了登录态就没了
    if (persistent) return
    /*
     * ⚠️ 「看完就扔」：**临时 profile 整个删掉**。
     *    里面会有 cookie、缓存、可能还有页面资源 —— 不留任何痕迹。
     *    Windows 上浏览器刚被杀时文件句柄可能还没释放，
     *    所以删不掉就**留个标记下次再删**，不要在这里死等。
     */
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(profileDir, { recursive: true, force: true }); return } catch { await sleep(300) }
    }
    try { fs.writeFileSync(`${profileDir}.delete-me`, '') } catch { /* ignore */ }
  }

  // 等 CDP 端口起来
  const deadline = Date.now() + (opts.startTimeoutMs ?? 20000)
  let version = null
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (r.ok) { version = await r.json(); break }
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  if (!version?.webSocketDebuggerUrl) {
    log('warn', `browser：等了 ${opts.startTimeoutMs ?? 20000}ms 还没起来`)
    await cleanup()
    return null
  }

  const ws = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 8000)
    ws.addEventListener('open', () => { clearTimeout(t); resolve() })
    ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('CDP WebSocket 连不上')) })
  })

  const cdp = new Cdp(ws)
  log('info', `browser：${path.basename(exe)} 已启动（${headless ? 'headless' : '有界面'}，端口 ${port}${persistent ? '，持久 profile' : ''}）`)

  return { cdp, exe, profileDir, close: cleanup }
}

/**
 * 开一个标签页并绑定会话。返回一个 `PageHandle`（已带好 sessionId）。
 *
 * ⚠️ 用 `Target.createTarget` + `Target.attachToTarget(flatten:true)`，
 *    比去 `/json/new` 拿新页面再连省一次握手。
 */
export async function newPage(cdp, url = 'about:blank') {
  const { targetId } = await cdp.send('Target.createTarget', { url })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  // 这两个 enable 是**页面级**的，必须带 sessionId
  await cdp.send('Page.enable', {}, 10000, sessionId).catch(() => {})
  await cdp.send('Runtime.enable', {}, 10000, sessionId).catch(() => {})
  return new PageHandle(cdp, targetId, sessionId)
}

/** 关掉一个标签页（传 `PageHandle` 或 targetId 都行）。 */
export async function closePage(cdp, pageOrTargetId) {
  const targetId = typeof pageOrTargetId === 'string' ? pageOrTargetId : pageOrTargetId?.targetId
  if (!targetId) return
  try { await cdp.send('Target.closeTarget', { targetId }, 5000) } catch { /* ignore */ }
}