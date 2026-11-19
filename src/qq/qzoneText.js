/**
 * QQ 空间说说「文案工具」（2026-11-19 从 qzoneProactive.js 拆出来）
 *
 * ## 为什么拆
 * 旧的「草稿预览 + 等他确认」调度器已经停用（用户：「不用旧的了」）。
 * 但那套代码里有几块**跟调度无关的纯函数**还在用：
 *   · `checkQzoneText`        —— 发之前的文案体检（ownLife 用它）
 *   · `qzoneTextFromFact`     —— 由事实拼一句话
 *   · `composeContent` / `pickContentType` / `CONTENT_RATIO`
 *   · `hasContentPoint` / `scrubMaterialText` / `isPublicSafeMaterial`
 *   · `QZONE_CONFIRM_TTL_MS`  —— bridge 的确认闸常量
 * 所以把纯函数留在这里，调度器本体（含 _askQzoneConfirm 预览链路）整份删除。
 *
 * ⚠️ 这里**没有**任何定时器、没有任何发说说的入口 —— 发说说只有 ownLife 一条路。
 */

import crypto from 'node:crypto'
import { currentSlot, dayKey } from '../memory/dayPlan.js'
import { roomScene, roomForActivity } from '../memory/home.js'
import { wearingFor, hairFor } from '../memory/wearing.js'
import { outingOutfitForDay } from '../memory/wardrobe.js'

/** 等他确认的最长时间。与 bridge._handle 里那道闸共用同一个常量，避免两边漂移。 */
export const QZONE_CONFIRM_TTL_MS = 30 * 60_000

/**
 * 说说文案（2026-11-11 GPT 定稿口径）：
 *   一个独居成年女生，随手记录今天碰到的小事；生活感优先，不营业、不卖萌。
 *   三种结构，感受句**可选**：
 *     · 事实型：<具体事件>，<细节>
 *     · 吐槽型：<具体事件>，<即时吐槽>（只在事件确实带来麻烦时）
 *     · 感受型：<具体事件>，<自然感受>（只在有真实感受时）
 * 不新增事实：只会拼接 fact 本身 + 固定的短尾巴。
 */
export function qzoneTextFromFact(fact, plan = {}) {
  const t = String(fact ?? '').replace(/[。；\s]+$/g, '').trim()
  if (!t) return ''
  /*
   * 表达层（2026-11-11 最终口径）：从事实里挑一个"值得说"的点，按六类表达选一句；
   * 没有合适的就**只留事实**（不硬加第二句）。不新增事实，只加态度。
   */
  const TYPES = [
    ['惊喜', /(意外|居然|没想到|竟然|漂亮|好看|正好)/, ['还挺意外的', '没想到这么好看', '有点小惊喜']],
    ['得意', /(收拾干净|整理好|找到了|搭得还不错|没白|干净了|清空了)/, ['还有点小得意', '自己看着都顺眼', '这波不亏', '总算有点成就感']],
    ['纠结', /(想[^，。]{0,6}又|纠结|舍不得|不知道[^，。]{0,6}还是|拿不定)/, ['想放着又觉得该弄完', '有点拿不定主意', '舍不得下口']],
    ['吐槽', /(洗锅|洗碗|烦|麻烦|差点|又是|买错|翻车|折腾|谁发明|不想动|影响[^，。]{0,4}积极)/, ['真不知道谁想出来的', '下次一定不折腾', '这步骤真的很劝退', '有点烦']],
    ['满足', /(好吃|好喝|挺香|舒服|满意|挺好)/, ['挺满足的', '心里舒服多了', '这样挺好']],
    ['感慨', /(没干|发呆|什么正事|不跟自己较劲|浪费时间|明天再说)/, ['好像也没觉得浪费时间', '今天就这样吧', '不跟自己较劲了']],
  ]
  const hashOf = (s) => {
    let h = 0
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
    return h
  }
  const hits = TYPES.filter(([, re]) => re.test(t))
  if (!hits.length) return t            /* 事实本身够好，直接结束 */
  const [, , pool] = hits[hashOf(t) % hits.length]   /* 多条线索时按内容轮换，别总同一类 */
  return `${t}，${pool[hashOf(t) % pool.length]}`
}

