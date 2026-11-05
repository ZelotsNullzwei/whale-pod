/**
 * 三视图只取「正面那一幅」当参考图（2026-11-05）。
 *
 * ## 问题
 * `bodyRefImage` 指向 `her-body-3view.png` —— 一张 3154x1856 的**三联画**
 * （正面 / 侧面 / 背面并排）。它被整张发给 `/images/edits`，
 * 模型拿到的是"三个并排的人"，只能粗略参考 → 身形飘（画出来偏丰满）。
 *
 * ## 修法
 * 检测到参考图是三视图（文件名含 3view/三视图，或宽高比 > 1.6），
 * 就**裁出最左边那一幅**（正面）缓存起来当参考图。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const PY_CANDIDATES = [
  process.env.WHALEPOD_PYTHON,
  path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-next-primary-runtime', 'dependencies', 'python', 'python.exe'),
  'python',
].filter(Boolean)

/**
 * @param {string} refPath 原参考图路径
 * @param {object} [log]
 * @returns {string} 单幅参考图路径（裁剪失败就原样返回）
 */
export function singlePanelRef(refPath, log = {}) {
  const p = String(refPath ?? '')
  if (!p || !fs.existsSync(p)) return p
  // 只对"三视图"处理
  if (!/3view|三视图|three[-_]?view/i.test(p)) return p

  const cached = p.replace(/\.(png|jpe?g|webp)$/i, '-front.jpg')
  try {
    if (fs.existsSync(cached)) {
      const st = fs.statSync(cached)
      const src = fs.statSync(p)
      if (st.mtimeMs >= src.mtimeMs && st.size > 2048) return cached
    }
  } catch { /* 继续往下裁 */ }

  const script = [
    'import sys',
    'from PIL import Image',
    'im = Image.open(sys.argv[1]).convert("RGB")',
    'w, h = im.size',
    'im.crop((0, 0, int(w / 3), h)).save(sys.argv[2], quality=92)',
  ].join('\n')
  for (const py of PY_CANDIDATES) {
    try {
      execFileSync(py, ['-c', script, p, cached], { timeout: 25000, stdio: 'ignore' })
      const out = fs.statSync(cached)
      if (out.size > 2048) {
        log.info?.(`生图：参考图是三视图 → 只取正面那幅（${Math.round(out.size / 1024)}KB）`)
        return cached
      }
    } catch { /* 换下一个解释器 */ }
  }
  log.warn?.('生图：三视图裁剪失败（没找到 python+Pillow），仍用整张')
  return p
}