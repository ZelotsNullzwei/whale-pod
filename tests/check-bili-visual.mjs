/**
 * B 站"看画面"（分镜图）—— `src/qq/videoshot.js` + 接线 + 面板开关。
 *
 * ## 这一层是什么
 * 用户要的是「在设置里面选择可以看和只听，两个类型，用户自己选择」。
 * 「看画面」= 把 B 站的 **10×10 分镜网格图**喂给视觉模型。
 *
 * ## ★★ 为什么不用 ffmpeg
 * 原计划是抄 `dsh-bili-eyes`（它自己下 ffmpeg + 抽帧 + 拼网格）。
 * 但 **B 站自己有 `x/player/videoshot`** —— 免登录，直接给拼好的网格图 + 每格时间点。
 * 2026-11-03 实测三例（本文件里也钉了一个**真网络**的分支，没网就跳过）：
 * ```
 * BV1VGxp69EWt   70s → 1 张 139KB  13 格   尾值 63s
 * BV17sxY6xEWK  533s → 2 张 794KB 107 格   尾值 528s（跨度/时长 0.99）
 * BV1TxxC6vEo4  968s → 2 张 539KB 195 格   尾值 965s（1.00）
 * ```
 *
 * ## 本文件锁住的（都是**实测踩过的**）
 * ① **`index` 单位是秒不是毫秒** —— 按毫秒读会得出"533 秒的视频只有 528 毫秒"
 * ② **不能按等间隔自己算时间** —— index 是 B 站按场景挑的（`0,0,8,14,19,…`）
 * ③ **只填前 N 格，其余是空的** —— 文案必须说清，否则模型以为漏抓了
 * ④ **失败就跳过视觉层，不许降级成瞎猜**
 * ⑤ **配置必须在 `qq.bilibili`**（`this.cfg` = `qq`）—— 我第一次插成了 `qq.search.bilibili`
 * ⑥ **面板开关默认「只听」** —— 看画面每张图都花钱
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fetchVideoShots, formatShotsNote } from '../src/qq/videoshot.js'

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); console.log(`  ✅ ${name}`); pass++ }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++ }
}

const V = fs.readFileSync(new URL('../src/qq/videoshot.js', import.meta.url), 'utf8')
const B = fs.readFileSync(new URL('../src/qq/bilibili.js', import.meta.url), 'utf8')
const BR = fs.readFileSync(new URL('../src/qq/bridge.js', import.meta.url), 'utf8')
const S = fs.readFileSync(new URL('../src/config/store.js', import.meta.url), 'utf8')
const C = fs.readFileSync(new URL('../plugin/client.js', import.meta.url), 'utf8')

console.log('\n=== ① 单位校验（秒 vs 毫秒）===')

ok('★★★ 必须校验 index 单位，不能硬当秒用', () => {
  assert.match(V, /ratio > 100/, '★ 要有"跨度÷时长"的比值校验')
  assert.match(V, /疑似毫秒/, '★ 疑似毫秒时要换算')
  assert.match(V, /Math\.round\(index\[i\] \/ 1000\)/, '按毫秒换算')
})

ok('★★ 中文说明里要把这个坑写下来（免得下一个人重踩）', () => {
  assert.match(V, /单位是秒/, '要写明单位是秒')
  assert.match(V, /文档通常写毫秒/, '要写明"文档通常写毫秒"这个反差')
})

console.log('\n=== ② 时间轴 ===')

ok('★★★ 不能按等间隔自己算时间（要用 index 给的真实值）', () => {
  assert.match(V, /不能自己按等间隔算/, '注释里要有这条')
  // 代码里必须真的用 index 数组，而不是 duration / cells
  assert.match(V, /const index = Array\.isArray\(d\.index\)/, '要读 index')
  assert.match(V, /index\.map\(\(sec, i\) => \(\{ cell: i \+ 1, sec \}\)\)/, '每格取 index 的时间')
  assert.ok(!/duration\s*\/\s*\(grid\.x \* grid\.y\)/.test(V), '不许按 duration÷格数 摊时间')
})

ok('★★★ 连续相同秒数要合并（B 站给的 index 前面常是 [0,0,…]）', () => {
  assert.match(V, /prev\.sec === t\.sec/, '要合并连续相同')
  assert.match(V, /第\$\{d\.cells\[0\]\}~/, '合并后写成"第1~2格"')
})

ok('★★ 文案要说清"只填了前 N 格，其余不是漏抓"', () => {
  assert.match(V, /只填了前/, '要说明只填了前 N 格')
  assert.match(V, /不是漏抓/, '★ 要明说不是漏抓')
})

console.log('\n=== ③ 失败兜底 ===')

ok('★★★ 没图就返回 null（跳过视觉层，不降级成瞎猜）', async () => {
  assert.match(V, /没给拼图（跳过视觉层，不猜）/, '空图时要有这句日志')
  assert.match(V, /拼图一张都没下下来（跳过视觉层）/, '下载全失败也要跳过')
})

ok('★★ BV 格式先自查（别浪费一次网络请求）', () => {
  assert.match(V, /if \(!\/\^BV\[0-9A-Za-z\]\{10\}\$\/\.test\(bvid\)\) return null/, '格式不对直接返回')
})

ok('★★ 拼图大小上限（防止意外拉个超大文件）', () => {
  assert.match(V, /MAX_IMAGE_BYTES/, '要有上限')
  assert.match(V, /buf\.length > MAX_IMAGE_BYTES/, '下载后还要再查一次（content-length 可能不准）')
})

console.log('\n=== ④ 配置层级（我在这上面栽过）===')

ok('★★★ `bilibili` 必须在 `qq` 层，不是 `qq.search` 里', async () => {
  const { DEFAULTS } = await import('../src/config/store.js')
  assert.ok(DEFAULTS?.qq?.bilibili, '★ 要有 qq.bilibili')
  assert.equal(DEFAULTS.qq.search?.bilibili, undefined,
    '★ 不许出现在 qq.search 里 —— 我第一次插错成了 qq.search.bilibili，读不到还查了半天')
  assert.equal(DEFAULTS.qq.bilibili.visual, 'audio', '默认必须是"只听"（省钱）')
})

ok('★★★ 面板读的也是 `qq.bilibili`（别跟后端错层）', () => {
  assert.match(C, /const bilibiliCfg = cfg\?\.qq\?\.bilibili \?\? \{\}/, '★ 从 qq.bilibili 读')
  assert.match(C, /bilibiliCfg\?\.visual === 'visual'/, '用 bilibiliCfg 判断')
  assert.ok(!/sr\.bilibili/.test(C), '★ 不许读 sr.bilibili（sr 是 qq.search）')
})

console.log('\n=== ⑤ 接线 ===')

ok('★★★ "看画面"模式才拉图（默认不听就一个请求都不发）', () => {
  assert.match(BR, /this\.cfg\.bilibili\?\.visual === 'visual'/, '★ 要判开关')
  const at = BR.indexOf("this.cfg.bilibili?.visual === 'visual'")
  const seg = BR.slice(at, at + 700)
  assert.match(seg, /fetchVideoShots\(/, '开关开了才调')
  assert.match(seg, /info\.shotsNote = formatShotsNote\(shots\)/, '要把文字说明挂上去')
})

ok('★★ 图真的要进上下文（走 _collectImages 那条路）', () => {
  assert.match(BR, /biliShots/, '要接住 shots')
  assert.match(BR, /makeImageBlock/, '要把图变成图块')
  assert.match(BR, /bili:shot:/, '要有个稳定的 key')
  assert.match(BR, /_collectImages\(history, imgReferrer, blocks\)/, '要并进 _collectImages')
})

ok('★★★ attachment 不可用时要说清"模型看不到画面"，不能让它以为看到了', () => {
  assert.match(BR, /attachment 服务不可用[\s\S]{0,80}只能靠文字说明/, '★ 要明说看不到')
})

ok('★★ 文字说明要拼进 videoContext（放在评论之后）', () => {
  assert.match(B, /if \(info\.shotsNote\)/, '要有 shotsNote 分支')
  const atB = B.indexOf('if (info.shotsNote)')
  const atComment = B.indexOf('## 评论区怎么说')
  assert.ok(atComment > 0 && atB > atComment, '画面说明要排在评论区之后')
})

console.log('\n=== ⑤b 有画面时的措辞必须跟上（我 dump 一遍才发现的打架）===')

ok('★★★ 有画面 + 还在后台听 → 说"能聊画面、别聊台词"', () => {
  assert.match(B, /画面你看到了/, '★ 要说"画面你看到了"')
  assert.match(B, /别聊台词/, '★ 要禁止聊台词（那还没听到）')
  assert.match(B, /能聊画面/, '★ 要**允许**聊画面')
})

ok('★★★ 有画面时**不许**再说"这时候别评价/你还没看完"，无画面时照旧', async () => {
  /*
   * 现场：这两句曾经**同时**拼进 prompt ——
   * ```
   *   上面：画面你看到了…能聊画面在发生什么
   *   下面：对方分享了视频，但你还在看 —— 这时候别评价
   *   → 一个让说、一个让别说 ✗
   * ```
   * 我 dump 出完整 ctx 才看见（光看代码看不出来）。
   *
   * ⚠️ 这里**直接渲染**两种 ctx 来断言 —— 比切源码字符串可靠得多：
   *    我第一次就是 slice 到了内层 `if` 的 `} else {`，结果断言假红 ✓。
   */
  const { formatVideoContext } = await import('../src/qq/bilibili.js')
  const base = {
    title: '《绝区零》先导演示丨大肥鱼',
    owner: '某UP',
    duration: 70,
    desc: '',
    comments: [{ text: '占位评论', like: 3 }],
    danmaku: [{ text: '占位弹幕', count: 5 }],
  }
  const NOTE = '## 画面（1 张分镜图）\n· 每张图是 **10×10 网格**'

  const withPic = formatVideoContext({ ...base, pendingLong: true, shotsNote: NOTE })
  const noPic = formatVideoContext({ ...base, pendingLong: true })

  // ── 有画面那一支 ──
  assert.match(withPic, /画面你看到了/, '★ 要说"画面你看到了"')
  assert.match(withPic, /能聊画面/, '★ 要**允许**聊画面')
  assert.match(withPic, /别聊台词/, '★ 但禁止聊台词')
  assert.ok(!withPic.includes('你还没看完，说不像话'),
    '★ 有画面时不许说"你还没看完，说不像话"（那跟"能聊画面"打架）')
  assert.match(withPic, /别给整体评价/, '有画面时改成"别给整体评价"（软一点，但不打架）')

  // ── 没画面那一支（原样）──
  assert.match(noPic, /视频本身你还没听到/, '没画面时照旧')
  assert.match(noPic, /你还没看完，说不像话/, '没画面时照旧"别评价"')
  assert.ok(!noPic.includes('画面你看到了'), '没画面时不许说"画面你看到了"')
})