const QZONE_BANNED = /(你|您|#|@|空间|说说|图|拍|治愈|元气|小确幸|奔赴|仿佛|人生|感悟|愿你|值得拥有|加油|[！!～~])/
/**
 * 发布前 6 项检查（2026-11-11 GPT 定稿）。任一失败 → 重新生成一次；仍失败放弃当天。
 * @returns {{ok:boolean, reasons:string[]}}
 */
export function checkQzoneText(text, fact, opts = {}) {
  const s = String(text ?? '').trim()
  const f = String(fact ?? '').replace(/[。；\s]+$/g, '').trim()
  const reasons = []
  if (!opts.basisOk && (!s || !f || !s.startsWith(f.slice(0, Math.min(6, f.length))))) reasons.push('没有事实依据')
  if (/[；;]/.test(s)) reasons.push('不止一件事')
  if (QZONE_BANNED.test(s)) reasons.push('含内部词/第二人称/标签/营业腔')
  if (s.split('\n').length > 2) reasons.push('超过两行')
  if (s.replace(/\s/g, '').length > 60) reasons.push('超过 60 字')
  return { ok: reasons.length === 0, reasons }
}

/** 长期内容倾向（2026-11-11 用户口径，不是每日配额）：自拍45% 穿搭25% 食物物品20% 天气10% */
export const CONTENT_RATIO = { selfie: 0.35, outfit: 0.35, scene: 0.20, weather: 0.10 }

/** 选今天发哪一类：按"欠得最多"挑（拿 state.typeCounts 累计） */
export function pickContentType(state = {}, available = ['selfie', 'outfit', 'scene', 'weather']) {
  const counts = state?.typeCounts ?? {}
  const total = available.reduce((n, k) => n + Number(counts[k] ?? 0), 0)
  let best = available[0]
  let bestDef = -Infinity
  for (const k of available) {
    const def = Number(CONTENT_RATIO[k] ?? 0) - (total ? Number(counts[k] ?? 0) / total : 0)
    if (def > bestDef) { bestDef = def; best = k }
  }
  return best
}

const cleanLine = (s) => String(s ?? '').replace(/[（(][^）)]*[）)]/g, ' ').replace(/\s+/g, ' ').trim()
const roomHash = (s) => {
  let h = 0
  for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) >>> 0
  return h
}
/**
 * 一张图只画**一个动作**（2026-11-11 用户："图二是洗锅吗，为什么锅里有面"）。
 * 事实里常有"煮了碗面，洗锅有点烦"两个动作，取其中一个：优先收尾类（洗/擦/晾/收/整理）。
 */
const focusAction = (fact) => {
  const parts = String(fact ?? '').split(/[，。；]/).map((s) => s.trim()).filter(Boolean)
  const tailAction = parts.find((p) => /(洗锅|洗碗|洗菜|刷|擦|收拾|整理|叠|晾|收)/.test(p))
  return tailAction || parts[0] || String(fact ?? '')
}

/**
 * 按内容类型组装一条说说 + 配图动机。
 * 事实依据：selfie←发型/居家状态，outfit←当天穿搭，weather←天气，scene←今天做过的小事。
 * 不新增事实：文案只表达"这一天本来就这样"的观察/情绪。
 */
