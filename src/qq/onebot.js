/**
 * OneBot v11 客户端（QQ 协议端的标准接口）。
 *
 * ## 支持的方向
 *
 *   forward  —— 我们主动连协议端的 WebSocket（NapCat/SnowLuma 的「正向 WS」）✅
 *   reverse  —— 协议端连我们（「反向 WS」）✅
 *   http     —— 用 HTTP API 发消息（比 WS 更可靠，因为发消息需要返回值）✅
 *
 * ## 为什么两种都要支持
 *
 *   - **forward** 适合协议端固定在一台机器上（连它的固定端口）。
 *   - **reverse** 适合我们不知道协议端何时上线（它主动连过来），
 *     而且 NapCat/SnowLuma 的「反向 WS」配置更简单（只填一个地址）。
 *
 * 两者**可以同时开** —— 谁先连上就用谁。
 *
 * ## 兼容性
 *
 * OneBot v11 是事实标准：NapCat / SnowLuma / Lagrange / LLOneBot 都实现了它。
 * 所以这一层不绑定任何具体协议端 —— 换协议端只要改地址。
 *
 * ## 为什么用内置 WebSocket
 *
 * Node 22+ 有全局 `WebSocket`（undici 提供），是经过充分测试的实现。
 * 手写 RFC6455 帧解析既啰嗦又容易出边界 bug，没有必要。
 */

import http from 'node:http'
import { fetchWithProxyFallback } from '../net.js'
import crypto from 'node:crypto'

/** 一个 OneBot v11 连接。 */
export class OneBotClient {
  /**
   * @param {object} cfg   qq.onebot 配置
   * @param {object} deps
   * @param {object} deps.log
   * @param {Function} [deps.WebSocketImpl]  可注入（测试用）
   */
  constructor(cfg = {}, deps = {}) {
    this.cfg = {
      mode: cfg.mode ?? 'forward',        // forward | reverse | both
      wsUrl: cfg.wsUrl ?? '',
      httpUrl: cfg.httpUrl ?? '',
      accessToken: cfg.accessToken ?? '',
      // reverse 模式：我们监听的地址
      reverseHost: cfg.reverseHost ?? '127.0.0.1',
      reversePort: cfg.reversePort ?? 6199,
      reversePath: cfg.reversePath ?? '/onebot/v11/ws',
      reconnectMinMs: cfg.reconnectMinMs ?? 1000,
      reconnectMaxMs: cfg.reconnectMaxMs ?? 30000,
    }
    this.log = deps.log ?? {}
    this.WebSocketImpl = deps.WebSocketImpl ?? globalThis.WebSocket

    this.ws = null
    /** 反向 WS 服务端（reverse 模式用） */
    this.server = null
    /** 反向连进来的 socket（我们直接持有裸 socket，自己处理帧） */
    this.serverSockets = new Set()
    this.connected = false
    this.closed = false
    /** @type {Map<string, (v:any)=>void>} */
    this._pending = new Map()
    this._echo = 0
    this._handlers = { event: [], open: [], close: [], error: [] }
    this._delay = this.cfg.reconnectMinMs
    this._timer = null
    /** 简单统计 */
    this.stats = {
      received: 0, sent: 0, reconnects: 0, errors: 0,
      lastEventAt: 0, lastEventKind: '', lastErrorAt: 0, lastError: '',
      direction: null,          // 'forward' | 'reverse'（当前用哪种）
      reverseConns: 0,          // 反向连接累计次数
    }
  }

  on(event, fn) {
    if (!this._handlers[event]) this._handlers[event] = []
    this._handlers[event].push(fn)
    return this
  }

  _emit(event, ...args) {
    for (const fn of this._handlers[event] ?? []) {
      try { fn(...args) } catch (e) { this.log.warn?.(`onebot handler 错误：${String(e?.message ?? e)}`) }
    }
  }

  /** 建立连接（按模式：forward 连出去 / reverse 监听进来 / both 都做）。 */
  connect() {
    if (this.closed) return
    // ⚠️ 必须幂等：已连接就什么都不做。
    //
    //    原实现无条件走到 _connectForward()，而它每次都会 new WebSocket
    //    并覆盖 this.ws 引用 —— 旧 socket 不会关闭，它的事件监听还活着。
    //    于是同一个客户端同时挂着两条连接，NapCat 把同一条消息推两遍，
    //    bridge 处理两次：日志里出现毫秒级完全重复的决策记录，
    //    界面上同一条消息显示两次（实测确认）。
    //
    //    触发路径：index.js 启动时 connect 过一次；侧栏「一键启动」又调
    //    state.onebot.connect() 补连接 —— 第二次就把连接翻倍了。
    if (this.connected === true) return
    // 正在连（socket 已建、还没 open）也直接返回，别叠加
    if (this.ws && this.ws.readyState === 0) return

    const mode = this.cfg.mode

    if (mode === 'reverse' || mode === 'both') {
      this._startReverseServer()
    }
    if (mode === 'forward' || mode === 'both') {
      if (!this.cfg.wsUrl) {
        if (mode === 'forward') this.log.warn?.('onebot：未配置 wsUrl，无法连接')
      } else {
        this._connectForward()
      }
    }
  }

  /** 正向：我们连协议端。 */
  _connectForward() {
    if (this.closed) return
    if (typeof this.WebSocketImpl !== 'function') {
      this.log.warn?.('onebot：当前运行时没有 WebSocket 实现（需要 Node 22+）')
      return
    }
    try {
      const opts = this.cfg.accessToken
        ? { headers: { authorization: `Bearer ${this.cfg.accessToken}` } }
        : undefined
      this.ws = opts ? new this.WebSocketImpl(this.cfg.wsUrl, opts) : new this.WebSocketImpl(this.cfg.wsUrl)
    } catch (e) {
      this.log.warn?.(`onebot：WebSocket 创建失败 — ${String(e?.message ?? e)}`)
      return this._scheduleReconnect()
    }

    this.ws.addEventListener?.('open', () => {
      this.connected = true
      this.stats.direction = 'forward'
      this._delay = this.cfg.reconnectMinMs
      this.log.info?.(`onebot：已连接（forward）${this.cfg.wsUrl}`)
      this._emit('open')
    })
    this.ws.addEventListener?.('message', (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : String(ev.data ?? '')
      this.stats.received++
      this._onMessage(data)
    })
    this.ws.addEventListener?.('close', (ev) => {
      const wasConnected = this.connected
      this.connected = false
      if (wasConnected) this.log.warn?.(`onebot：连接断开（code=${ev?.code ?? '?'}）`)
      this._emit('close', ev)
      this._scheduleReconnect()
    })
    this.ws.addEventListener?.('error', (ev) => {
      // ⚠️ WebSocket 的 error 事件是个 Event 对象，**没有 message**。
      //    而 ev.error?.message 有时是空串（不是 undefined），
      //    `?? '未知错误'` 就不会兜底 —— 日志会打成光秃秃的
      //    "onebot："，完全看不出出了什么事（实测踩过）。
      //    所以这里显式判空，并且把 code / 连接地址带上。
      const detail = String(ev?.error?.message ?? ev?.message ?? '').trim()
      const code = ev?.code ?? ev?.error?.code
      const where = this.cfg.wsUrl || `:${this.cfg.reversePort}`
      this._noteError(detail
        ? `${detail}（${where}${code ? ' code=' + code : ''}）`
        : `连接出错${code ? '（code=' + code + '）' : ''} — ${where}`
          + (this.cfg.wsUrl ? '（协议端没起来？检查 NapCat 是否在运行）' : ''))
    })
  }

