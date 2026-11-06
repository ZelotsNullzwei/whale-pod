/**
 * 模型 id 归一化（2026-11-06）。
 *
 * ## 症状
 * 侧栏下拉点一下 hy4free，写进配置的却成了
 * `magpie/magpie/magpie/workbuddy/hy4free` —— **三个 magpie**。
 * 这个值发给网关必然是 404（`magpie 不认识这个模型`），
 * 但配置里存着、日志里只显示"已更新"，看起来像换成功了。
 *
 * ## 原因
 * 面板拼 id 的规则是 `<渠道>/<provider>/<模型>`，而目录里的 `id`
 * **本身已经带了渠道前缀**（`magpie/workbuddy/hy4free`）——
 * 于是又多拼了一次。不同面板（DSH 侧栏 / whale-pod 自己的页面）
 * 拼法不一致，客户端改不干净，所以**在落库前收口**：
 *
 *   `magpie/magpie/magpie/x` → `magpie/magpie/x`
 *   `magpie/x`               → 不动（有的地方就是这么存的）
 *   `auto`                   → 不动
 *
 * 只处理「连续重复的同一段前缀」，别的模型名（deepseek-official/...）原样返回。
 */

/**
 * @param {string} id 面板传来的模型 id
 * @returns {string} 收口后的 id
 */
export function normalizeModelId(id) {
  const raw = String(id ?? '').trim()
  if (!raw || raw === 'auto') return raw
  const parts = raw.split('/').filter((x) => x !== '')
  if (parts.length < 3) return raw
  // 只处理首段重复（magpie/magpie/... ）
  const head = parts[0]
  let i = 0
  while (i < parts.length && parts[i] === head) i++
  if (i <= 2) return raw            // 没有重复，或本来就只重复一次（magpie/magpie/...）
  return [head, head, ...parts.slice(i)].join('/')
}
