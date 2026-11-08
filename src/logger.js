/**
 * 日志：内存环形缓冲 + 控制台 + 可选落盘。
 *
 * 为什么自己做而不是用 pino/winston：
 *   WhalePod 要能独立打包，依赖越少越好；而且 Web UI 需要一个
 *   「最近 N 条」的内存缓冲，自己写反而更直接。
 */

import fs from 'node:fs'
import path from 'node:path'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

/**
 * 日志轮转 —— **必须在打开自己的写流之前做**。
 *
 * ## 为什么非做不可（2026-11-02 两次实际翻车）
 * 这个文件原来**只追加、从不轮转**，结果长到 **7.6MB / 7.2 万行**，
 * 于是同一条日志里混着**半年前**的记录和刚写的一行。代价是：
 * ```
 * · 把文件早期那条 `Guardian 启动` 当成了刚发生的事
 *   → 误报"有第二个机器人在抢 QQ 连接"（查了半天，是假的）
 * · 按"第一条匹配的时间戳"给日志切片 → 切到老区域 → 结果**全空**
 * ```
 * ⚠️ 这不只是"占地方"的问题，是**它会主动误导人**。
 *
 * ## 为什么放在"打开流之前"而不是"写满就轮转"
 * Windows 上**打开着的文件改不了名**（`EPERM`）。
 * 所以只能在**还没打开**的时候动手 —— 也就是首次写入的那一刻。
 * 代价是：只在启动后第一次写日志时检查一次，进程一直跑就不会再轮转。
 * **这个取舍是故意的**：我们要治的是"跨重启越滚越大"，
 * 而不是"单次运行中途就要切"（那种得做流切换，复杂且容易丢日志）。
 *
 * ## 失败必须 fail-soft
 * 轮转失败（文件被占、权限、磁盘满）**绝不能拦住日志本身** ——
 * 宁可继续往老文件里追加，也不能因为轮转不了就一条都不写。
 *
 * @returns {string|null} 轮转后的新文件名（没轮转返回 null）
 */
function rotateIfNeeded(file, maxBytes, keep) {
  try {
    if (!maxBytes || maxBytes <= 0) return null
    if (!fs.existsSync(file)) return null
    if (fs.statSync(file).size < maxBytes) return null

    // 时间戳进文件名：`:` 在 Windows 上是非法字符，必须换掉
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dest = `${file}.${stamp}`
    fs.renameSync(file, dest)

    // 只留最近 `keep` 个，旧的删掉（按 mtime 排，不靠文件名排序）
    const dir = path.dirname(file)
    const base = path.basename(file)
    const olds = fs
      .readdirSync(dir)
      .filter((n) => n.startsWith(`${base}.`) && n !== base)
      .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const o of olds.slice(Math.max(0, keep))) {
      try { fs.unlinkSync(path.join(dir, o.n)) } catch { /* 删不掉留着，无害 */ }
    }
    return dest
  } catch {
    return null
  }
}

/**
 * **本地时间戳**（2026-11-08 用户：「日志时间和我本地时间不同步」）。
 *
 * 原来日志用 `toISOString()` —— 那是 **UTC**，比本地（UTC+8）慢 8 小时，
 * 用户对着日志看"刚才发生了什么"时永远对不上。
 *
 * 现在输出 `2026-11-08T13:50:12.345+08:00`：
 *   · 前半段就是**本地钟点**，肉眼直接对得上
 *   · 尾巴带时区偏移，机器解析也不会歧义
 */
export function localStamp(t = Date.now()) {
  const d = new Date(t)
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  // getTimezoneOffset() 返回"UTC 减本地"的分钟数（东八区是 -480）
  const offMin = -d.getTimezoneOffset()
  const sign = offMin >= 0 ? '+' : '-'
  const oh = pad(Math.floor(Math.abs(offMin) / 60))
  const om = pad(Math.abs(offMin) % 60)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    + `.${pad(d.getMilliseconds(), 3)}${sign}${oh}:${om}`
}

export class Logger {
  /**
   * @param {object} [opts]
   * @param {'debug'|'info'|'warn'|'error'} [opts.level]
   * @param {number} [opts.ringSize]  内存保留条数
   * @param {string} [opts.file]      落盘文件（可选）
   * @param {number} [opts.maxBytes]   单文件超过这个大小就在**下次启动**轮转（0=不轮转）
   * @param {number} [opts.keep]       轮转后保留几个历史文件
   * @param {boolean} [opts.console]  是否输出到控制台
   */
  constructor(opts = {}) {
    this.level = opts.level ?? 'info'
    this.ringSize = opts.ringSize ?? 2000
    this.file = opts.file ?? null
    /** 轮转阈值（见文件头 `rotateIfNeeded`）。0 或负数 = 关掉轮转。 */
    this.maxBytes = opts.maxBytes ?? 5 * 1024 * 1024
    this.keep = opts.keep ?? 5
    this.toConsole = opts.console !== false
    /** @type {Array<{t:number,level:string,msg:string}>} */
    this.ring = []
    this._stream = null
    this._listeners = new Set()
  }