  /**
   * 反向：我们监听端口，协议端连进来。
   *
   * 这里手写 WebSocket 握手与帧编解码 —— 因为 Node 的全局 WebSocket
   * 只有客户端，没有服务端。但 OneBot 的流量很单一（JSON 文本帧），
   * 所以实现量可控，且不引入第三方库。
   */
  _startReverseServer() {
    if (this.server) return
    const { reverseHost, reversePort, reversePath } = this.cfg

    this.server = http.createServer((req, res) => {
      // 非 upgrade 请求：给个友好提示（有人在浏览器里打开了）
      res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('WhalePod OneBot reverse endpoint. This is a WebSocket endpoint.\n')
    })

    this.server.on('upgrade', (req, socket, head) => {
      // path 校验（允许带 query）
      const reqPath = (req.url ?? '/').split('?')[0]
      if (reqPath !== reversePath) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
        socket.destroy()
        return
      }
      // token 校验（若配置了）：支持 Authorization 头或 ?access_token=
      if (this.cfg.accessToken) {
        const auth = req.headers.authorization ?? ''
        const q = new URL(req.url ?? '/', 'http://x').searchParams.get('access_token') ?? ''
        const ok = auth === `Bearer ${this.cfg.accessToken}` || q === this.cfg.accessToken
        if (!ok) {
          this.log.warn?.('onebot：反向连接 token 校验失败，已拒绝')
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
          socket.destroy()
          return
        }
      }
      // 握手
      const key = req.headers['sec-websocket-key']
      if (!key) { socket.destroy(); return }
      const accept = crypto.createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64')
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      )
      socket.setNoDelay(true)

      const conn = { socket, buf: Buffer.alloc(0), alive: true }
      this.serverSockets.add(conn)
      this.stats.reverseConns++
      this.connected = true
      this.stats.direction = 'reverse'
      this.log.info?.(`onebot：协议端已连入（reverse ${reqPath}，来自 ${socket.remoteAddress}）`)
      this._emit('open')

      socket.on('data', (chunk) => {
        conn.buf = Buffer.concat([conn.buf, chunk])
        try { conn.buf = this._drainFrames(conn, conn.buf) } catch (e) {
          this._noteError(`解析帧失败：${String(e?.message ?? e)}`)
          this._dropReverse(conn)
        }
      })
      socket.on('close', () => this._dropReverse(conn, true))
      socket.on('error', (e) => { this._noteError(String(e?.message ?? e)); this._dropReverse(conn) })
    })

    this.server.on('error', (e) => {
      this._noteError(`反向 WS 服务端错误：${String(e?.message ?? e)}`)
      this.log.warn?.(`onebot：反向 WS 监听失败 — ${String(e?.message ?? e)}（端口 ${reversePort} 被占用？）`)
    })

    this.server.listen(reversePort, reverseHost, () => {
      this.log.info?.(`onebot：反向 WS 监听 ws://${reverseHost}:${reversePort}${reversePath}`)
    })
  }

  /** 解析反向连接的帧（简化版 RFC6455：文本/关闭/ping/pong）。 */
  _drainFrames(conn, buf) {
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f
      const masked = (buf[1] & 0x80) !== 0
      let len = buf[1] & 0x7f
      let off = 2
      if (len === 126) {
        if (buf.length < 4) return buf
        len = buf.readUInt16BE(2); off = 4
      } else if (len === 127) {
        if (buf.length < 10) return buf
        const big = buf.readBigUInt64BE(2)
        if (big > 16n * 1024n * 1024n) throw new Error('帧过大')
        len = Number(big); off = 10
      }
      const maskLen = masked ? 4 : 0
      if (buf.length < off + maskLen + len) return buf

      let payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len))
      if (masked) {
        const mask = buf.subarray(off, off + 4)
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
      }
      buf = buf.subarray(off + maskLen + len)

      if (opcode === 0x1) {
        this.stats.received++
        this._onMessage(payload.toString('utf8'))
      } else if (opcode === 0x8) {
        this._dropReverse(conn, true)
        return buf
      } else if (opcode === 0x9) {
        this._sendFrameTo(conn, 0x0a, payload)
      }
    }
    return buf
  }

  /** 往某个反向连接写一帧。 */
  _sendFrameTo(conn, opcode, payload) {
    if (!conn?.alive) return false
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
    const len = data.length
    let header
    if (len < 126) {
      header = Buffer.alloc(2); header[1] = len
    } else if (len < 65536) {
      header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2)
    } else {
      header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2)
    }
    header[0] = 0x80 | opcode
    try {
      conn.socket.write(Buffer.concat([header, data]))
      return true
    } catch (e) {
      this._noteError(`发送失败：${String(e?.message ?? e)}`)
      return false
    }
  }

  _dropReverse(conn, log = false) {
    if (!conn) return
    conn.alive = false
    this.serverSockets.delete(conn)
    try { conn.socket.destroy() } catch { /* ignore */ }
    if (this.serverSockets.size === 0) {
      this.connected = false
      this.stats.direction = null
      if (log) this.log.warn?.('onebot：反向连接已断开')
      this._emit('close')
    }
  }

  _noteError(msg) {
    this.stats.errors++
    this.stats.lastErrorAt = Date.now()
    this.stats.lastError = String(msg).slice(0, 300)
    this.log.warn?.(`onebot：${msg}`)
    this._emit('error', { message: msg })
  }

  _scheduleReconnect() {
    if (this.closed || this._timer) return
    const delay = this._delay
    this._delay = Math.min(this._delay * 1.6, this.cfg.reconnectMaxMs)
    this._timer = setTimeout(() => {
      this._timer = null
      this.stats.reconnects++
      this.connect()
    }, delay)
    if (this._timer.unref) this._timer.unref()
  }

  _onMessage(text) {
    let msg
    try { msg = JSON.parse(text) } catch {
      this.log.debug?.('onebot：收到非 JSON 数据')
      return
    }

    // API 响应：{status, retcode, data, echo}
    if (msg.echo !== undefined && this._pending.has(String(msg.echo))) {
      const resolve = this._pending.get(String(msg.echo))
      this._pending.delete(String(msg.echo))
      resolve(msg)
      return
    }

    // 事件：{post_type: 'message'|'notice'|'request'|'meta_event', ...}
    if (msg.post_type) {
      this.stats.lastEventAt = Date.now()
      this.stats.lastEventKind = msg.post_type === 'message'
        ? `message/${msg.message_type ?? '?'}`
        : msg.post_type
      if (msg.post_type === 'meta_event' && msg.meta_event_type === 'heartbeat') {
        // 心跳：记录 good 状态（上游健康信号）
        this.stats.heartbeat = {
          at: Date.now(),
          good: msg.status?.good ?? null,
          online: msg.status?.online ?? null,
          interval: msg.interval ?? null,
        }
        return
      }
      // ⚠️ 必须在这里挂上标准化结果。
      //    bridge 读的是 `ev.__normalized`，而 normalizeEvent() 之前
      //    写好了却**没人调用** —— 于是消息事件全都进了 bridge 又被
      //    `if (!msg) return` 静默丢掉：计数上表现为
      //    received 增长、dropped/considered 都是 0、机器人不回复。
      //    只对 message 事件规范化（notice/request 没有消息体）。
      if (msg.post_type === 'message') {
        try { msg.__normalized = normalizeEvent(msg) } catch (e) {
          this.log.warn?.(`onebot：消息规范化失败 — ${String(e?.message ?? e)}`)
        }
      }
      this._emit('event', msg)
    }
  }

  /**
   * 调一个 OneBot API（走 WebSocket 的 echo 机制）。
   *
   * 优先用反向连接（如果协议端是从反向连进来的）—— 因为那是它主动建立的，
   * 我们回包最直接；否则用正向的 ws。
   *
   * @returns {Promise<object>}
   */
  call(action, params = {}, timeoutMs = 15000) {
    const chan = this._pickChannel()
    if (!chan) {
      return Promise.reject(new Error('onebot 未连接'))
    }
    const echo = String(++this._echo)
    const payload = { action, params, echo }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(echo)
        reject(new Error(`onebot ${action} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this._pending.set(echo, (v) => { clearTimeout(timer); resolve(v) })
      const ok = this._sendOn(chan, JSON.stringify(payload))
      if (!ok) {
        clearTimeout(timer)
        this._pending.delete(echo)
        reject(new Error(`onebot ${action} 发送失败`))
      }
    })
  }

  /** 选一条可用的发送通道。 */
  _pickChannel() {
    // 反向连接优先（协议端主动连来的，回包路径最短）
    for (const conn of this.serverSockets) {
      if (conn.alive) return { kind: 'reverse', conn }
    }
    if (this.ws && this.connected && this.stats.direction === 'forward') {
      return { kind: 'forward' }
    }
    // 兜底：只要 ws 还在就算
    if (this.ws) return { kind: 'forward' }
    return null
  }

  /** 在指定通道上发文本。 */
  _sendOn(chan, text) {
    if (chan.kind === 'reverse') return this._sendFrameTo(chan.conn, 0x1, text)
    try {
      this.ws.send(text)
      this.stats.sent++
      return true
    } catch (e) {
      this._noteError(`ws 发送失败：${String(e?.message ?? e)}`)
      return false
    }
  }

  /**
   * 用 HTTP API 调（发消息推荐走这条 —— 有明确返回值，也不怕 WS 抖动）。
   */
  async callHttp(action, params = {}, timeoutMs = 15000) {
    if (!this.cfg.httpUrl) throw new Error('onebot 未配置 httpUrl')
    const url = `${this.cfg.httpUrl.replace(/\/$/, '')}/${action}`
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.cfg.accessToken ? { authorization: `Bearer ${this.cfg.accessToken}` } : {}),
        },
        body: JSON.stringify(params),
        signal: ctl.signal,
      })
      const text = await res.text()
      this.stats.sent++
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
      try { return JSON.parse(text) } catch { return { raw: text } }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 取一条**历史消息**（OneBot v11 `get_msg`）。
   *
   * ## 为什么需要（2026-11-01）
   *
   * 用户引用回复时，事件里只带被引用那条的 **id**（见 `parseMessage` 的
   * reply 段）。id 本身够决策层判断「在跟谁说话」，但**不够回答** ——
   * 一旦被引用的消息已经滚出 30 条上下文窗口，机器人手里就只有一串数字，
   * 完全不知道被引用的是什么。用户看到的就是「它看不见引用」。
   *
   * 所以窗口里找不到时，回来问协议端要原文。
   *
   * ⚠️ 超时要短。这条路径是在**回复之前**同步跑的，慢一秒就晚一秒说话。
   *    实测 magpie 那边本来就偶尔要 5~7 秒，这里再叠几秒就难受了。
   *
   * @param {string|number} messageId
   * @param {number} [timeoutMs]
   * @returns {Promise<null|{id:string, sender:string, senderName:string, text:string, at:number}>}
   */
  async getMsg(messageId, timeoutMs = 4000) {
    const id = String(messageId ?? '').trim()
    if (!id) return null
    const res = await this.callHttp('get_msg', {
      // OneBot 的 message_id 通常是整数；非数字就原样传，别硬转成 NaN
      message_id: /^\d+$/.test(id) ? Number(id) : id,
    }, timeoutMs)
    const d = res?.data ?? res
    if (!d || d.message_id == null) return null
    const parsed = parseMessage(d.message)
    const senderId = String(d.sender?.user_id ?? '')
    return {
      id: String(d.message_id),
      sender: senderId,
      /*
       * ★ 显示名：**群名片优先**（2026-11-05，用户：「群聊不认真实 QQ 名字」）。
       *   私聊没有名片，自然回落到真实昵称。
       *   真实昵称仍单独放在 `nickname`（人物档案/面板用），互不干扰。
       */
      senderName: String(d.sender?.card || d.sender?.nickname || senderId || ''),
      text: parsed.text,
      at: Number(d.time ? d.time * 1000 : 0),
    }
  }

  /**
   * 取回**合并转发**（聊天记录）的内容（2026-11-06）。
   *
   * ## 为什么要有这个方法
   * 原来 `parseMessage` 把 forward 段压成正文里的「[合并转发]」四个字，
   * **id 直接扔了** —— 她只知道"有人转了一段聊天记录"，里面一个字都看不到。
   * 现在 id 跟着消息上来，这里用 `get_forward_msg` 换内容。
   *
   * ## NapCat 的形状（实测参数表）
   * ```
   * get_forward_msg  { message_id }  →  { messages: [ { message, sender, time } ] }
   * ```
   * ⚠️ 返回的 `messages` 里每一条**又是一个消息段数组**，所以每个节点
   *    都要再过一遍 `parseMessage`（图/表情/引用都得认出来）。
   *
   * ## 三条纪律
   * ① **截断**：转发经常几十上百条，全塞进提示词会撑爆上下文预算、
   *    把当前话题淹掉。只留最近 `maxNodes` 条，每行 `maxChars` 字。
   * ② **标明是"转来的"**：标题写清楚这是别人转的一段对话 ——
   *    不然模型会以为这些是**这个群刚才说的**。
   * ③ **失败返回 null**，不抛：转发是加分项，绝不能因此让回复发不出去。
   *
   * @param {string|number} forwardId  forward 段里的 `id`
   * @param {object} [opts]
   * @param {number} [opts.maxNodes=16]  最多留几条
   * @param {number} [opts.maxChars=1200] 总共最多多少字（比单条上限更重要）
   * @param {number} [opts.nodeChars=240] 单条正文最多多少字
   * @param {number} [opts.timeoutMs=6000]
   * @returns {Promise<null|{text:string,total:number,used:number,truncated:boolean}>}
   */
  async getForwardMsg(forwardId, opts = {}) {
    const id = String(forwardId ?? '').trim()
    if (!id) return null
    const maxNodes = Math.max(1, Number(opts.maxNodes) || 16)
    const maxChars = Math.max(100, Number(opts.maxChars) || 1200)
    const nodeChars = Math.max(20, Number(opts.nodeChars) || 240)

    let res
    try {
      res = await this.callHttp('get_forward_msg', {
        /*
         * ⚠️⚠️ **id 必须原样传字符串，绝不能转 Number**（2026-11-06 实测）。
         *
         * 转发 id 是 19 位（`7704891221357637709`），**超出 JS 安全整数范围**
         * （2^53 ≈ 9.007e15），转 Number 会丢精度 → NapCat 认不出这个 id →
         * 返回「消息已过期或者为内层消息，无法获取转发消息」。
         *
         * 实测对照（同一条转发、同一个 NapCat）：
         *   {"id":"7704891221357637709"}        → ok，5 个节点
         *   {"id":7704891221357637709}          → failed，"消息已过期"
         *   {"message_id":7704891221357637709}  → failed，"消息已过期"
         *
         * 那句"消息已过期"**根本不是过期**，是精度丢了。
         */
        message_id: id,
        id,
      }, Number(opts.timeoutMs) || 6000)
    } catch {
      return null
    }

    const d = res?.data ?? res
    /*
     * 三种可能形状，都要认（不同 NapCat 版本 / CQHTTP 兼容层给的不一样）：
     *   · { messages: [ { message, sender, time } ] }   ← 标准
     *   · { messages: [ [ {type,data}, … ] ] }          ← 直接给段数组
     *   · { message: [ … ] }                            ← 单个
     */
    const raw = d?.messages ?? d?.message ?? d?.content ?? []
    const nodes = Array.isArray(raw) ? raw : [raw]
    if (nodes.length === 0) return null

    /*
     * ★ **把"错误话术"当内容过滤掉**（2026-11-06 实测踩到）。
     *
     * NapCat 取不到转发内容时**不报错**，而是把错误信息当成一条消息回：
     * ```
     * { status:'ok', retcode:0, data:{ messages:[ { message:[ {type:'text',
     *     data:{ text:'消息已过期或者为内层消息，无法获取转发消息' } } ] } ] } }
     * ```
     * 那句话于是被当成**转发内容**塞进提示词，她照着念
     * 「转的啥啊，这边就看到一句消息已过期」—— 看着像她在猜，其实是我们在喂假数据。
     *
     * 所以：整段都是这类话术 → 返回 null（保留 `[合并转发]` 占位），
     * 宁可她不知道内容，也不让她念一句协议端的报错。
     */
    const FAILED_RE = /消息已过期|无法获取转发|内层消息|获取转发消息失败|not found|expired|invalid/i

    const all = []
    let sawRealContent = false

    /*
     * ★★ **内容可能在 `data.content` 里，不在 `message` 里**（2026-11-06 实测）。
     *
     * 真实那条转发的每个节点长这样：
     * ```
     * { sender:{nickname:'QQ用户'}, message:[ { type:'forward',
     *     data:{ id:'…', content:[ {sender, message:[…]}, … ] } } ] }
     * ```
     * 外面那层 nodes 只是"转发套转发"的壳，真正的消息在 `data.content` 里。
     * 只读 `node.message` 的话，每个节点都被当成一个空的 forward 段丢掉 ——
     * 一条都读不出来（这是第二个 bug）。
     *
     * ⚠️ 有层数上限（默认 3）：QQ 允许转发套转发，套太深没有阅读价值。
     * ⚠️ 先**全量收集**（硬上限 HARD_LINES 兜底防跑飞），再按 maxNodes /
     *    maxChars 截断 —— 这样抬头能写「共 N 条，列前 M 条」，
     *    而不是自己都不知道漏了多少。
     */
    const HARD_LINES = 400
    const maxDepth = Math.max(1, Number(opts.maxDepth) || 3)
    /*
     * ★ **转发里的图最多取几张**（2026-11-06，用户：「太多的看一点就停」）。
     * 默认 4 —— 87 张全看是真花钱（每张都是视觉 token），也没人等。
     */
    const maxImages = Math.max(0, Number(opts.maxImages ?? 4))
    const images = []
    let imageOmitted = 0
    const walk = (segs, depth, who) => {
      if (!Array.isArray(segs)) return
      for (const seg of segs) {
        if (all.length >= HARD_LINES) return
        const t = seg?.type
        const sd = seg?.data ?? {}
        if (t === 'forward' && Array.isArray(sd.content) && depth < maxDepth) {
          for (const inner of sd.content) {
            if (all.length >= HARD_LINES) return
            const innerWho = String(
              inner?.sender?.card || inner?.sender?.nickname || inner?.sender?.user_id
              || who || '',
            ).trim().slice(0, 24)
            walk(inner?.message, depth + 1, innerWho)
          }
          continue
        }
        let text = ''
        try {
          text = parseMessage([seg]).text
        } catch {
          text = ''
        }
        text = String(text ?? '').replace(/\s+/g, ' ').trim()
        if (!text) continue
        // 协议端的报错话术：跳过（别当成聊天内容）
        if (FAILED_RE.test(text)) continue
        sawRealContent = true
        /*
         * 图片节点把**可下载引用**带出去：bridge 会拼成一张网格再交给视觉模型。
         * ⚠️ 超出上限的记进 imageOmitted，正文里会写「还有 N 张没看」——
         *    别假装全看了。
         */
        if (t === 'image') {
          const ref = String(sd.url || sd.file || sd.file_id || sd.path || '')
          if (ref && images.length < maxImages) images.push(ref)
          else if (ref) imageOmitted++
        }
        all.push({ who: who || '某人', text })
      }
    }

    for (const node of nodes) {
      if (all.length >= HARD_LINES) break
      const who = String(
        node?.sender?.card || node?.sender?.nickname || node?.sender?.user_id
        || node?.nickname || node?.name || '',
      ).trim().slice(0, 24)
      const body = node?.message ?? node?.content ?? (Array.isArray(node) ? node : null)
      walk(body ?? [node], 0, who)
    }
    if (!sawRealContent || all.length === 0) return null

    // ── 按条数 / 总字数截断 ──────────────────────────────
    const lines = []
    let used = 0
    let chars = 0
    for (const it of all) {
      if (used >= maxNodes || chars >= maxChars) break
      const cut = it.text.length > nodeChars ? `${it.text.slice(0, nodeChars)}…` : it.text
      lines.push(`  ${it.who}：${cut}`)
      used++
      chars += cut.length
    }
    if (lines.length === 0) return null

    /*
     * ⚠️ 抬头按**实际展开的条数**算，不能按外层 nodes.length：
     *    外层 5 个节点里包着 16 条真消息（转发套转发），
     *    按 nodes.length 写会变成「·5条」但下面列 16 行，自相矛盾。
     */
    const rest = all.length - used
    const head = `[转发了聊天记录·${all.length}条]`
    const tail = rest > 0 ? `\n  …（后面还有 ${rest} 条没展开）` : ''
    return {
      text: `${head}\n${lines.join('\n')}${tail}`,
      total: all.length,
      used,
      truncated: rest > 0,
      /** 可下载的图片引用（bridge 拼图后交给视觉模型） */
      images,
      /** 因上限没取的图片张数 */
      imageOmitted,
    }
  }

  /** 发群消息。优先 HTTP，失败回落 WS。 */
  async sendGroup(groupId, message, opts = {}) {
    const params = { group_id: Number(groupId), message, auto_escape: false, ...opts }
    return this._sendPreferHttp('send_group_msg', params)
  }

  /** 发私聊消息。 */
  async sendPrivate(userId, message, opts = {}) {
    const params = { user_id: Number(userId), message, auto_escape: false, ...opts }
    return this._sendPreferHttp('send_private_msg', params)
  }

  /**
   * 禁言 / 解除禁言。
   *
   * OneBot v11 `set_group_ban`：
   *   params: { group_id, user_id, duration }   duration 单位**秒**
   *   duration = 0 表示解除禁言
   *
   * ⚠️ 两个坑（都实测过）：
   *   ① `duration` 是**秒**，不是分钟。传分钟会变成禁言几十秒。
   *   ② 目标 QQ 号不存在时返回 `uid error`（retcode 1200），
   *      不是「接口不存在」—— 别被这个报错误导。
   *
   * 这个方法是**底层**能力，不做任何校验。
   * 目标合法性/时长上限/频率限制都在 `groupAdmin.validateBan`
   * 和 bridge 的调用处完成 —— 那里才是安全边界。
   *
   * @param {string|number} groupId
   * @param {string|number} userId
   * @param {number} seconds  0 = 解除
   */
  async banMember(groupId, userId, seconds) {
    const sec = Math.max(0, Math.round(Number(seconds) || 0))
    const res = await this.call('set_group_ban', {
      group_id: Number(groupId),
      user_id: Number(userId),
      duration: sec,
    }, 10000)
    if (res?.status === 'failed' || (typeof res?.retcode === 'number' && res.retcode !== 0)) {
      throw new Error(`set_group_ban 失败：${res?.message ?? res?.wording ?? JSON.stringify(res).slice(0, 120)}`)
    }
    return true
  }

  /** 取群成员列表（校验目标角色要用）。 */
  async getGroupMembers(groupId) {
    const res = await this.call('get_group_member_list', { group_id: Number(groupId) }, 10000)
    if (res?.status === 'failed' || (typeof res?.retcode === 'number' && res.retcode !== 0)) {
      throw new Error(`get_group_member_list 失败：${res?.message ?? JSON.stringify(res).slice(0, 120)}`)
    }
    return Array.isArray(res?.data) ? res.data : []
  }

  /**
   * 处理一条好友申请（同意或拒绝）。
   *
   * OneBot v11 `set_friend_add_request`：
   *   params: { flag, approve, remark? }
   *
   * ⚠️ `flag` 是**申请事件的唯一标识**，由 OneBot 在
   *    `post_type: 'request'` 且 `request_type: 'friend'` 的事件里给出。
   *    它不能自己编 —— 编一个必然返回 `No such request`（实测过）。
   *
   * ⚠️ 这里**只能被动响应**：QQ 没有「主动加好友」的 OneBot API，
   *    所以码风只能等人来加，不能去加别人。
   *
   * @param {string} flag
   * @param {boolean} approve
   * @param {string} [remark]  同意时给对方设的备注
   */
  async handleFriendRequest(flag, approve, remark) {
    const params = { flag: String(flag), approve: Boolean(approve) }
    if (remark) params.remark = String(remark).slice(0, 20)
    const res = await this.call('set_friend_add_request', params, 10000)
    if (res?.status === 'failed' || (typeof res?.retcode === 'number' && res.retcode !== 0)) {
      throw new Error(`set_friend_add_request 失败：${res?.message ?? res?.wording ?? JSON.stringify(res).slice(0, 120)}`)
    }
    return true
  }

  /**
   * 改自己的 QQ 昵称（**全局**，所有群和好友都看到）。
   *
   * ⚠️ 和 `set_group_card` 的区别要记清楚：
   *   · `set_group_card` → 只影响**一个群**里的显示名，改错了无所谓
   *   · `set_qq_profile` → 影响**所有地方**，改成一个怪名字
   *     别人会以为这号被盗了
   *
   * 所以调用前必须过 `groupAdmin.validateNickname`。
   * 这个方法和 `banMember` 一样是**裸能力**，不做校验。
   *
   * 实测返回：`{ status:'ok', retcode:0, data:{ result:0, errMsg:'' } }`
   * —— 注意 `result`/`errMsg` 在 data 里，是 QQ 协议层自己的错误码，
   * retcode 为 0 时它也可能非 0（比如昵称违规）。两个都要看。
   *
   * @param {string} nickname
   */
  async setSelfNickname(nickname) {
    const res = await this.call('set_qq_profile', { nickname: String(nickname) }, 10000)
    const failed = res?.status === 'failed' || (typeof res?.retcode === 'number' && res.retcode !== 0)
    const inner = Number(res?.data?.result ?? 0)
    if (failed || inner !== 0) {
      throw new Error(
        `set_qq_profile 失败：${res?.data?.errMsg || res?.message || res?.wording || JSON.stringify(res).slice(0, 120)}`,
      )
    }
    return true
  }

  /**
   * 把一张本地图片加进账号的「收藏表情」。
   *
   * ## 为什么用这个私有接口
   *
   * OneBot v11 没有"收藏表情"的标准动作。NapCat 提供了 `add_custom_face`
   * （实测 v4.18.38 可用）：参数只有 `{ file: '<本地绝对路径>' }`，
   * 返回 `{ result:0, isExist:0|1 }` —— `isExist=1` 表示这张已经在收藏里。
   *
   * ⚠️ 只接受**本地路径**，不接受 http URL（传 URL 会落到
   *    "Schema compilation error: Expected required property"）。
   *    所以调用方必须先下载到磁盘。
   *
   * @param {string} filePath 本地图片绝对路径
   * @returns {Promise<{ok:boolean, existed:boolean, raw:any}>}
   */
  async addCustomFace(filePath) {
    try {
      const res = await this._sendPreferHttp('add_custom_face', { file: String(filePath) })
      const ok = res?.status === 'ok' && (res?.retcode === 0 || res?.retcode === undefined)
      const existed = Number(res?.data?.isExist) === 1
      return { ok, existed, raw: res }
    } catch (e) {
      return { ok: false, existed: false, raw: { error: String(e?.message ?? e) } }
    }
  }

  /** 取当前账号的收藏表情 URL 列表。 */
  async fetchCustomFaces() {
    try {
      const res = await this._sendPreferHttp('fetch_custom_face', {})
      const list = Array.isArray(res?.data) ? res.data : []
      return list.filter((u) => typeof u === 'string' && /^https?:/.test(u))
    } catch {
      return []
    }
  }

  async _sendPreferHttp(action, params) {
    if (this.cfg.httpUrl) {
      try { return await this.callHttp(action, params) } catch (e) {
        this.log.warn?.(`onebot：HTTP ${action} 失败（尝试 WS）— ${String(e?.message ?? e)}`)
      }
    }
    return this.call(action, params)
  }

  /** 查登录信息（用于探活）。 */
  async getLoginInfo() {
    if (this.cfg.httpUrl) {
      try { return await this.callHttp('get_login_info', {}) } catch { /* 回落 WS */ }
    }
    return this.call('get_login_info', {})
  }

  /** 查状态（含 good 字段，判断上游注入是否还健康）。 */
  async getStatus() {
    if (this.cfg.httpUrl) {
      try { return await this.callHttp('get_status', {}) } catch { /* 回落 WS */ }
    }
    return this.call('get_status', {})
  }

  /**
   * 重新向协议端要一份**新鲜的**图片地址。
   *
   * ## 为什么需要
   *
   * QQ 的图片下载地址带时效签名（rkey），几分钟就失效。而我们的链路
   * 「收到消息 → 生成回复」中间可能隔好几秒（排日程、排队、模型思考），
   * 等真去下载时签名已经烂了 —— 上游直接回 HTTP 400。
   *
   * 实测（2026-10-27）：
   *   11:43:41  onebot：图片下载失败 HTTP 400
   *             https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=…
   *   11:43:41  bridge：有图片但一张都没入库，本条按纯文本发送
   *
   * 那一刻恰好是当天第一次回复，前面多跑了一次日程生成，把时间拖过了。
   *
   * 拿到新地址后调用方会重试下载，通常就能成功。
   *
   * @param {string} ref  原始的图片 ref（file / file_id）
   * @returns {Promise<string|null>}
   */
  async _freshImageUrl(ref) {
    const raw = String(ref ?? '').trim()
    if (!raw) return null
    // 已经是 http(s) 的说明拿不到更新的了（协议端没给 id）
    for (const arg of [{ file: raw }, { file_id: raw }]) {
      try {
        const res = await this.call('get_image', arg, 8000)
        const d = res?.data ?? {}
        const url = d.url ?? d.file ?? d.path
        if (url && /^https?:\/\//i.test(String(url))) return String(url)
      } catch { /* 换下一个参数名 */ }
    }
    return null
  }


  /**
   * 把一条图片消息解析成 base64 data URL（供多模态模型用）。
   *
   * OneBot 的图片段可能是这些形式：
   *   - http(s):// URL        → 直接下载
   *   - file:///本地路径       → 读本地文件
   *   - base64://...          → 直接解码
   *   - 协议端本地文件名        → 先调 get_image 换 URL，再下载
   *
   * @param {string} ref  图片引用
   * @param {object} [opts]
   * @param {number} [opts.maxBytes] 上限（超过就放弃，避免把上下文撑爆）
   * @returns {Promise<{dataUrl:string,mime:string,bytes:number}|null>}
   */
  async fetchImage(ref, opts = {}) {
    const maxBytes = opts.maxBytes ?? 4 * 1024 * 1024
    let target = String(ref ?? '').trim()
    if (!target) return null

    // base64:// 直接解码
    if (target.startsWith('base64://')) {
      const b64 = target.slice('base64://'.length)
      if (b64.length * 0.75 > maxBytes) return null
      return { dataUrl: `data:image/jpeg;base64,${b64}`, mime: 'image/jpeg', bytes: Math.round(b64.length * 0.75) }
    }

    // file:// 读本地
    if (target.startsWith('file://')) {
      try {
        const p = target.slice('file://'.length).replace(/^\/([A-Za-z]:)/, '$1')
        const fs = await import('node:fs')
        const stat = fs.statSync(p)
        if (stat.size > maxBytes) return null
        const buf = fs.readFileSync(p)
        const mime = guessMime(p)
        return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, mime, bytes: buf.length }
      } catch { return null }
    }

    // 不是 http(s)：当成协议端的文件名/ID，先问 get_image 要 URL
    //
    // ⚠️ 这一步是**图片能不能用**的关键。NapCat 在
    //    `enableLocalFile2Url=false`（默认）时，图片段里 url 是空的，
    //    只给一个本地 file 路径或 file_id —— 直接当 URL 下载必然失败。
    //    必须调 get_image 让它转成可访问的地址。
    //    返回结构在不同版本里有几种形态，都试一遍。
    if (!/^https?:\/\//i.test(target)) {
      const tries = [
        { file: target },
        { file_id: target },
      ]
      for (const arg of tries) {
        try {
          const res = await this.call('get_image', arg, 10000)
          const d = res?.data ?? {}
          const url = d.url ?? d.file ?? d.path
          if (url && /^https?:\/\//i.test(String(url))) { target = String(url); break }
          // 有些版本返回 base64 直出
          if (d.base64) {
            return { dataUrl: `data:image/jpeg;base64,${d.base64}`, mime: 'image/jpeg',
              bytes: Math.round(String(d.base64).length * 0.75) }
          }
        } catch { /* 换下一个参数名再试 */ }
      }
    }

    if (!/^https?:\/\//i.test(target)) {
      this.log.warn?.(`onebot：图片拿不到可下载的 URL（ref=${String(ref).slice(0, 80)}）`
        + ' —— 常见原因：NapCat 的 OneBot HTTP 服务没开（3000 端口），'
        + 'get_image 返回的地址没人托管；WhalePod 会在启动时自动补写该配置')
      return null
    }

    // 是否已经为重试换过一次 URL（防止无限递归）
    let retried = opts.__retried === true

    // 下载（带大小限制）
    try {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 15000)
      // ⚠️ 用带代理兜底的 fetch：本机装过代理软件时 HTTP_PROXY 会残留在
      //    环境变量里，代理一关所有请求就 ECONNREFUSED（2026-10-25 实测：
      //    QQ 图片、联网搜索全挂，而 QQ 连接正常因为走 NO_PROXY）。
      //    net.js 里会在「连不上本机代理」时自动直连重试一次。
      let res
      try {
        res = await fetchWithProxyFallback(target, {
          timeoutMs: 15000,
          log: (m) => this.log.info?.(`onebot：${m}`),
        })
      } finally {
        clearTimeout(timer)
      }
      if (!res.ok) {
        /*
         * ⚠️ HTTP 400 / 403 = QQ 图片 URL 的 rkey 过期了（2026-10-27 实测）。
         *
         * QQ 给的下载地址带时效签名，几分钟内有效。而我们的链路里
         * 「收到消息 → 生成回复」可能隔几秒（生成日程、排队、模型思考），
         * 等真去下载时签名已经烂了，上游直接 400。
         *
         * 原来的行为是直接放弃 → 日志「有图片但一张都没入库」，
         * 模型只能对着「（对方发了一张图）」瞎猜。
         *
         * 现在：400/403 时**重新问一次 get_image** 换新签名再下载。
         * 只重试一次 —— 再失败就说明不是签名问题，继续重试没意义。
         */
        const expired = res.status === 400 || res.status === 403
        if (expired && !retried) {
          retried = true
          this.log.info?.(`onebot：图片地址可能过期（HTTP ${res.status}），换新地址重试一次`)
          const fresh = await this._freshImageUrl(ref)
          if (fresh && fresh !== target) {
            target = fresh
            return this.fetchImage(fresh, { ...opts, __retried: true })
          }
        }
        this.log.warn?.(`onebot：图片下载失败 HTTP ${res.status}（${target.slice(0, 80)}）`)
        return null
      }
      const headerOf = (k) => (typeof res.headers?.get === 'function'
        ? res.headers.get(k)
        : res.headers?.[k.toLowerCase()] ?? res.headers?.[k] ?? null)
      const len = Number(headerOf('content-length') ?? 0)
      if (len && len > maxBytes) {
        this.log.warn?.(`onebot：图片超过上限（${len} > ${maxBytes}）`)
        return null
      }
      /*
       * ⚠️ 2026-10-26 修：这里原来写的是
       *
       *   const buf = res.body
       *     ? Buffer.from(res.body)
       *     : Buffer.from(await res.arrayBuffer())
       *
       * 只要有 `res.body` 就直接 `Buffer.from(它)` —— 但 `res.body`
       * 在标准 fetch 里是 **Web ReadableStream**，在代理兜底通道里是
       * **Node Readable**，两者都进不了 `Buffer.from`：
       *
       *   TypeError: The first argument must be of type string or an
       *   instance of Buffer, ArrayBuffer ... Received an instance of
       *   ReadableStream
       *
       * 结果就是**每一张图都下载失败**（日志里那串「图片下载异常」），
       * 表情包全部降级成「（对方发了一个表情包）」文字占位符 ——
       * 模型看不到图，自然接不上「你看这个」之类的话。
       *
       * 现在按类型分派：
       *   · Response / 有 arrayBuffer()  → 用它（最省事，一次拷完）
       *   · Node Readable（.pipe/.on）  → 收集 chunk
       *   · Web ReadableStream         → getReader 读到底
       *   · Buffer / Uint8Array        → 直接用
       */
      const buf = await readBodyAsBuffer(res)
      if (!buf) {
        this.log.warn?.('onebot：图片响应体读不出来（类型不支持）')
        return null
      }
      if (buf.length > maxBytes) {
        this.log.warn?.(`onebot：图片超过上限（${buf.length} > ${maxBytes}）`)
        return null
      }
      const mime = String(headerOf('content-type') ?? '').split(';')[0] || guessMime(target)
      if (!/^image\//.test(mime)) {
        this.log.warn?.(`onebot：下载到的不是图片（content-type=${mime || '空'}）`)
        return null
      }
      return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, mime, bytes: buf.length }
    } catch (e) {
      this.log.warn?.(`onebot：图片下载异常 — ${String(e?.cause?.code ?? e?.message ?? e)}`)
      return null
    }
  }

  close() {
    this.closed = true
    if (this._timer) { clearTimeout(this._timer); this._timer = null }
    try { this.ws?.close() } catch { /* ignore */ }
    this.ws = null
    for (const conn of [...this.serverSockets]) this._dropReverse(conn)
    try { this.server?.close() } catch { /* ignore */ }
    this.server = null
    this.connected = false
    this.stats.direction = null
  }
}

/**
 * 把 HTTP 响应体读成 Buffer —— 不管它是什么形态。
 *
 * ## 为什么需要这个
 *
 * 同样的「下载一张图」，两条通道返回的 `body` 类型不同：
 *
 *   · 标准 `fetch()`          → Web `ReadableStream`
 *   · `fetchWithProxyFallback` → Node `Readable`（`node:http` 的 res）
 *
 * 原来的写法是 `Buffer.from(res.body)`，两种都接不住：
 *
 *   TypeError: The first argument must be of type string or an instance
 *   of Buffer, ArrayBuffer ... Received an instance of ReadableStream
 *
 * 表现是**所有图片下载都失败**，表情包降级成文字占位符，
 * 模型看不到图 —— 用户感觉「她不知道我在说什么」。
 *
 * @param {any} res fetch 的 Response 或 {body} 包装
 * @returns {Promise<Buffer|null>} 读不出来返回 null
 */
async function readBodyAsBuffer(res) {
  if (!res) return null
  const body = res.body ?? res

  // ① Buffer / Uint8Array：已经在内存里了
  if (Buffer.isBuffer(body)) return body
  if (body instanceof Uint8Array) return Buffer.from(body)

  // ② Response 自己会转 —— 最省事，一次拷完，也让运行时管背压
  if (typeof res.arrayBuffer === 'function') {
    try {
      return Buffer.from(await res.arrayBuffer())
    } catch { /* 落到下面按流处理 */ }
  }

  // ③ Web ReadableStream：getReader 读到底
  if (typeof body?.getReader === 'function') {
    const reader = body.getReader()
    const parts = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) parts.push(Buffer.from(value))
    }
    return Buffer.concat(parts)
  }

  // ④ Node Readable：收集 chunk
  if (typeof body?.on === 'function') {
    return await new Promise((resolve, reject) => {
      const parts = []
      body.on('data', (c) => parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
      body.on('end', () => resolve(Buffer.concat(parts)))
      body.on('error', reject)
    })
  }

  return null
}

/** 按扩展名猜 MIME。 */
function guessMime(p) {
  const s = String(p).toLowerCase()
  if (s.endsWith('.png')) return 'image/png'
  if (s.endsWith('.gif')) return 'image/gif'
  if (s.endsWith('.webp')) return 'image/webp'
  if (s.endsWith('.bmp')) return 'image/bmp'
  return 'image/jpeg'
}

/**
 * 判断一个 image 段其实是"表情包"而不是普通图片。
 *
 * ## 实测的真实字段（NapCat v4.18.38，2026-10）
 *
 * 一条**动画表情**的 image 段：
 *   { summary:'[动画表情]', file:'XXX.jpg', sub_type:1, url:'…', file_size:… }
 * 一条**普通图片**：
 *   { summary:'', file:'XXX.gif', sub_type:0, url:'…', file_size:… }
 *
 * ## 为什么 `sub_type` 才是可靠判据
 *
 * 旧实现只认 `emoji_id` / `emoji_package_id` —— 但**这两个字段在实际
 * 推送里根本不存在**（它们只出现在某些配合解密 key 的场景）。于是所有
 * 表情包都被判成普通图片，文本里显示 `[图片]` 而不是 `[表情包]`，
 * 模型也就不知道对方发的是表情 —— 它自然不会想着回一个表情。
 *
 * 尺寸 / GIF / 有没有文字都不可靠：表情包经常带文字（"杂鱼就杂鱼吧"），
 * 也有静态 PNG 表情；而聊天里同样有 GIF 动图。`sub_type === 1` 由
 * QQ 客户端自己标注，和内容无关 —— 这是唯一稳的。
 *
 * @param {object} d image 段的数据体
 * @returns {boolean}
 */
function isMarketFace(d) {
  if (!d || typeof d !== 'object') return false
  // ① 最可靠：客户端标注的 sub_type（1 = 动画表情/表情包）
  if (Number(d.sub_type) === 1) return true
  // ② 摘要被客户端写成 [动画表情]（部分版本 sub_type 缺失但仍给摘要）
  if (String(d.summary ?? '').includes('动画表情')) return true
  // ③ 旧判据保留：真正带 emoji_id 的实现仍然认
  if (d.emoji_id != null && d.emoji_id !== '') return true
  if (d.emoji_package_id != null && d.emoji_package_id !== '') return true
  return Boolean(d.key && d.summary)
}

/**
 * 从**分享卡片**（OneBot 的 `json` / `xml` 段）里抠出「标题 + 链接」（2026-10-31）。
 *
 * ## 为什么必须处理
 * QQ 里分享 B 站 / 网易云 / 淘宝时，NapCat 常常给的是 **`json` 段**（结构化卡片），
 * 不是 text 段。而 `parseMessage` 原来对未知类型是「**其它类型：忽略，不污染文本**」——
 * **整条消息就没了**，`msg.text` 变成空串，机器人以为对方"手滑发了条空的"。
 *
 * 实测踩过：20:16 一条 B 站分享进来，她回「啥也没发，手滑了吧」。
 *
 * ## 兼容两种标签
 * - `json`：`{"app":"com.tencent.structmsg","meta":{"news":{"title":"…","jumpUrl":"…"}}}`
 *   （B 站/资讯类）；也有 `meta.detail.qqdocurl`（结构化详情卡）
 * - `xml`：`<msg ... brief="…"><item><title>…</title><url>…</url></item></msg>`
 *
 * 抠不到任何东西时给 `[分享]` —— **也不能是空**，否则又变回"手滑"。
 *
 * @param {'json'|'xml'} segType
 * @param {any} d 段里的 data 对象
 * @returns {string}
 */
function extractShareCard(segType, d) {
  const raw = String(
    typeof d === 'string' ? d : (d?.data ?? d?.content ?? d?.text ?? d?.xml ?? ''),
  ).trim()
  let title = ''
  let url = ''

  const pickUrl = (s) => {
    let u = String(s ?? '').trim()
    if (!u) return ''
    // qqdocurl 常是 URL-encoded 的，解一下（解不开就用原值）
    if (/%3A%2F%2F|%2F/i.test(u)) {
      try { u = decodeURIComponent(u) } catch { /* 保留原值 */ }
    }
    return /^https?:\/\//i.test(u) ? u : ''
  }

  if (raw) {
    // ① JSON 卡片
    if (segType === 'json' || raw.startsWith('{')) {
      try {
        const j = JSON.parse(raw)
        const meta = j?.meta ?? {}
        /*
         * ★ **通用遍历 `meta` 的所有子对象**（2026-10-31 修）。
         *
         * 原来硬编码 `['news','detail','music','video','share']` —— 漏了
         * **`detail_1`**（QQ 小程序卡片常用的 key，带下划线+数字）。
         * 实测：一条小程序分享只解析出「【[QQ小程序]小克你最好了】」，**没有 URL**
         * → 后续 `_biliContext` 根本触发不了 → 评论/弹幕永远拿不到。
         *
         * 所以不再猜 key，直接遍历 `Object.values(meta)`。
         * ⚠️ `preview` 是**封面图**不是跳转链接，绝不能当 url。
         */
        for (const m of Object.values(meta)) {
          if (!m || typeof m !== 'object') continue
          if (!title) title = String(m.title ?? m.desc ?? '').trim()
          if (!url) {
            url = pickUrl(
              m.jumpUrl ?? m.qqdocurl ?? m.url ?? m.source_url
              ?? m.sourceUrl ?? m.shareUrl ?? m.link,
            )
          }
        }
        if (!title) title = String(j?.prompt ?? '').trim()
        // 顶层也可能直接带（少数实现）
        if (!url) url = pickUrl(j?.url ?? j?.jumpUrl ?? j?.qqdocurl)
        /*
         * ⚠️ 抠不到 url 时把**原始卡片打个日志**（只 debug 级）。
         * 没有这个，下次再遇到新形状的卡片只能瞎猜字段名 ——
         * 这轮就是「只出标题不出链接」，靠猜改了两版才对。
         */
        if (!url) {
          console.debug?.(`onebot：分享卡片没抠到 url（type=${segType}）raw=${raw.slice(0, 400)}`)
        }
      } catch { /* 不是合法 JSON，走下面 XML */ }
    }
    // ② XML 卡片（或 JSON 没抠到）
    if ((!title || !url) && raw.includes('<')) {
      if (!title) title = String(raw.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '').trim()
      if (!url) url = pickUrl(raw.match(/<url>([^<]*)<\/url>/i)?.[1])
      if (!title) {
        title = String(
          raw.match(/brief="([^"]*)"/i)?.[1]
          ?? raw.match(/summary="([^"]*)"/i)?.[1]
          ?? '',
        ).trim()
      }
    }
  }

  if (!title && !url) return '[分享]'
  const parts = []
  if (title) parts.push(title.startsWith('【') ? title : `【${title}】`)
  if (url) parts.push(url)
  return parts.join('')
}

/**
 * 把 OneBot 的 message 段（数组或 CQ 码字符串）转成纯文本 + 元信息。
 *
 * OneBot v11 有两种格式：
 *   - 字符串 CQ 码：`[CQ:at,qq=123] 你好`
 *   - 数组：`[{type:'at',data:{qq:'123'}}, {type:'text',data:{text:' 你好'}}]`
 *
 * @returns {{text:string, mentions:string[], images:string[], isAtMe:(selfId:string)=>boolean}}
 */
export function parseMessage(raw) {
  const mentions = []
  const images = []
  /**
   * 这条消息里的**表情包**引用（不含普通图片）。
   *
   * 单独存一份的原因：bridge 要靠它决定"要不要自动收藏"。
   * `images` 里混着普通图片，而用户发的表情包和截图长得一样，
   * 只有解析时拿到的 `sub_type`/`summary` 能区分 —— 过了这一步
   * 就再也分不出来了。
   */
  const stickerRefs = []
  let text = ''
  /** 被引用（回复）的那条消息的 id —— 决策层据此判断"是不是在回我" */
  let replyTo = ''
  /**
   * 合并转发（聊天记录）的 id（2026-11-06）。
   *
   * ⚠️ 原来这里只往正文塞一句 `[合并转发]`，**id 直接扔了** ——
   * 于是她只知道"有人转了一段聊天记录"，一个字都看不到。
   * 现在把 id 带出去，由 bridge 调 `get_forward_msg` 取回内容。
   *
   * 取成数组是因为一条消息里可能同时有多个转发（少见但合法）。
   */
  const forwards = []

  if (typeof raw === 'string') {
    // CQ 码：逐个替换
    text = raw.replace(/\[CQ:([a-zA-Z_]+)((?:,[^\]]*)?)\]/g, (_all, type, rest) => {
      const data = {}
      for (const kv of String(rest).replace(/^,/, '').split(',')) {
        const i = kv.indexOf('=')
        if (i < 0) continue
        data[kv.slice(0, i)] = kv.slice(i + 1)
      }
      if (type === 'at') {
        const qq = String(data.qq ?? data.user_id ?? '')
        if (qq) mentions.push(qq)
        if (data.qq === 'all') return '@全体成员'
        /*
         * ⚠️ 不要直接输出 `@123450003` 这种纯 QQ 号。
         *
         * 模型看到的对话里如果全是数字，它根本不知道在 @ 谁 ——
         * 实测它回过「艾特谁呢，数字直接甩出来了」，而且认不出
         * `@123450003` 就是自己。
         *
         * 优先用 at 段里带的昵称（部分实现会给 `name`），
         * 没有就退回「@某人」+ 号（至少不带一串裸数字）。
         * bridge 层会再用记忆里的 senderName 做一次替换。
         */
        const atName = String(data.name ?? data.card ?? '').trim()
        if (atName) return `@${atName}`
        return qq ? `@某群友(${qq})` : '@某人'
      }
      if (type === 'reply') {
        // CQ 码形式也要取（与数组分支同理，见那里的说明）
        replyTo = String(data.id ?? data.message_id ?? '')
        return ''
      }
      if (type === 'image') {
        // 图片段可能给的字段：url / file / file_id / path。
        // ⚠️ NapCat 的 `enableLocalFile2Url=false` 时 url 为空，
        //    只有本地 file 路径 —— 那时得靠 get_image 兜底（见 fetchImage）。
        images.push(data.url ?? data.file ?? data.file_id ?? data.path ?? '')
        // 同数组分支：识别"收藏的表情"（NapCat 把它编码成 image 段）
        if (isMarketFace(data)) {
          const ref = String(data.url ?? data.file ?? data.file_id ?? data.path ?? '')
          if (ref) stickerRefs.push(ref)
          const raw = String(data.summary ?? '').trim()
          const meaningful = raw !== '' && !raw.includes('[') && !raw.includes(']') && raw !== '动画表情'
          return meaningful ? `[表情包:${raw}]` : '[表情包]'
        }
        return '[图片]'
      }
      /*
       * ★ `file` 段里的图片也收（2026-11-05）：
       *    实测他把图当**文件**发过来（`[CQ:file,file=her-head-3vi…]`），
       *    只认 image 段的话这张图在鲸舱里等于不存在（说说带图 0 张）。
       */
      if (type === 'file') {
        const f = String(data?.file ?? data?.name ?? data?.url ?? '')
        if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(f) || /image/i.test(String(data?.name ?? ''))) {
          const u = data?.url ?? data?.file ?? ''
          if (u) images.push(String(u))
          return '[图片]'
        }
        return '[文件]'
      }

      // 表情包（原创表情）：NapCat 会给 emoji_id / emoji_package_id，
      // 以及（多数情况下）一个可直接下载的 url。当成图片收下来 ——
      // 否则模型只看到 "[表情]"，没法理解对方发了什么。
      if (type === 'mface') {
        const u = data.url ?? data.emoji_url ?? data.file
        if (u) images.push(u)
        const name = data.summary ?? data.emoji_name ?? ''
        return name ? `[表情包:${name}]` : '[表情包]'
      }
      // 系统表情（QQ 内置小黄脸）：face id 是固定的，文字里带上 id
      // 让模型知道是哪一类情绪（如 id=4 是"得意"）。
      if (type === 'face') {
        const u = data.url ?? ''
        if (u) images.push(u)
        const id = String(data.id ?? '')
        return id ? `[表情:${id}]` : '[表情]'
      }
      if (type === 'reply') return ''
      /*
       * ★ **分享卡片**（2026-10-31）：原来这里没有分支 → 落到最后 `return '[json]'`
       *   或者被当成未知类型丢掉。B 站/网易云/淘宝分享基本都是这两个。
       *
       * ⚠️ **不能用上面那个 `data` 对象** —— 它是按 `,` 切出来的键值对，
       *    而 `data={"meta":{...}}` 里的 JSON **本身就含逗号**，会被切断。
       *    所以这里直接用**原始 `rest` 串**（去掉前导 `,data=`）。
       */
      if (type === 'json' || type === 'xml') {
        const raw = String(rest).replace(/^,/, '').replace(/^data=/, '')
        return extractShareCard(type, raw)
      }
      if (type === 'record') return '[语音]'
      if (type === 'video') return '[视频]'
      /*
       * ★ 合并转发的 CQ 码（2026-11-06）：
       *   `[CQ:forward,id=xxx]` / `[CQ:forward,data={"id":"xxx"}]`
       * 和数组分支同理 —— 只留 id，正文给个占位。
       */
      if (type === 'forward') {
        const fid = String(data.id ?? data.res_id ?? '').trim()
        if (fid) forwards.push({ id: fid })
        return '[合并转发]'
      }
      return `[${type}]`
    })
  } else if (Array.isArray(raw)) {
    for (const seg of raw) {
      const t = seg?.type
      const d = seg?.data ?? {}
      if (t === 'text') text += String(d.text ?? '')
      else if (t === 'at') {
        const qq = String(d.qq ?? d.user_id ?? '')
        if (qq) mentions.push(qq)
        if (d.qq === 'all') text += '@全体成员'
        else {
          // 同 CQ 码分支：优先昵称，别把裸 QQ 号甩给模型。
          const atName = String(d.name ?? d.card ?? '').trim()
          text += atName ? `@${atName}` : (qq ? `@某群友(${qq})` : '@某人')
        }
      } else if (t === 'image') {
        // 同 CQ 码分支：NapCat 不同配置下给的字段不一样，多兜几个。
        //   url       —— enableLocalFile2Url=true 时的 http 地址（最理想）
        //   file      —— 本地路径或文件名
        //   file_id   —— 只有 id，得靠 get_image 换 URL
        images.push(String(d.url ?? d.file ?? d.file_id ?? d.path ?? ''))
        // ⚠️ NapCat 把**收藏的表情 / 商城表情**也编码成 image 段，
        //    但会额外带 emoji_id / emoji_package_id / summary / key。
        //    不识别的话，它和普通图片一样只显示 [图片] —— 用户发的表情包
        //    在记录里完全看不出来（实测 mface 段根本不会出现，
        //    NapCat 的 marketFaceElement 输出的是 type:'image'）。
        if (isMarketFace(d)) {
          // ⚠️ `summary` 常常是**占位符**而不是表情名。
          //    实测 sub_type=1 的段给的是 summary:'[动画表情]' ——
          //    直接拼进标记会变成 `[表情包:[动画表情]]`（双层括号），
          //    既难读，又会让模型误以为那是表情的名字。
          //    凡是带方括号的、或就是「动画表情」四个字的，一律丢掉。
          const raw = String(d.summary ?? '').trim()
          const meaningful = raw !== ''
            && !raw.includes('[')
            && !raw.includes(']')
            && raw !== '动画表情'
          text += meaningful ? `[表情包:${raw}]` : '[表情包]'
          // 记下"这一张是表情包"，供 bridge 自动收藏
          const ref = String(d.url ?? d.file ?? d.file_id ?? d.path ?? '')
          if (ref) stickerRefs.push(ref)
        } else {
          text += '[图片]'
        }
      }
      else if (t === 'mface') {
        // 兼容真正发 mface 段的实现（OneBot v11 标准里有这一段）。
        const u = d.url ?? d.emoji_url ?? d.file
        if (u) {
          images.push(String(u))
          stickerRefs.push(String(u))   // mface 一定是表情包
        }
        const name = d.summary ?? d.emoji_name ?? ''
        text += name ? `[表情包:${name}]` : '[表情包]'
      }
      else if (t === 'face') {
        // 系统表情：带上 id（QQ 内置表情 id 是固定的，模型能据此判断情绪）
        if (d.url) images.push(String(d.url))
        text += d.id != null ? `[表情:${d.id}]` : '[表情]'
      }
      else if (t === 'record') text += '[语音]'
      else if (t === 'video') text += '[视频]'
      else if (t === 'reply') {
        // ⚠️ 引用（quote）不能忽略 —— 它是最强的"这句是对谁说的"信号。
        //
        //    实测踩过：群里有人**直接回复机器人**说「那还不是决策层叫你发的」，
        //    因为它只在"被 @"时才意识到跟自己有关，而 reply 段被丢掉了，
        //    于是这条被当普通闲聊掷骰子 → 一半概率沉默。用户看着就是
        //    "明明在跟它说话，它却不理"。
        //
        //    这里只取被引用消息的 id；**是谁发的**要等拿到 selfId 才能判断，
        //    所以只把 id 挂在解析结果上，由决策层比对。
        replyTo = String(d.id ?? d.message_id ?? '')
      }
      else if (t === 'forward') {
        /*
         * ★ 合并转发：把 id 留下（2026-11-06）。
         *
         * NapCat 推的段是 `{ type:'forward', data:{ id:'<res_id>', content? } }`。
         * `id` 才是 `get_forward_msg` 要的参数；有些实现会给 `content`
         * （已经展开的节点），能直接读就别再打一次协议端。
         */
        const fid = String(d.id ?? d.message_id ?? d.res_id ?? '')
        if (fid) forwards.push({ id: fid })
        text += '[合并转发]'
      }
      /*
       * ★ **分享卡片**（2026-10-31）—— 原来这里写着「其它类型：忽略」，
       *    于是 B 站/网易云/淘宝的分享**整条消失**，`msg.text` 变成空串，
       *    机器人以为对方"手滑发了条空的"（实测 20:16 那条就是这么来的）。
       */
      else if (t === 'json' || t === 'xml') text += extractShareCard(t, d)
      // 其它类型：忽略，不污染文本
    }
  } else if (raw != null) {
    text = String(raw)
  }

  return {
    text: text.trim(),
    mentions,
    images: images.filter(Boolean),
    /** 只属于**表情包**的图片引用（供 bridge 自动收藏；不含普通图片） */
    stickerRefs: [...new Set(stickerRefs.filter(Boolean))],
    /** 合并转发的 id 列表（`get_forward_msg` 的入参） */
    forwards,
    /** 被引用的消息 id（''=没有引用） */
    replyTo,
    isAtMe: (selfId) => mentions.some((q) => String(q) === String(selfId)),
  }
}

/**
 * 从事件里取出标准化的消息对象。
 * @returns {null|{scope:string,kind:'group'|'private',groupId?:string,userId:string,senderName:string,nickname:string,messageId:string,text:string,mentions:string[],images:string[],at:number,isAtMe:(id:string)=>boolean}}
 */
export function normalizeEvent(ev) {
  if (!ev || ev.post_type !== 'message') return null
  const parsed = parseMessage(ev.message)
  const kind = ev.message_type === 'group' ? 'group' : 'private'
  const userId = String(ev.user_id ?? '')
  const groupId = ev.group_id != null ? String(ev.group_id) : undefined
  return {
    scope: kind === 'group' ? `group:${groupId}` : `private:${userId}`,
    kind,
    groupId,
    userId,
    senderName: String(ev.sender?.card || ev.sender?.nickname || userId),
    /*
     * ★ 真实 QQ 昵称（2026-11-04）：人物档案只认这个。
     *
     * `senderName` 保持「群名片优先」——那是聊天里大家看到的称呼，
     * 展示消息时用它是合适的。但**记人不能用它**：群名片是群内马甲，
     * 换个群就变、还能天天改，同一个人会攒出一串别名，
     * 于是仪表盘上显示谁取决于他最后在哪个群说话（用户实测反馈）。
     */
    nickname: String(ev.sender?.nickname ?? ''),

    messageId: String(ev.message_id ?? ''),
    text: parsed.text,
    mentions: parsed.mentions,
    images: parsed.images,
    /** 只属于表情包的引用（供自动收藏） */
    stickerRefs: parsed.stickerRefs,
    /** 被引用的消息 id（''=没有引用）—— 决策层据此判断"是不是在回我" */
    replyTo: parsed.replyTo,
    /**
     * 合并转发（聊天记录）的 id 列表（2026-11-06）。
     * 由 bridge 调 `get_forward_msg` 取回内容 —— 不取的话她只看到
     * 「[合并转发]」四个字，等于什么都没收到。
     */
    forwards: parsed.forwards ?? [],
    /*
     * ★★ **`at` 用本地接收时刻，不再用 QQ 服务器时间**（2026-11-07）。
     *
     * 现场（群 704291282，30 条里 6 处乱序）：
     * ```
     * 12:36:50.000  他 [表情包]      ← ev.time（QQ 服务器，秒级，比本地慢 1~3 秒）
     * 12:36:51.409  我「图呢？没收到」 ← Date.now()（本地毫秒）
     * ```
     * 两套时钟混在一个数组里排序，必然翻车；而且服务器时间被截断到整秒，
     * 同一秒内的先后完全丢失。
     *
     * 我们关心的是「在对话里谁先说」——那是**接收顺序**，本地时钟就够了。
     * 服务器时间保留成 `serverAt`，需要展示原始发送时间的地方还能用。
     */
    at: Date.now(),
    /** 协议端给的原始发送时间（毫秒）；拿不到就是 null */
    serverAt: Number(ev.time ? ev.time * 1000 : 0) || null,
    isAtMe: parsed.isAtMe,
    raw: ev,
  }
}
