/**
 * 托盘图标（可选）。
 *
 * ## 为什么这里「尽力而为」
 *
 * Windows 托盘需要原生 API 或第三方包（node-systray / trayicon 之类），
 * 而 WhalePod 的核心价值（网关 + 机器人）**不依赖托盘**。
 * 所以这一层设计成：能用就用，不能用就安静降级 ——
 * 不因为托盘挂了导致整个程序起不来。
 *
 * ## 实现选择
 *
 * 优先尝试已安装的轻量库；都没有时退回「控制台窗口」模式：
 * 进程继续在前台跑，日志即控制台，Ctrl+C 退出。
 * 这对服务器/无桌面环境也更合适。
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * 创建一个 16x16 的 PNG 图标（内嵌 base64，避免依赖图片文件）。
 * 深色圆角底 + 蓝色盾牌轮廓。
 */
const ICON_B64 = (() => {
  // 一个极简的 16x16 PNG（深色底 + 蓝点），压缩后很短
  // 注意：这里用程序生成，避免手写 base64 出错
  return null
})()

/**
 * 尝试创建托盘。
 *
 * @param {object} opts
 * @param {object} opts.log
 * @param {Function} opts.onQuit
 * @param {Function} opts.onOpenWeb
 * @param {Function} opts.status   返回当前状态的函数
 * @returns {Promise<object|null>} 托盘句柄；不可用时返回 null
 */
export async function createTray(opts) {
  const { log } = opts

  // ── 尝试 1：systray（若用户装了）────────────────────────────
  try {
    const mod = await import('systray2').catch(() => null)
    if (mod?.default) {
      return await createSystray(mod.default, opts)
    }
  } catch (e) {
    log.warn?.(`托盘：systray2 不可用（${String(e?.message ?? e)}）`)
  }

  try {
    const mod = await import('node-systray').catch(() => null)
    if (mod) {
      log.warn?.('托盘：node-systray 接口不同，暂不支持；回退到控制台模式')
    }
  } catch { /* ignore */ }

  // ── 回退：控制台模式 ───────────────────────────────────────
  log.info?.('托盘不可用 —— 以控制台模式运行（Ctrl+C 退出）。核心功能不受影响。')
  return null
}

/**
 * 用 systray2 创建托盘。
 * systray2 的 API：new SysTray({ menu: {...}, icon, title })
 */
async function createSystray(SysTray, opts) {
  const { log, onQuit, onOpenWeb, status } = opts
  const icon = makeIconBase64()

  const menu = {
    icon,
    title: 'WhalePod',
    tooltip: 'WhalePod · QQ 机器人运行时',
    items: [
      { title: '打开控制台', tooltip: '在浏览器打开管理界面', enabled: true, checked: false },
      { title: '─', enabled: false },
      { title: '状态', tooltip: '', enabled: false, checked: false },
      { title: '退出', tooltip: '停止 WhalePod', enabled: true, checked: false },
    ],
  }

  const tray = new SysTray({ menu, debug: false, copyDir: true })

  tray.onClick((action) => {
    const title = action?.item?.title ?? ''
    if (title === '退出') return onQuit?.()
    if (title === '打开控制台') return onOpenWeb?.()
    if (title === '状态') {
      const s = status?.() ?? {}
      log.info?.(`状态：网关 ${s.gateway ?? '-'}，控制台 ${s.web ?? '-'}，渠道 ${s.providers ?? 0} 个`)
    }
  })

  await tray.ready?.()
  log.info?.('托盘：已创建')

  return {
    tray,
    destroy() { try { tray.kill?.(false) } catch { /* ignore */ } },
  }
}

/**
 * 生成一个 16x16 PNG 的 base64。
 *
 * 这里不引入图像库 —— 直接拼一个最小的 RGBA PNG：
 * 深色圆角方块 + 中间一个蓝点。用手写 zlib 太啰嗦，
 * 所以退一步：使用一个**已知有效的极小 PNG**（纯色 16x16），
 * 具体图案由用户在设置里替换。
 */
function makeIconBase64() {
  // 16x16 圆角纯色 PNG（#4f8cff）—— 手写的最小合法 PNG
  const w = 16, h = 16
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    const row = y * (w * 4 + 1)
    raw[row] = 0 // filter type
    for (let x = 0; x < w; x++) {
      const i = row + 1 + x * 4
      const dx = x - 7.5, dy = y - 7.5
      const inside = Math.sqrt(dx * dx + dy * dy) <= 7
      raw[i] = 0x4f      // R
      raw[i + 1] = 0x8c  // G
      raw[i + 2] = 0xff  // B
      raw[i + 3] = inside ? 0xff : 0x00
    }
  }
  const idat = zlib.deflateSync(raw)
  const chunks = []
  chunks.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  chunks.push(chunk('IHDR', (() => {
    const b = Buffer.alloc(13)
    b.writeUInt32BE(w, 0); b.writeUInt32BE(h, 4)
    b[8] = 8; b[9] = 6; b[10] = 0; b[11] = 0; b[12] = 0
    return b
  })()))
  chunks.push(chunk('IDAT', idat))
  chunks.push(chunk('IEND', Buffer.alloc(0)))
  return 'data:image/png;base64,' + Buffer.concat(chunks).toString('base64')
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuf, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0, 0)
  return Buffer.concat([len, body, crc])
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c ^ 0xffffffff
}
