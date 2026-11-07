/**
 * 部位参考图（2026-11-07 实测出来的关键机制）。
 *
 * ## 为什么需要
 * 生图走的是 edits 接口（一张参考图 + 一句话），**参考图就是构图基准**：
 * 喂全身图，模型就画整个人；喂局部图，它才画局部。
 *
 * 实测（同一条 prompt「看看腿」）：
 *   · 全身三视图当参考 → 整张脸 + 腿在下半屏
 *   · 从她自己生成图裁出的"腿"当参考 → **原生只有腿，没有脸**（连跑两次都这样）
 *
 * 所以部位特写要做的第一件事不是改提示词，是**换参考图**。
 *
 * ## 谁负责裁切（C 方案，2026-11-07 定案）
 * · **部位分类**：`detectBodyPart()` 正则 —— 视觉模型不参与
 * · **裁切执行**：本文件（程序）
 * · **脸的下边界**：视觉模型只吐 `face_found` / `face_bottom_y` / `confidence`
 *   三个字段（见 `faceBand.js`），由本文件用来**抬升裁切起点**
 *
 * 裁切起点 = max(该部位的默认起点, 脸下边界 + 安全边距)。
 * 拿不到可靠的脸位置时：
 *   · 有"无脸也安全"的保守区间 → 用它
 *   · 没有（锁骨/胸部这类天生靠近脸） → **直接不出参考图**，
 *     绝不允许拿一张可能带脸的原图去做"局部参考"
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

/** 算法版本：改了区间/边距/裁法就 +1，让缓存整体失效（GPT 交接 §8）。 */
export const PART_REF_ALGO_VERSION = 2

/** 脸下边界之外再留的余量（占整图高度）。 */
export const FACE_SAFETY_MARGIN = 0.03

/**
 * 各部位在"坐姿/站姿自拍"里的典型纵向区间（0~1）。
 * ⚠️ 起点都压在**下巴线以下**（自拍里脸通常占到 0.45 左右）。
 */
const PART_BAND = {
  /* 只保留"原生局部 + 事后裁切双保险"的部位（2026-11-08：「只留准确的」） */
  腿: [0.44, 1.0],
  脚: [0.72, 1.0],
  小腹: [0.40, 0.82],
  腰: [0.34, 0.76],
}

/**
 * **没有脸位置信息时**仍然安全的保守区间（已验证不圈脸的那几个）。
 * 表里没有的部位 → 检测失败就停止生成参考图。
 */
const SELF_SAFE_BAND = {
  腿: [0.55, 1.0],
  脚: [0.72, 1.0],
  小腹: [0.52, 0.86],
  腰: [0.50, 0.80],
}

/** 有裁切方案吗（手没有 → 调用方回退原参考图）。 */
export function partBandOf(part) {
  return PART_BAND[String(part ?? '')] ?? null
}

