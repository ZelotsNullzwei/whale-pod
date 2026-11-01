/**
 * B 站视频**音频转写**（2026-11-01）。
 *
 * ## 为什么需要这一层
 * 用户原话：「视频内容还是看不见这种感觉，还是在读评论和弹幕」。
 * 评论弹幕是**别人怎么看**，不是**视频说了什么**。
 *
 * B 站的官方字幕接口匿名拿不到（`subtitle.subtitles` 恒 0 条）、
 * AI 总结 `-403`。**但音频流是免登录的** —— 所以走「下载音频 → 本地转写」，
 * 等于**听懂**了视频。
 *
 * ## 设计原则
 * - **绝不阻塞主流程**：转写慢（CPU 跑 whisper），调用方应给短超时，
 *   超时就当没有，不能因为一个外链把回复卡住。
 * - **失败静默**：没装 / 没模型 / 转出来是空 —— 一律返回 `null`，
 *   由调用方决定"没有就没有"。
 * - **不下载模型到仓库**：模型缓存在用户目录（HuggingFace 默认位置）。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(HERE, 'asr.py')

/**
 * 找可用的 Python。
 *
 * 优先用 DSH 运行时自带的那个（它装了 faster-whisper）；
 * 退回 PATH 里的 `python`。
 */
function findPython() {
  const candidates = [
    // DSH 桌面版运行时自带的
    path.join(os.homedir(), '.dsh', 'dsh-runtimes',
      'dsh-plugin-desktop-primary-runtime', 'dependencies', 'python', 'python.exe'),
    // 常见安装位置
    path.join(os.homedir(), '.dsh', 'dsh-runtimes',
      'dsh-plugin-desktop-primary-runtime', 'dependencies', 'python', 'bin', 'python3'),
    'python',
    'python3',
  ]
  for (const c of candidates) {
    if (c.includes(path.sep) && !fs.existsSync(c)) continue
    return c
  }
  return null
}

/**
 * 转写一段音频。
 *
 * @param {Buffer} audio 音频字节（m4a/mp3/wav 都行，whisper 靠 av 解码）
 * @param {object} [opts]
 * @param {string} [opts.model] `tiny`（默认）/ `base` / `small`
 * @param {string} [opts.lang] 默认 `zh`
 * @param {number} [opts.timeoutMs] 默认 90 秒（超时就放弃）
 * @param {object} [opts.log]
 * @returns {Promise<{text:string, lang:string, duration:number}|null>}
 */
export async function transcribeAudio(audio, opts = {}) {
  if (!Buffer.isBuffer(audio) || audio.length < 1024) return null
  if (!fs.existsSync(SCRIPT)) {
    opts.log?.debug?.('ASR：找不到 asr.py，跳过')
    return null
  }
  const py = findPython()
  if (!py) {
    opts.log?.debug?.('ASR：找不到 python，跳过')
    return null
  }

  const tmp = path.join(os.tmpdir(), `wp-asr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.m4a`)
  try {
    fs.writeFileSync(tmp, audio)
  } catch (e) {
    opts.log?.debug?.(`ASR：写临时文件失败 — ${e?.message ?? e}`)
    return null
  }

  const model = String(opts.model ?? 'tiny')
  const lang = String(opts.lang ?? 'zh')
  const timeoutMs = Number(opts.timeoutMs ?? 90_000)

  try {
    const out = await new Promise((resolve) => {
      let stdout = ''
      let stderr = ''
      let done = false
      const child = spawn(py, [SCRIPT, tmp, model, lang], {
        env: {
          ...process.env,
          // 国内直连 HuggingFace 常常超时 —— 默认走镜像（可用环境变量覆盖）
          HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com',
          /*
           * ⚠️ **必须关掉 xet**（2026-11-01 实测）。
           *
           * huggingface-hub 2.4 默认用 `hf-xet` 传输（CAS 分块上传/下载），
           * 它走 `cas-server.xethub.hf.co` —— 镜像站不认这个域名，直接：
           * ```
           * CAS Client Error: HTTP status client error (401 Unauthorized)
           * domain: https://cas-server.xethub.hf.co/v2/reconstructions/...
           * ```
           * 关掉后回退到传统 HTTP 下载，镜像就正常了。
           */
          HF_HUB_DISABLE_XET: '1',
          // 别让它在后台偷偷联网更新
          HF_HUB_DISABLE_TELEMETRY: '1',
        },
        windowsHide: true,
      })
      const timer = setTimeout(() => {
        if (done) return
        done = true
        try { child.kill() } catch { /* 已经退了 */ }
        opts.log?.info?.(`ASR：超时 ${Math.round(timeoutMs / 1000)}s，放弃`)
        resolve(null)
      }, timeoutMs)

      child.stdout?.on('data', (b) => { stdout += b.toString('utf8') })
      child.stderr?.on('data', (b) => { stderr += b.toString('utf8') })
      child.on('error', (e) => {
        if (done) return
        done = true
        clearTimeout(timer)
        opts.log?.debug?.(`ASR：启动 python 失败 — ${e?.message ?? e}`)
        resolve(null)
      })
      child.on('close', () => {
        if (done) return
        done = true
        clearTimeout(timer)
        // 脚本把结果打在一行 JSON 里；stderr 是 whisper 的进度噪音，不看
        const line = stdout.split('\n').reverse().find((l) => l.trim().startsWith('{'))
        if (!line) {
          opts.log?.debug?.(`ASR：没有 JSON 输出（stderr 尾部：${stderr.slice(-120)}）`)
          resolve(null)
          return
        }
        try {
          const j = JSON.parse(line)
          if (!j?.ok) {
            opts.log?.debug?.(`ASR：${j?.error ?? '未知错误'}`)
            resolve(null)
            return
          }
          resolve(j)
        } catch {
          resolve(null)
        }
      })
    })

    if (!out) return null
    const text = String(out.text ?? '').trim()
    if (!text) {
      opts.log?.info?.('ASR：转出来是空的（可能没语音：纯音乐 / 无声演示）')
      return null
    }
    opts.log?.info?.(`ASR：转出 ${text.length} 字（${out.duration}s 音频，${out.model}）`)
    return { text, lang: out.lang ?? lang, duration: Number(out.duration ?? 0) }
  } finally {
    try { fs.unlinkSync(tmp) } catch { /* 临时文件清不掉也不影响 */ }
  }
}

