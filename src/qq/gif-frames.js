/**
 * 动图（GIF / 动画 WebP）**抽帧拼图**。
 *
 * ## 为什么需要（2026-11-19）
 *
 * 视觉模型看 GIF **只取第一帧**（各家都一样，不是我们没传对）。
 * 于是「先愣住 → 爆笑」这种表情包，模型只看到「愣住」，
 * 打出来的标签就偏了，她挑表情时也会挑错。
 *
 * 解法：离线把动图解码成**按时间顺序的若干帧**，横排拼成一张静图，
 * 再交给视觉模型 —— 这样它看到的是一条动作线，而不是一个瞬间。
 * 这是 `dsh-read-animation` 那类插件在做的事，我们在 Node 侧自己实现，
 * 不依赖 DSH 进程。
 *
 * ## 纪律
 *
 * · 任何失败（没 Python / 没 Pillow / 解码炸）→ 返回 null，
 *   调用方**退回原始图**，绝不因为抽帧把表情弄丢。
 * · 帧数固定 3 帧（首 / 中 / 尾），多了 token 涨、收益不线性。
 * · 统一缩放到同一高度再横排，避免不同帧尺寸拼不齐。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/** Python 解释器候选（与 mcpImage.js 保持同一套约定）。 */
function pythonCandidates() {
  return [
    process.env.WHALEPOD_PYTHON,
    path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-next-primary-runtime', 'dependencies', 'python', 'python.exe'),
    'python',
  ].filter(Boolean)
}

const SCRIPT = [
  'import sys',
  'from PIL import Image, ImageSequence',
  'src, dst = sys.argv[1], sys.argv[2]',
  'max_side = int(sys.argv[3]) if len(sys.argv) > 3 else 640',
  'try:',
  '    im = Image.open(src)',
  'except Exception:',
  '    sys.exit(3)',
  'n = getattr(im, "n_frames", 1)',
  'if n <= 1:',
  '    sys.exit(4)',
  '# 首 / 中 / 尾三帧（按时间顺序）',
  'idx = sorted(set([0, n // 2, n - 1]))',
  'want = set(idx)',
  'frames = []',
  'for i, fr in enumerate(ImageSequence.Iterator(im)):',
  '    if i in want:',
  '        frames.append((i, fr.convert("RGB").copy()))',
  '    if len(frames) >= len(want):',
  '        break',
  'if not frames:',
  '    sys.exit(5)',
  '# 统一缩放到同一高度，横排',
  'h = max_side',
  'scaled = []',
  'for i, f in frames:',
  '    w, fh = f.size',
  '    nw = max(1, int(round(w * (h / float(fh)))))',
  '    scaled.append((i, f.resize((nw, h), Image.LANCZOS)))',
  'gap = 8',
  'total_w = sum(s.size[0] for _, s in scaled) + gap * (len(scaled) - 1)',
  'canvas = Image.new("RGB", (total_w, h), (255, 255, 255))',
  'x = 0',
  'for i, s in scaled:',
  '    canvas.paste(s, (x, 0))',
  '    x += s.size[0] + gap',
  'canvas.save(dst, "JPEG", quality=88)',
  'print(len(frames), n)',
].join('\n')

/**
 * 把动图抽成「首/中/尾」三帧横排拼图。
 *
 * @param {Buffer} buf 原始动图字节
 * @param {{maxSide?:number, log?:object}} [opts]
 * @returns {{jpeg:Buffer, frames:number, total:number}|null} 失败返回 null（调用方退回原图）
 */
export function gifFrameGrid(buf, opts = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 512) return null
  const log = opts.log ?? {}
  /*
   * ⚠️ 帧高度别太小（2026-11-19 实测）：
   * 384px 时图上文字被压糊，模型把「叭叭叭叭叭」认成日文片假名「マハマハ」，
   * 而单帧原图能认对。640px 既能看清字，拼图也不至于太大。
   */
  const maxSide = Number(opts.maxSide ?? 640)
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const tmpIn = path.join(os.tmpdir(), `wp-giff-${stamp}.gif`)
  const tmpOut = path.join(os.tmpdir(), `wp-giff-${stamp}.jpg`)
  try {
    fs.writeFileSync(tmpIn, buf)
    for (const py of pythonCandidates()) {
      try {
        const out = execFileSync(py, ['-c', SCRIPT, tmpIn, tmpOut, String(maxSide)], {
          timeout: 20000,
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        })
        const jpeg = fs.readFileSync(tmpOut)
        if (jpeg.length < 1024) continue
        const parts = String(out ?? '').trim().split(/\s+/).map(Number)
        return { jpeg, frames: parts[0] || 0, total: parts[1] || 0 }
      } catch { /* 换下一个解释器 / 静态图会 exit 4 */ }
    }
    return null
  } catch (e) {
    log.debug?.(`gif-frames：抽帧失败 — ${String(e?.message ?? e)}`)
    return null
  } finally {
    try { fs.unlinkSync(tmpIn) } catch { /* 系统会清 temp */ }
    try { fs.unlinkSync(tmpOut) } catch { /* 同上 */ }
  }
}

/**
 * 看起来像动图吗（只做零成本粗判，真正解不出来的静态 GIF 由 gifFrameGrid 兜底）。
 *
 * @param {string} mediaType
 * @param {Buffer} buf
 */
export function looksAnimated(mediaType, buf) {
  const mt = String(mediaType ?? '').toLowerCase()
  if (mt === 'image/gif' || mt === 'image/webp') {
    // 多帧标志：GIF 里出现多次 Graphic Control Extension 或有 NETSCAPE 循环块
    if (mt === 'image/gif' && Buffer.isBuffer(buf)) {
      const s = buf.toString('latin1')
      const gce = (s.match(/!\xf9\x04/g) ?? []).length
      if (gce >= 2) return true
      return s.includes('NETSCAPE2.0')
    }
    return true
  }
  return false
}