console.log('\n=== ⑥ 面板开关 ===')

ok('★★★ 面板有「看画面 / 只听」两个选项，默认只听', () => {
  assert.match(C, /t\('bili\.visual'\)/, '要有标签')
  assert.match(C, /value: 'audio', label: t\('bili\.audioOpt'\)/, '有"只听"选项')
  assert.match(C, /value: 'visual', label: t\('bili\.visualOpt'\)/, '有"看画面"选项')
  assert.match(C, /apply\(\{ 'bilibili\.visual': v \}\)/, '★ 提交的是 bilibili.visual（不是 search. 开头）')
})

ok('★ 中英文案都要有', () => {
  for (const k of ['section.bili', 'bili.visual', 'bili.visualHint', 'bili.audioOpt', 'bili.visualOpt']) {
    const n = (C.match(new RegExp(`'${k.replace(/\./g, '\\.')}':`, 'g')) ?? []).length
    assert.ok(n >= 2, `${k} 要中英各一份（找到 ${n} 份）`)
  }
})

ok('★★ 提示里要写明"看画面费 token"', () => {
  assert.match(C, /每张图都花钱/, '★ 中文提示要说清代价')
  assert.match(C, /every image costs tokens/, '★ 英文同理')
})

console.log('\n=== ⑦ 真网络（没网就跳过）===')