/** 检测不到脸时还能不能安全裁（能 → 返回保守区间，不能 → null）。 */
export function selfSafeBandOf(part) {
  return SELF_SAFE_BAND[String(part ?? '')] ?? null
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

function hashOfFile(file, limitBytes = 512 * 1024) {
  try {
    const stat = fs.statSync(file)
    const fd = fs.openSync(file, 'r')
    const len = Math.min(stat.size, limitBytes)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, 0)
    fs.closeSync(fd)
    return crypto.createHash('sha1').update(buf).update(String(stat.size)).digest('hex').slice(0, 10)
  } catch { return 'nohash' }
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

function listSources(home, imageCfg) {
  return [
    ...recentGenerated(home, 3),
    imageCfg?.bodyRefImage,
    imageCfg?.refImage,
  ].map((s) => (s ? String(s) : '')).filter((s) => s && fs.existsSync(s))
}

/**
 * 算最终裁切区间。
 *
 * @param {string} part
 * @param {{face_found:boolean, face_bottom_y:number|null, confidence:number}|null} faceBand
 * @returns {{band:[number,number], reason:string}|null} null = 不许做参考图
 */
export function resolveBand(part, faceBand = null) {
  const def = partBandOf(part)
  if (!def) return null
  const hasFace = Boolean(faceBand && faceBand.face_found
    && Number.isFinite(Number(faceBand.face_bottom_y))
    && Number(faceBand.confidence) >= 0.5
    && Number(faceBand.face_bottom_y) > 0
    && Number(faceBand.face_bottom_y) <= 1)

  if (hasFace) {
    const floor = Number(faceBand.face_bottom_y) + FACE_SAFETY_MARGIN
    const top = Math.max(def[0], floor)
    /*
     * ⚠️ 修过一个真 bug（2026-11-07 验收时看裁图发现的）：
     *   原来这里写 `Math.min(top, def[1] - 0.15)` —— 本意是别裁成一条太窄的带子，
     *   结果它会把起点**往下拽回脸线上方**：锁骨 band 是 0.40~0.58，
     *   脸下边界 0.49 → floor 0.52，却被 min 压成 0.43 → 裁出来**带着嘴和下巴**。
     *   正确做法：**脸占掉了这个部位 → 这张图不能用作参考，直接停止**。
     */
    if (top > def[1] - 0.15) {
      return null
    }
    return { band: [top, def[1]], reason: `脸下边界 ${Number(faceBand.face_bottom_y).toFixed(2)} + ${FACE_SAFETY_MARGIN}` }
  }
  const safe = selfSafeBandOf(part)
  if (safe) return { band: safe, reason: '没检测到脸 → 保守区间' }
  return null   // 靠近脸的部位 + 没有脸位置 → 停止（绝不用可能带脸的原图）
}

/**
 * 造（或复用）某部位的参考图。
 *
 * @param {object} o
 * @param {string} o.part
 * @param {string} o.home
 * @param {object} [o.imageCfg]
 * @param {{face_found:boolean, face_bottom_y:number|null, confidence:number}|null} [o.faceBand]
 * @param {(file:string)=>Promise<object>} [o.detectFace] 没传 faceBand 时用它现测
 * @param {object} [o.log]
 * @returns {Promise<{file:string|null, source?:string, band?:[number,number], reason:string}>}
 */
export async function buildPartRef({ part, home, imageCfg = {}, faceBand = null, detectFace = null, log = {} } = {}) {
  const key = String(part ?? '')
  if (!home) return { file: null, reason: '没有数据目录' }
  if (!partBandOf(key)) return { file: null, reason: '这个部位不做局部参考图' }

  const sources = listSources(home, imageCfg)
  if (!sources.length) return { file: null, reason: '没有可用的源图' }

  const src = sources[0]

  // 没有现成的脸位置就现测一次（只测源图，测不到会走 resolveBand 的回退）
  let fb = faceBand
  if (!fb && detectFace) {
    try { fb = await detectFace(src) } catch { fb = null }
  }

  const resolved = resolveBand(key, fb)
  if (!resolved) {
    log.warn?.(`部位参考图：${key} 拿不到脸位置，也不在"无脸安全"表里 → 不生成（回退原参考图）`)
    return { file: null, reason: '无法保证不含脸 → 停止' }
  }
  const [top, bottom] = resolved.band

  const outDir = path.join(home, 'part-refs')
  const cacheKey = [
    key,
    hashOfFile(src),
    `${top.toFixed(3)}-${bottom.toFixed(3)}`,
    `v${PART_REF_ALGO_VERSION}`,
  ].join('_')
  const outFile = path.join(outDir, `${cacheKey}.jpg`)

  try {
    fs.mkdirSync(outDir, { recursive: true })
    if (fs.existsSync(outFile) && fs.statSync(outFile).size > 2048) {
      return { file: outFile, source: src, band: resolved.band, reason: `${resolved.reason}（缓存命中）` }
    }
    if (!cropToFile(src, outFile, top, bottom)) {
      log.warn?.(`部位参考图：${key} 裁切失败（回退原参考图）`)
      return { file: null, reason: '裁切失败' }
    }
    // 清掉这个部位的历史版本，免得越堆越多、也不会误用旧裁剪
    try {
      for (const f of fs.readdirSync(outDir)) {
        if (f.startsWith(`${key}_`) && f !== path.basename(outFile)) fs.unlinkSync(path.join(outDir, f))
      }
    } catch { /* 清理失败无所谓 */ }
    log.info?.(`部位参考图：${key} ← ${path.basename(src)} 裁 ${Math.round(top * 100)}%~${Math.round(bottom * 100)}%（${resolved.reason}）`)
    return { file: outFile, source: src, band: resolved.band, reason: resolved.reason }
  } catch (e) {
    log.warn?.(`部位参考图失败：${String(e?.message ?? e).slice(0, 60)}`)
    return { file: null, reason: '异常' }
  }
}