export function composeContent(type, plan = {}, material = {}) {
  const hair = cleanLine(plan?.hair)
  const outfit = cleanLine(plan?.outfit)
  const weather = cleanLine(plan?.weather)
  if (type === 'selfie') {
    if (!hair) return null
    const text = /乱|没梳|随/.test(hair)
      ? '今天的发型比较随缘，反正也不出门'
      : '头发今天还算听话，随手拍一张'
    /* 2026-11-12：自拍改走卧室/玄关对镜（前置手持自拍手机总入画） */
    const rooms = ['bedroom', 'entry']
    const room = rooms[roomHash(hair + outfit) % rooms.length]
    return { type, text, basis: hair, mode: 'mirror_selfie', forceFraming: '半身', subjectMode: 'person', outfit: (/(马尾|扎起|扎成|丸子头)/.test(hair) ? '蓝色发圈（低马尾），' : '') + outfit, scene: `镜子自拍：**${roomScene(room)}**；室内家里、不是户外街景；**发型：${cleanLine(hair)}**${/(马尾|扎起|扎成|丸子头)/.test(hair) ? '（戴蓝色发圈）' : ''}（写马尾/扎起就必须把头发束在脑后，不能披散）；穿今天这身家居服；**半身（头到腰）**，对镜自拍，镜中可见手机；自然光` }
  }
  if (type === 'outfit') {
    if (!outfit) return null
    /* 穿搭帖用**外出服**（2026-11-12）：橱窗/街拍 look，不是家居服 */
    const outfitOut = cleanLine(outingOutfitForDay(dayKey())) || outfit
    /*
     * 穿搭三种可自拍角度（2026-11-12 用户：按小红书看过的角度试）：
     *   0 对镜全身 / 1 对镜半身（配饰细节）/ 2 俯拍鞋袜局部（纯物、无人）
     * 明确排除：街拍、他拍、回头抓拍 —— 她自己拍不出来。
     */
    const variant = roomHash(outfitOut) % 3
    const short = outfitOut.replace(/\*\*/g, '').split('，').slice(0, 4).join('，')
    const rooms = ['bedroom', 'entry']
    /* 2026-11-12：穿户外鞋的穿搭照放玄关（换鞋处），卧室容易生成拖鞋 */
    const __shoesOut = /(靴|乐福鞋|小皮鞋|运动鞋|帆布鞋)/.test(outfitOut)
    const room = __shoesOut ? 'entry' : rooms[roomHash(outfitOut) % rooms.length]
    if (variant === 1) {
      return { type, text: `今天这身的主角在上半身：${short}。这样搭还行吧？`, basis: outfitOut, mode: 'mirror_selfie', subjectMode: 'person', forceFraming: '半身', scene: `镜子自拍：**${roomScene(room)}**；室内家里；站在镜子前拍今天的穿搭，**半身（到头胸/腰上）**，突出上衣、围巾/领口和发饰，镜中可见手机` }
    }
    if (variant === 2) {
      /* 2026-11-12：鞋部特写必须用当天真实的鞋+下装，不能让模型自由发挥 */
      const shoe = (outfitOut.match(/(黑色乐福鞋|乐福鞋|短靴|长靴|帆布鞋|小皮鞋|运动鞋)/) || [])[0] || '今天的鞋'
      const bottom = (outfitOut.match(/([^，]*?(百褶中长裙|百褶裙|半身裙|长裤|阔腿裤|短裙)[^，]*)/) || [])[1] || ''
      const bottomTxt = bottom ? `和**${bottom.replace(/\*\*/g, '')}的下摆**` : ''
      return { type, text: '今天这双配这身，在外面走了一天。', basis: outfitOut, mode: 'rear_selfie', sceneOnly: true, subjectMode: 'object', scene: `低头俯拍脚部：**只拍${shoe}${bottomTxt}、白棉袜口和地板**（视角从她眼睛往下 30–45°）；画面里**不得出现腿、皮肤、手、身体、头发**，只拍鞋、袜口、衣摆和地面；地点是玄关/门口木地板+门垫，自然光` }
    }
    return { type, text: `今天出门这身：${short}。本鲸在镜子前确认了三遍才出门。`, basis: outfitOut, mode: 'mirror_selfie', subjectMode: 'person', forceFraming: '全身', scene: `镜子自拍：**${roomScene(room)}**；室内家里；站在镜子前拍**全身穿搭**（头顶到鞋），镜中可见手机；背景干净、不出现杂乱家具` }
  }
  if (type === 'outing') {
    const out = cleanLine(plan?.outing)
    if (!out) return null
    const tail = /风/.test(cleanLine(plan?.weather)) ? '，路上风有点凉' : ''
    return {
      type: 'outing', text: `${out}${tail}`, basis: out,
      /* 2026-11-12 用户：商店没有全身镜，出门帖直接拍物品，不硬画人 */
      mode: 'rear_selfie', sceneOnly: true, subjectMode: 'object',
      scene: `${out}；**像拍物品一样拍与出门目的相关的东西**（药店柜台/货架上的药盒、购物袋、货架物品），画面里**只有物品和台面/货架，不要出现手、人、身体、脸**；自然光，真实随手拍`,
    }
  }
  if (type === 'weather') {
    if (!weather) return null
    const text = /风/.test(weather) ? '外面有点风，窗户缝里钻进来一股凉气' : '天阴着，屋里的光线也暗了一档'
    const room = roomForActivity(weather) || 'living'
    return { type, text, basis: weather, mode: 'rear_selfie', sceneOnly: true, subjectMode: 'environment', scene: '窗外的天气：**只拍窗户和窗台**（窗框、窗帘、窗外天空/街景/树叶），**不要拍室内家具、沙发、桌子或整间屋子**' }
  }
  /* scene：食物/物品/生活小事 */
  const fact = factOfForContent(plan, material)
  if (!fact) return null
  const room = roomForActivity(fact)
  const focus = focusAction(fact)
  /*
   * 洗刷类不画"手伸进锅里"（模型反复把机位/站位画错）：
   * 改成**后置拍物**——只拍水槽里泡着的锅+刷子，画面里没有人也没有手（2026-11-11 用户口径）。
   */
  if (/(洗锅|洗碗|洗菜)/.test(focus)) {
    return {
      type: 'scene', text: qzoneTextFromFact(fact, plan), basis: fact, mode: 'rear_selfie',
      sceneOnly: true,
      subjectMode: 'object',
      scene: `${focus}；**后置拍物，正面平拍**：${roomScene(room) || roomScene('kitchen')}；手机在她身前、**镜头与水池台面平行（水平正对水槽）**，**不要俯拍、不要斜拍**；锅里泡着水，旁边放着刷子和洗洁精；画面里**不要出现手、不要出现任何人**，只拍锅和台面`,
    }
  }
  /* 2026-11-12 用户：像拍中午饭那张一样，直接判成拍物，别硬画手 */
  return {
    type: 'scene', text: qzoneTextFromFact(fact, plan), basis: fact,
    mode: 'rear_selfie', sceneOnly: true, subjectMode: 'object',
    scene: `${focus}；**像拍饭菜一样俯拍桌面/台面**：${roomScene(room) || roomScene('living')}；只拍这件事相关的物品和台面，构图干净；**画面里只出现这一件事涉及的单个物品（例如一只玻璃杯），不要复制成一排/一堆同类物品，不要画晾衣架上的多只杯子**；画面里**不要出现手、人、身体、脸**；自然光，真实家庭环境`,
  }
}