try {
  const r = await fetchVideoShots({ bvid: 'BV1VGxp69EWt', duration: 70, log: () => {} })
  if (!r) {
    console.log('  ⏭️  接口没返回（可能没网 / 接口变了）—— 跳过真网络断言')
  } else {
    ok('★★★ 真拉一次：拿到图 + 时间点，且单位是秒', () => {
      assert.ok(r.images.length >= 1, '至少有 1 张图')
      assert.ok(r.images[0].length > 10_000, '图不该是空的')
      assert.equal(r.grid.x, 10, '网格是 10×10')
      assert.equal(r.grid.y, 10)
      assert.ok(r.times.length >= 5, '时间点该有若干个')
      const tail = r.times[r.times.length - 1].sec
      assert.ok(tail > 0 && tail <= 75, `★ 尾值 ${tail} 该落在时长附近（说明单位是秒）`)
    })
    ok('★★ 文字说明能生成，且说清"只填了前 N 格"', () => {
      const note = formatShotsNote(r)
      assert.ok(note.length > 50, '说明不能是空的')
      assert.match(note, /10×10 网格/, '要说网格')
      assert.match(note, /只填了前 \d+ 格/, '要说填了多少格')
    })
  }
} catch (e) {
  console.log(`  ⏭️  真网络那段异常（跳过）：${String(e?.message ?? e).slice(0, 60)}`)
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)