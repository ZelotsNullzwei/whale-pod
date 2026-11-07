/**
 * 部位参考图（2026-11-07 实测出来的关键机制）。
 *
 * ## 为什么需要
 * 生图走的是 `openai-images` 的 "/v1/images/edits"（edits 接口）：**一张参考图 + 一句话**。
 * 参考图就是**构图基准** —— 喂全身图，模型就画整个人；喂局部图，它才画局部。
 *
 * 实测（同一条 prompt「看看腿」）：
 *   · 全身三视图当参考 → 整张脸 + 腿在下半屏
 *   · 从她自己生成图裁出的"腿"当参考 → **原生只有腿，没有脸**（连跑两次都这样）
 *
 * 所以部位特写要做的第一件事不是改提示词，是**换参考图**。
 *
 * ## 三条纪律
 * ① **裁出来的参考图必须避开脸** —— 实测：参考图里带脸，出图必带脸。
 * ② 只做有稳定纵向区间的部位（腿/脚/腰/小腹/锁骨/胸部）；**手不做**
 *    （手在画面里的位置不固定，硬裁会把脸或别的东西带进来）。
 * ③ 裁失败就返回 null，调用方回退到原来的参考图 —— 不许因为裁图把画图搞挂。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * 各部位在"坐姿/站姿自拍"里的典型纵向区间（0~1）。
 * ⚠️ 起点都压在**下巴线以下**（自拍里脸通常占到 0.45 左右），避免把脸裁进参考图。
 */
const PART_BAND = {
  腿: [0.44, 1.0],
  脚: [0.72, 1.0],
  小腹: [0.40, 0.82],
  腰: [0.34, 0.76],
  /*
   * ⚠️ 锁骨 / 胸部 的起点必须压到**下巴线以下**（2026-11-07 实测）：
   *   原来锁骨写 0.16 起 → 把下半张脸、镜子、手机一起裁进参考图 →
   *   出图给了一张带脸的对镜自拍，根本不是锁骨。
   *   自拍里下巴通常落在 0.42~0.45，所以这两个部位从 0.40 起步。
   */
  锁骨: [0.40, 0.58],
  胸部: [0.42, 0.66],
}

/** 有裁切方案吗（手没有 → 调用方回退原参考图）。 */
export function partBandOf(part) {
  return PART_BAND[String(part ?? '')] ?? null
}

function pyCandidates() {
  return [
    process.env.WHALEPOD_PYTHON,
    path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-next-primary-runtime', 'dependencies', 'python', 'python.exe'),
    'python',
  ].filter(Boolean)
}

function cropToFile(srcFile, outFile, top, bottom) {
  const script = [
    'import sys',
    'from PIL import Image',
    'im = Image.open(sys.argv[1]).convert("RGB")',
    'w, h = im.size',
    't = max(0, int(h * float(sys.argv[3])))',
    'b = min(h, int(h * float(sys.argv[4])))',
    'im.crop((0, t, w, max(t + 1, b))).save(sys.argv[2], quality=92)',
  ].join('\n')
  for (const py of pyCandidates()) {
    try {
      execFileSync(py, ['-c', script, srcFile, outFile, String(top), String(bottom)],
        { timeout: 25000, stdio: 'ignore', windowsHide: true })
      if (fs.existsSync(outFile) && fs.statSync(outFile).size > 2048) return true
    } catch { /* 换下一个解释器 */ }
  }
  return false
}

/** 最近生成过的图（新→旧），跳过太小的。 */
function recentGenerated(home, limit = 3) {
  const dir = path.join(home, 'generated')
  try {
    return fs.readdirSync(dir)
      .filter((f) => /\.(png|jpe?g)$/i.test(f))
      .map((f) => path.join(dir, f))
      .map((f) => ({ f, t: fs.statSync(f).mtimeMs, s: fs.statSync(f).size }))
      .filter((x) => x.s > 50 * 1024)
      .sort((a, b) => b.t - a.t)
      .slice(0, limit)
      .map((x) => x.f)
  } catch { return [] }
}

/**
 * 造（或复用）某部位的参考图。
 *
 * @param {object} o
 * @param {string} o.part   '腿' / '脚' / '腰' / '小腹' / '锁骨' / '胸部'
 * @param {string} o.home   数据目录（generated/ 与 part-refs/ 在这下面）
 * @param {object} [o.imageCfg]  `qq.image`，用它的 refImage / bodyRefImage 兜底
 * @param {object} [o.log]
 * @returns {Promise<string|null>} 可用的参考图路径；null = 本次不换参考图
 */
export async function buildPartRef({ part, home, imageCfg = {}, log = {} } = {}) {
  const band = partBandOf(part)
  if (!band || !home) return null
  const key = String(part)
  const outDir = path.join(home, 'part-refs')
  const outFile = path.join(outDir, `${key}.jpg`)
  try {
    fs.mkdirSync(outDir, { recursive: true })
    /*
     * 源优先用**她自己生成过的图**：分辨率高（1024×1808）、衣着是当天的、
     * 比例是真实像素关系。没有历史图时才退回三视图/头像基准图。
     */
    const sources = [
      ...recentGenerated(home, 3),
      imageCfg.bodyRefImage,
      imageCfg.refImage,
    ].map((s) => (s ? String(s) : '')).filter((s) => s && fs.existsSync(s))

    const newest = sources.length ? Math.max(...sources.map((s) => fs.statSync(s).mtimeMs)) : 0
    if (fs.existsSync(outFile) && fs.statSync(outFile).mtimeMs >= newest) {
      return outFile   // 缓存还有效
    }
    for (const src of sources) {
      if (cropToFile(src, outFile, band[0], band[1])) {
        log.info?.(`部位参考图：${key} ← ${path.basename(src)} 裁 ${Math.round(band[0] * 100)}%~${Math.round(band[1] * 100)}%`)
        return outFile
      }
    }
    log.warn?.(`部位参考图：${key} 没裁出来（回退原参考图）`)
    return null
  } catch (e) {
    log.warn?.(`部位参考图失败：${String(e?.message ?? e).slice(0, 60)}`)
    return null
  }
}
