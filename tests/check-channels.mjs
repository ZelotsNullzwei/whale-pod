/**
 * 渠道三来源平铺（2026-11-02）。
 *
 * ## 需求
 * 用户原话：「初始渠道只留官方默认的那条 api key，然后支持自定义添加渠道和链接本地模型」
 * 以及「magpie 其实算自定义渠道吧」。
 *
 * ## 结论：三来源，同一个东西
 * ```
 * builtin  内置官方   凭据里的 DEEPSEEK_API_KEY，自动挂。不可编辑/不可删
 * dsh      DSH 发现   读 DSH 设置里的 provider。可删会被重新发现 → removable=false
 * manual   手填       任何 OpenAI 兼容端点（含本地 Ollama）。可编辑可删
 * ```
 * 优先级：手填 → DSH 发现 → 内置（内置是**付费兜底**，排最后 → 不悄悄涨价）。
 *
 * ## 为什么必须锁住
 * 1. **官方那条原来根本挂不上** —— `deepseek-official` 只在 `createLlmGateway()`
 *    里挂（llm-core.js），而那条路要 `appDir && pack`。实测本机
 *    `findChannelPack()` 返回 null → "只留官方默认"等于**零个渠道**。
 * 2. **模型名写错过一次** —— 官方端点 `/v1/models` 只返回
 *    `deepseek-flash` / `deepseek-v4-pro`，不是 `deepseek-chat`
 *    （那是老开放平台的 id）。写错了渠道就是废的：每次 404，列表里却看着有。
 * 3. **内置排最后** —— 排前面会把你现在用的免费渠道挤掉，等于悄悄涨价。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const idx = read('src/index.js')

ok('★★ 官方渠道在没有 channel-pack 的机器上也挂得上', () => {
  /*
   * 原来只有 `createLlmGateway()` 挂它，而那条路要求 `appDir && pack`。
   * 现在必须**另外**有一条不依赖 pack 的路径。
   */
  assert.match(idx, /officialChannels/, '要有 officialChannels')
  assert.match(
    idx,
    /resolveChannelKey\(\{\s*apiKeyEnv:\s*'DEEPSEEK_API_KEY'\s*\}/,
    '要从凭据里取 DEEPSEEK_API_KEY',
  )
  assert.match(idx, /https:\/\/api\.deepseek\.com\/v1/, '要指向官方端点')
  // 没有 key 就不加 —— 不制造"渠道在列表里但永远用不了"的假象
  assert.match(idx, /if \(officialKey\)/, '没有 key 就不该加这条渠道')
})

ok('★★ 官方渠道的模型名必须是端点真实存在的', () => {
  /*
   * 实测（2026-11-02）官方 `/v1/models` 只返回：
   *   deepseek-flash / deepseek-v4-pro
   * 原来写的是 `deepseek-chat` —— 那是老开放平台的 id，这个端点上 404。
   */
  assert.match(idx, /'deepseek-flash'/, '要有 deepseek-flash')
  assert.match(idx, /'deepseek-v4-pro'/, '要有 deepseek-v4-pro')
  /*
   * ⚠️ **先剥注释再查**。
   *
   * 上面那段注释里**故意写了** `deepseek-chat`（在讲"原来错在哪"）——
   * 不剥注释的话，测试会被自己的说明文字绊倒，红得莫名其妙。
   * 这跟 check-voice 那个「固定字数窗口把注释算进去」是同一类毛病：
   * **断言要看代码，不要看讲解。**
   */
  const codeOnly = idx.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  const at = codeOnly.indexOf('officialChannels.push')
  const seg = codeOnly.slice(at, at + 900)
  assert.ok(
    !/deepseek-chat/.test(seg),
    '代码里不该再出现 deepseek-chat —— 那个模型在这个端点上不存在，调用会 404',
  )
})

ok('★ 优先级：手填 → DSH 发现 → 内置（内置是付费兜底，排最后）', () => {
  assert.match(
    idx,
    /const allChannels = \[\.\.\.selfChannels, \.\.\.autoChannels, \.\.\.officialChannels\]/,
    '内置必须排最后 —— 排前面会把你现在用的免费渠道挤掉，等于悄悄涨价',
  )
})

ok('★ /api/channels 要平铺三来源（只列手填的会让 magpie 看不见）', () => {
  const srv = read('src/web/server.js')
  const at = srv.indexOf("if (p === '/api/channels' && req.method === 'GET')")
  assert.ok(at > 0, '要有 /api/channels')
  const seg = srv.slice(at, at + 1600)
  assert.match(seg, /state\.autoChannelList/, '要带 DSH 自动发现的')
  assert.match(seg, /state\.officialChannelList/, '要带内置官方的')
  assert.match(seg, /source/, '每行要标来源')
  assert.match(seg, /removable/, '要标能不能删（自动发现的删了会被重新发现）')
})

ok('★ 界面：内置/自动发现的不能删，且要说清为什么', () => {
  const a = read('src/web/assets.js')
  assert.match(a, /data-del/, '要有删除按钮')
  assert.match(a, /x\.removable === false \? ''/, '不可删的不渲染删除按钮')
  assert.match(a, /DSH 发现/, '要显示来源标签')
  // 提示语要解释「为什么没有删除按钮」，否则用户以为界面坏了
  assert.match(a, /下次启动又会被发现回来|重新发现回来/, '要解释自动发现的删不掉')
})

ok('★ 本地模型：预置里有 Ollama，且不需要 key', () => {
  const fb = read('src/gateway/fallback.js')
  const at = fb.indexOf('ollama:')
  assert.ok(at > 0, 'PRESET_ENDPOINTS 里要有 ollama')
  const seg = fb.slice(at, at + 260)
  assert.match(seg, /127\.0\.0\.1:11434/, '要指向本机 Ollama 默认端口')
  assert.match(seg, /needsKey:\s*false/, '本地模型不该要求 key')
})

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)