/** scene 类事实：smallThing > 已完成时段里的一句话 */
export function hasContentPoint(fact = '') {
  const t = cleanLine(fact)
  if (!t) return false
  /*
   * 2026-11-11 用户：「这些内容都没有什么看点」。
   * 纯家务/日常流程（刷肥皂盒、喝温水、翻促销单）不算素材；
   * 要有反差、意外、情绪或具体生活质感才值得发。
   */
  return /(居然|竟然|没想到|结果|差点|本来|终于|第一次|发现|捡到|打折|便宜|抢到|忘|弄错|糊了|洒了|碎了|掉了|漏了|停水|下雨|刮风|风大|冷|热|香|好吃|好看|翻车|尴尬|好笑|气人|烦|惊喜|意外|好玩|真巧|顺手|省了|剩了|多出|奇怪|偏偏|硬是|救命|笑死)/.test(t)
}

function factOfForContent(plan = {}, material = {}) {
  const st = cleanLine(plan?.smallThing)
  if (st) return st
  const done = material?.done ?? []
  for (const d of done) {
    for (const c of String(d).split(/[；。]/)) {
      const s = c.trim()
      if (s.length >= 8 && s.length <= 60) return s
    }
  }
  return ''
}

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16)

const memOf = (bridge, scope) => {
  try { return bridge.memory?.get?.(scope) ?? null } catch { return null }
}

