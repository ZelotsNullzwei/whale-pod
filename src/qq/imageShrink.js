/**
 * 审核前先缩图（2026-11-05）。
 *
 * 实测：原图 base64 太大（350~460KB → base64 约 500~600KB），
 * 视觉调用直接 20 秒超时；缩到长边 768 后体积降到 ~60KB，2~5 秒就回。
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
 * @param {Buffer} buf
 * @param {number} [maxSide] 长边上限（默认 768）
 * @param {object} [log]
 * @returns {Promise<Buffer>} 缩好的 JPEG；失败就**原样返回**（审核会自行放行）
 */
export async function shrinkForReview(buf, maxSide = 768, log = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 1024) return buf
  const stamp = `${process.pid}-${Date.now()}`
  const tmpIn = path.join(os.tmpdir(), `wp-rv-${stamp}.img`)
  const tmpOut = path.join(os.tmpdir(), `wp-rv-${stamp}-out.jpg`)
  const script = [
    'import sys',
    'from PIL import Image',
    'im = Image.open(sys.argv[1]).convert("RGB")',
    'n = int(sys.argv[3])',
    'im.thumbnail((n, n))',
    'im.save(sys.argv[2], quality=82)',
  ].join('\n')
  try {
    fs.writeFileSync(tmpIn, buf)
    for (const py of PY_CANDIDATES) {
      try {
        execFileSync(py, ['-c', script, tmpIn, tmpOut, String(maxSide)], { timeout: 20000, stdio: 'ignore' })
        const out = fs.readFileSync(tmpOut)
        if (out.length > 1024) {
          log.info?.(`图片审核：缩到长边 ${maxSide}，${Math.round(out.length / 1024)}KB`)
          return out
        }
      } catch { /* 换下一个解释器 */ }
    }
    log.warn?.('图片审核：缩图失败（没找到 python+Pillow），按原图审')
    return buf
  } finally {
    try { fs.unlinkSync(tmpIn) } catch { /* ignore */ }
    try { fs.unlinkSync(tmpOut) } catch { /* ignore */ }
  }
}