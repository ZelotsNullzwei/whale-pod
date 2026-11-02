/**
 * 代理兜底 —— 2026-11-01 实测事故。
 *
 * ## 现场
 * 用户在群里发 B 站链接，她说「又看不了视频了」。查下去发现：
 * ```
 * https_proxy = http://127.0.0.1:7890      ← 环境里有代理
 * NODE_USE_ENV_PROXY = 1                   ← Node 被要求走它
 * 127.0.0.1:7890  ✗ ECONNREFUSED           ← 但那代理没在跑
 * b23.tv:443      通                        ← 裸连其实没问题
 * ```
 * Node 的 fetch 一律走那个死掉的代理 → `resolveBvid` 的 catch **静默返回 null**
 * → 日志里一个字都没有 → 她只能干说「看不了」。
 *
 * ## 两条对策
 * 1. **国内站点直连**：B 站这类本来就不需要代理，代理挂了不该连带它们一起挂。
 *    做法是把域名追加进 `no_proxy`（undici 的 EnvHttpProxyAgent 认这个）。
 *    ⚠️ **必须在第一次 fetch 之前做** —— dispatcher 建好之后再改环境变量是没用的
 *    （实测：进程跑起来之后再删 https_proxy，照样 ECONNREFUSED）。
 * 2. **代理不通要吼一声**：不然下次还是这种"什么都查不到"的局面。
 */

/** 走直连的域名（国内站点 + 本机）。子域自动覆盖。 */
export const DIRECT_HOSTS = [
  'bilibili.com',
  'b23.tv',
  'hdslb.com',
  'bilivideo.com',
  'bilivideo.cn',
  'acgvideo.com',
  'biligame.com',
  '127.0.0.1',
  'localhost',
]

/** 当前是否配了代理。 */
export function proxyEnv() {
  return process.env.https_proxy || process.env.HTTPS_PROXY
    || process.env.http_proxy || process.env.HTTP_PROXY || ''
}

/**
 * 把 DIRECT_HOSTS 追加进 no_proxy / NO_PROXY。
 * 幂等；没配代理时什么都不做。
 *
 * @returns {{applied:boolean, noProxy:string}}
 */
export function applyDomesticBypass() {
  const proxy = proxyEnv()
  if (!proxy) return { applied: false, noProxy: process.env.no_proxy ?? '' }
  const cur = String(process.env.no_proxy ?? process.env.NO_PROXY ?? '')
  const have = new Set(cur.split(',').map((s) => s.trim()).filter(Boolean))
  for (const h of DIRECT_HOSTS) have.add(h)
  const merged = [...have].join(',')
  process.env.no_proxy = merged
  process.env.NO_PROXY = merged
  return { applied: true, noProxy: merged }
}

/**
 * 探一下代理通不通（TCP，不建连接池）。
 * 只用来**吼一声**，不拦任何流程 —— 代理挂了也该照常跑，只是日志里要说清。
 */
export async function probeProxy({ timeoutMs = 2500 } = {}) {
  const proxy = proxyEnv()
  if (!proxy) return { configured: false, ok: null, target: '' }
  let host = ''
  let port = 0
  try {
    const u = new URL(proxy.includes('://') ? proxy : `http://${proxy}`)
    host = u.hostname
    port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
  } catch {
    return { configured: true, ok: false, target: proxy, reason: '代理地址解析不了' }
  }
  const net = await import('node:net')
  const ok = await new Promise((resolve) => {
    const s = net.connect({ host, port })
    const done = (v) => { try { s.destroy() } catch { /* ignore */ } resolve(v) }
    s.setTimeout(timeoutMs, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
  return { configured: true, ok, target: `${host}:${port}` }
}