/** 当日已完成时段（不含当前与未来） */
function completedSlots(plan, slotId) {
  const order = ['morning', 'noon', 'afternoon', 'evening']
  const cur = Math.max(-1, order.indexOf(String(slotId ?? '')))
  return order.slice(0, cur).reverse()
    .map((k) => String(plan?.[k] ?? '').trim())
    .filter(Boolean)
}

/**
 * 这条素材**能不能公开**（2026-11-10，v2 收窄）。
 *
 * `memory-events.json` 里混着开发/私域内容，例如实际条目：
 *   「Null_zwei 在完善拍照系统，正和 GPT 一起跑测试」
 * 而说说是**公开**的 —— 这类不能当素材。
 *
 * ## 为什么不用"命中一个词就丢"
 * 用户口径：普通生活内容里偶然提到「测试」「API」不该整条丢掉
 * （例：「测试一下新买的咖啡机」）。
 * 所以只有下面三种情况才判不安全：
 *   ① 出现真实姓名 / 本机路径等**敏感线索**（一律挡）
 *   ② 出现**强开发词**（仓库/部署/报错/登录态/GPT/LLM/bug…）
 *   ③ **开发动词紧邻开发名词**（「跑测试」「改代码」「调接口」）或 ≥2 个弱信号
 * 单个弱词（代码/测试/模型/API/接口/服务器/配置）单独出现 → 放行。
 *
 * @param {string} text
 * @returns {boolean}
 */
const PRIVATE_HINT = /(Null_zwei|本机|用户目录|whale-pod|[A-Za-z]:[\\/])/i
const DEV_STRONG = /(调度器|重启|仓库|部署|守护进程|日志|报错|提交|分支|工作区|显存|权重|\bprompt\b|\btoken\b|DeepSeek|GPT|LLM|\bbug\b|debug|\bgit\b|\bnpm\b|package\.json|端口|回滚|合并冲突|环境变量)/i
const DEV_WEAK = /(代码|测试|模型|API|接口|服务器|重构|编译|配置)/gi
/** 开发动词 + 开发名词（中间最多 6 个字）：跑测试 / 改代码 / 调接口 / 写配置 */
const DEV_PHRASE = /(改|修|写|跑|调|测|部署|重启|提交|合并|回滚|排查)[^。！？\n]{0,6}(代码|测试|模型|API|接口|配置|环境|脚本|分支|日志)/i

/** 把**人名/本机痕迹**替换掉（不是整条丢）。说说是公开的，绝不能带真实姓名/路径。 */
export function scrubMaterialText(text) {
  return String(text ?? '')
    .replace(/Null_zwei/gi, '他')
    .replace(/whale-pod/gi, '家里')
    .replace(/[A-Za-z]:[\\/][^\s，。；、]*/g, '')   // 盘符路径整段去掉
    .replace(/\s+/g, ' ')
    .trim()
}

export function isPublicSafeMaterial(text) {
  const s = String(text ?? '').trim()
  if (!s) return false
  if (PRIVATE_HINT.test(s)) return false        // ① 敏感线索
  if (DEV_STRONG.test(s)) return false          // ② 强开发词
  if (DEV_PHRASE.test(s)) return false          // ③ 开发短语
  const weak = s.match(DEV_WEAK) ?? []
  return weak.length < 2                        // 单个弱词放行，≥2 个才当开发记录
}