/**
 * 一站式：给 bvid + cid，拿视频**说了什么**。
 *
 * 调用方（bridge）只关心"有没有文字"，不关心下载/转写细节。
 *
 * @param {string} bvid
 * @param {number} cid
 * @param {{fetchAudioCandidates:Function, downloadAudio:Function}} bili
 * @param {object} [opts]
 * @returns {Promise<string>} 转写文本（拿不到给空串）
 */
export async function transcribeVideo(bvid, cid, bili, opts = {}) {
  try {
    const cands = await bili.fetchAudioCandidates(bvid, cid, opts)
    if (!cands.length) return ''
    const dl = await bili.downloadAudio(cands, opts)
    if (!dl) return ''
    const r = await transcribeAudio(dl.buffer, opts)
    return r?.text ?? ''
  } catch (e) {
    opts.log?.debug?.(`ASR：${e?.message ?? e}`)
    return ''
  }
}

/* ────────────────────────────────────────────────────────────
 * 转写缓存：**只在内存里，有上限，重启即清**
 * ────────────────────────────────────────────────────────────
 *
 * 用户问过：「转写内容是一次性的吗？不然缓存会越来越大」。
 * 明确的设计：
 *
 *   · **音频**：绝不缓存 —— 324KB/41 秒，几百个视频就是几百 MB。
 *     `transcribeAudio` 的 `finally` 里已经 `unlink` 了临时文件。
 *   · **转写文本**：缓存，但**只在内存**（Map），上限 `ASR_CACHE_MAX` 条，
 *     超出按**最久没被用**淘汰（LRU）。进程退出就全没了。
 *   · **不落盘**：转写是"这次聊天要用"的东西，跨重启没意义；
 *     落盘还要管清理、损坏、隐私，不值当（重转一次才 4 秒）。
 *
 * 文本很小（一条 200~500 字 ≈ 1KB），50 条 ≈ 50KB —— 内存里可忽略。
 */
const ASR_CACHE_MAX = 50
const ASR_CACHE_TTL_MS = 30 * 60_000   // 30 分钟：视频内容不会变，但没必要留永久
const asrCache = new Map()             // bvid -> { text, at }

/**
 * 带缓存的「视频说了什么」。
 *
 * @param {string} bvid
 * @param {number} cid
 * @param {{fetchAudioCandidates:Function, downloadAudio:Function}} bili
 * @param {object} [opts]
 * @returns {Promise<string>}
 */
export async function transcribeVideoCached(bvid, cid, bili, opts = {}) {
  const key = String(bvid ?? '').trim()
  if (!key) return ''

  const now = Date.now()
  const hit = asrCache.get(key)
  if (hit && now - hit.at < ASR_CACHE_TTL_MS) {
    // 命中就挪到末尾（Map 保持插入顺序，末尾 = 最近用过）
    asrCache.delete(key)
    asrCache.set(key, hit)
    opts.log?.debug?.(`ASR：命中缓存（${hit.text.length} 字）`)
    return hit.text
  }

  const text = await transcribeVideo(key, cid, bili, opts)
  if (!text) return ''   // 失败**不缓存** —— 下次还能再试

  asrCache.set(key, { text, at: now })
  // LRU：超上限就删最旧的那个
  while (asrCache.size > ASR_CACHE_MAX) {
    const oldest = asrCache.keys().next().value
    asrCache.delete(oldest)
  }
  return text
}

/** 给测试/排查用：看缓存现状（不返回正文，只看规模）。 */
export function asrCacheStats() {
  return { size: asrCache.size, max: ASR_CACHE_MAX, ttlMs: ASR_CACHE_TTL_MS }
}

/** 清空缓存（测试用）。 */
export function clearAsrCache() {
  asrCache.clear()
}
