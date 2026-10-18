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

export class Logger {
  /**
   * @param {object} [opts]
   * @param {'debug'|'info'|'warn'|'error'} [opts.level]
   * @param {number} [opts.ringSize]  内存保留条数
   * @param {string} [opts.file]      落盘文件（可选）
   * @param {boolean} [opts.console]  是否输出到控制台
   */
  constructor(opts = {}) {
    this.level = opts.level ?? 'info'
    this.ringSize = opts.ringSize ?? 2000
    this.file = opts.file ?? null
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
          this._stream = fs.createWriteStream(this.file, { flags: 'a' })
        }
        this._stream.write(`${new Date(entry.t).toISOString()} [${level}] ${entry.msg}\n`)
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

  close() {
    try { this._stream?.end() } catch { /* ignore */ }
    this._stream = null
  }
}