  /** 订阅日志（Web UI 的 SSE 用）。 */
  subscribe(fn) {
    this._listeners.add(fn)
    return () => this._listeners.delete(fn)
  }

  _write(level, msg) {
    if (LEVELS[level] < LEVELS[this.level]) return
    const entry = { t: Date.now(), level, msg: String(msg) }
    this.ring.push(entry)
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize)

    if (this.toConsole) {
      const ts = new Date(entry.t).toLocaleTimeString('zh-CN', { hour12: false })
      const tag = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' }[level] ?? '???'
      const line = `${ts} [${tag}] ${entry.msg}`
      if (level === 'error') console.error(line)
      else if (level === 'warn') console.warn(line)
      else console.log(line)
    }

    if (this.file) {
      try {
        if (!this._stream) {
          fs.mkdirSync(path.dirname(this.file), { recursive: true })
          /*
           * ⚠️ **轮转必须在这里、在 `createWriteStream` 之前**。
           *    Windows 上打开着的文件改不了名（EPERM），所以只能趁还没打开时动手。
           *    这一行之前没有 —— 于是日志只追加、从不轮转，长到 7.6MB，
           *    把半年前的记录和刚写的一行混在一起（详见 `rotateIfNeeded` 的注释）。
           */
          const rotated = rotateIfNeeded(this.file, this.maxBytes, this.keep)
          this._stream = fs.createWriteStream(this.file, { flags: 'a' })
          if (rotated) {
            // 轮转完写一行说明 —— 否则下一个人会以为"日志怎么突然短了"
            this._stream.write(
              `${localStamp()} [info] 日志已轮转：上一份 = ${path.basename(rotated)}`
              + `（阈值 ${Math.round(this.maxBytes / 1024 / 1024)}MB，保留 ${this.keep} 份）\n`,
            )
          }
        }
        this._stream.write(`${localStamp(entry.t)} [${level}] ${entry.msg}\n`)
      } catch { /* 落盘失败不影响运行 */ }
    }

    for (const fn of this._listeners) {
      try { fn(entry) } catch { /* ignore */ }
    }
  }

  debug(msg) { this._write('debug', msg) }
  info(msg) { this._write('info', msg) }
  warn(msg) { this._write('warn', msg) }
  error(msg) { this._write('error', msg) }

  /** 最近 N 条。 */
  recent(n = 200) {
    return this.ring.slice(-n)
  }

  /** 给其它层用的简单接口（{info,warn,error}）。 */
  get api() {
    return {
      info: (m) => this.info(m),
      warn: (m) => this.warn(m),
      error: (m) => this.error(m),
      debug: (m) => this.debug(m),
    }
  }

  /**
   * 关掉写流。
   *
   * ⚠️ **返回 Promise**（2026-11-03 改）。原因：`createWriteStream` 是**异步打开**的，
   *    所以 `info(...)` 之后**立刻**去读那个文件，它可能**还没被创建**。
   *    测试里这一点尤其致命 —— 三条断言全红，而代码其实是对的
   *    （报的是 `ENOENT: open '…\e.log'`，看着像轮转把文件弄丢了）。
   *
   *    生产上也有一点关系：启动后**马上崩溃**的话，头几行会来不及落盘。
   *    所以调用方要"确认写完了"就该 `await logger.close()`。
   *
   * 传 `timeoutMs` 兜底，避免流卡住时永远不 resolve（那个 timer 会 `unref()`，
   * 不会拖住进程退出）。
   */
  close(timeoutMs = 2000) {
    const s = this._stream
    this._stream = null
    if (!s) return Promise.resolve()
    return new Promise((resolve) => {
      let done = false
      const fin = () => { if (!done) { done = true; resolve() } }
      // 'close' 才是真正写完并释放 fd 的时刻；'finish' 只是数据交出去了
      s.on('close', fin)
      s.on('error', fin)
      const t = setTimeout(fin, timeoutMs)
      if (typeof t.unref === 'function') t.unref()
      try { s.end() } catch { fin() }
    })
  }
}
