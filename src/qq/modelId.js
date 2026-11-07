/**
 * 模型 id 归一化（2026-11-06 起，2026-11-07 补第二种坏形状）。
 *
 * ## 症状 A：三个 magpie
 * 侧栏下拉点一下 hy4free，写进配置的却成了
 * `magpie/magpie/magpie/workbuddy/hy4free` —— **三个 magpie**。
 * 这个值发给网关必然是 404（`magpie 不认识这个模型`），
 * 但配置里存着、日志里只显示"已更新"，看起来像换成功了。
 *
 * ## 症状 B（2026-11-07 实测）：provider 夹在中间
 * 07:45:12 手写下线的值：
 *   `magpie/deepseek-official/magpie/raccoon/sn-sensenova-6-8-flash`
 * 网关收到的模型名是 `deepseek-official/magpie/raccoon/sn-sensenova-6-8-flash`
 * → magpie 回 404：
 *   「magpie knows no model "deepseek-official/magpie/raccoon/..."」
 *
 * ## 原因
 * 面板拼 id 的规则是 `<渠道>/<provider>/<模型>`，而目录里的 `id`
 * **本身已经带了渠道前缀**（`magpie/workbuddy/hy4free`）——
 * 于是又多拼了一次。不同面板（DSH 侧栏 / whale-pod 自己的页面）
 * 拼法不一致，客户端改不干净，所以**在落库前收口**。
 *
 * ⚠️ 症状 B 不是"首段重复"，是**中间夹了一段 magpie**：
 *   目录 id = `magpie/raccoon/sn-sensenova-6-8-flash`（自带 namespace）
 *   面板又拼成 `<渠道=magpie>/<provider=deepseek-official>/<目录 id>`
 *   → 变成 `<渠道>/<错的 provider>/<namespace>/<provider>/<模型>`
 *
 * ## 规范形状
 * ```
 * <whale-pod 渠道> / magpie / <magpie 的 provider> / <模型>
 *   例：magpie/magpie/qwenwork/flash
 * ```
 * 第二段 `magpie` 是 magpie 自己的 routing group（magpie 侧认
 * `magpie/<provider>/<model>`），第一段是 whale-pod 这边的渠道 id。
 *
 * ## 收口规则
 *   `magpie/magpie/magpie/x`                        → `magpie/magpie/x`
 *   `magpie/deepseek-official/magpie/raccoon/x`     → `magpie/magpie/raccoon/x`
 *   `magpie/magpie/x` / `magpie/x` / `auto`         → 不动
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

  /*
   * 规则 1：中间夹着 'magpie'（目录 id 自带 `magpie/<provider>/<模型>`）。
   *
   * 找**下标 ≥2** 的第一个 'magpie'：
   *   `magpie/deepseek-official/magpie/raccoon/x`   k=2 → magpie/magpie/raccoon/x
   *   `magpie/magpie/deepseek-official/magpie/x`   k=3 → magpie/magpie/x
   *   `magpie/magpie/qwenwork/flash`               没有 → 原样（namespace 已就位）
   */
  let k = -1
  for (let i = 2; i < parts.length; i++) {
    if (parts[i] === 'magpie') { k = i; break }
  }
  let out = parts
  if (k > 0) out = [parts[0], 'magpie', ...parts.slice(k + 1)]

  // 规则 2：首段连续重复（magpie/magpie/magpie/... → magpie/magpie/...）
  const head = out[0]
  let i = 0
  while (i < out.length && out[i] === head) i++
  if (i > 2) out = [head, head, ...out.slice(i)]

  return out.join('/')
}
