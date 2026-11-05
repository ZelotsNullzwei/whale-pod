/**
 * 生活事件 → 拍照动机（photo-planner）
 *
 * 用户特别强调的两条（v2.0 建议 1、2）：
 *   ① **不写死每天拍几张** —— 没有值得分享的内容就不拍；
 *   ② **不追求每张露脸** —— 有脸的自拍、背影、手部特写、桌面、全身，都要有。
 *
 * 这个模块只做一件事：看她写的场景 + 当前时段/日程，判断
 *   · 要不要拍（大多数情况拍，因为她主动写标记 = 她想发图）
 *   · 用哪种拍摄模式（六种之一）
 *   · 主体是什么、脸露不露
 * 它**不生成提示词**，那是 photo-composer 的事。
 */

import { MODES } from './photo-modes.js'

/**
 * 关键词 → 优先模式。
 * 顺序重要：先匹配更具体的（视频通话 → 镜子 → 前置 → 第一人称）。
 */
const HINTS = [
  // 镜子：必须真有镜子
  { re: /(镜子|照镜子|穿衣镜|镜前|对着镜子|镜子里|对镜自拍)/, mode: 'mirror_selfie' },
  // 视频通话（排在前面：通话场景常写"架在桌上"，容易被其它规则抢走）
  { re: /(视频|通话|语音里|看着屏幕|视频聊天|视频里)/, mode: 'video_call' },
  /*
   * ★ 支架/定时拍（2026-11-05）：必须排在自拍**前面** ——
   *   实测「手机架在茶几上」被 front_selfie 抢走，判成了自拍。
   */
  { re: /(架在|架着|支架|三脚架|立在|靠着|定时拍|定时拍摄|放桌上拍|摆好手机)/, mode: 'timer_shot' },
  /*
   * ★ 躺着/刚睡醒 → 自拍（2026-11-05）：
   *   补「低头摆弄东西」规则时误伤了这一档 —— 「刚睡醒赖在床上」被判成第一人称。
   *   躺在床上/赖床/刚醒这种，她想让人看看自己，就是自拍。
   */
  /*
   * ★ 露脸优先走镜子（2026-11-05 用户口径）：
   *   「要露脸可以通过镜子，大镜子小镜子都可以，女孩子有镜子很正常」。
   *   前置自拍会让模型画出两条自拍臂 + 多手；对镜自拍只有一只拿手机的手。
   */
  { re: /(躺在床上|赖在床上|赖床|刚睡醒|刚醒|还躺着|窝在床上|趴着)/, mode: 'mirror_selfie', subject: '刚醒来的样子' },
  // 自拍 / 前置
  { re: /(自拍|前置|举着手机|镜头对着自己|看镜头|正脸|脸对镜头)/, mode: 'front_selfie' },
  // 第一人称（俯拍、只有手、桌面、食物）
  { re: /(俯拍|第一人称|手上|手里|桌面|碗里|锅里|台面|脚下|视线里|眼前)/, mode: 'first_person' },
  /*
   * ★ 「低头看东西」= 第一人称（2026-11-05）：
   *   实测「坐在床边看漫画」被判成前置自拍 → 提示词写"镜头朝自己" → 画成第三人称全身照。
   *   看书/看漫画/看手机/翻页这类，视线落在手里的东西上，本来就该是第一人称。
   */
  { re: /(看漫画|看书|翻书|翻页|翻着|低头看|看着书|手上的书|手里的书|刷手机|看手机|翻手机)/, mode: 'first_person' },
  /*
   * ★ 「低头摆弄东西」也是第一人称（2026-11-05）：
   *   实测「坐在书桌前把抽屉里的笔挑出来扔掉」被判成前置自拍 → 多手。
   *   挑笔/整理/收拾/翻找/擦拭这类，视线落在手上的东西，本来就该第一人称。
   */
  { re: /(挑出来|挑笔|翻找|整理|收拾|擦拭|擦桌|摆弄|抽屉|收纳|归类|叠好|码好)/, mode: 'first_person' },
  // 拍某个东西（后置）
  { re: /(拍下|拍张照|拍一张|拍给你看|记录一下|给你看这个)/, mode: 'rear_selfie' },
]

/**
 * 时段 → 默认模式倾向（只是倾向，场景关键词优先）。
 * 例：早上刚起容易自拍；做饭/收拾容易第一人称；睡前容易第一人称。
 */
const SLOT_BIAS = {
  wake: ['front_selfie', 'first_person'],
  morning: ['first_person', 'front_selfie'],
  noon: ['first_person', 'front_selfie'],
  afternoon: ['first_person', 'timer_shot', 'front_selfie'],
  evening: ['first_person', 'timer_shot', 'front_selfie'],
  night: ['first_person', 'front_selfie'],
}

/** 动作词 → 更合适的主体/模式微调 */
const ACTIVITY_BIAS = [
  { re: /(做饭|煮|炒|洗碗|洗锅|切菜|蒸|熬)/, mode: 'first_person', subject: '手上正在做的事' },
  { re: /(晾衣|收衣|叠衣|洗袜|打扫|擦|整理|收拾)/, mode: 'first_person', subject: '正在收拾的手边' },
  { re: /(沙发|躺|窝在|靠枕|看剧|看漫画|听歌)/, mode: 'front_selfie', subject: '窝在沙发上的自己' },
  { re: /(穿搭|新衣服|新发饰|发型|头饰|试衣)/, mode: 'mirror_selfie', subject: '今天的穿搭' },
  /*
   * 背影/背对：她自己拍不到自己的背影（前摄拍不到、后摄要举到身后）——
   * 又没有支架可用，所以这个构图本来就不成立。改成第一人称（不拍自己背后）。
   */
  { re: /(背影|后脑|背对)/, mode: 'first_person', subject: '眼前的东西' },
  { re: /(窗|阳台|外面|楼下|天)/, mode: 'rear_selfie', subject: '窗外/阳台的样子' },
]

/**
 * 规划一次拍摄。
 *
 * @param {object} o
 * @param {string} o.scene      她写的场景原话（`[画图:…]` 的内容）
 * @param {string} [o.slot]     当前时段 id（wake/morning/noon/afternoon/evening/night）
 * @param {boolean} [o.sceneOnly] 是不是 `[场景图:]`（纯场景，画面里没有人）
 * @param {boolean} [o.anime]    是不是插画档
 * @returns {{
 *   mode: string, modeLabel: string, shooter: string, device: string,
 *   camera: string, look: string, framing: string[], rules: string[],
 *   subject: string, faceVisible: boolean, needsCharacterRef: boolean,
 *   skip: boolean, reason: string,
 * }}
 */
export function planPhoto({ scene = '', slot = 'afternoon', sceneOnly = false, anime = false } = {}) {
  const text = String(scene)

  /* 纯场景图（`[场景图:]`）没有人物，直接按"后置拍物"处理 */
  if (sceneOnly) {
    return build('rear_selfie', {
      subject: '眼前的场景',
      faceVisible: false,
      needsCharacterRef: false,
      skip: false,
      reason: '场景图：只拍环境，画面里没有人',
    })
  }

  /* ① 关键词优先 */
  let mode = ''
  for (const h of HINTS) {
    if (h.re.test(text)) { mode = h.mode; break }
  }

  /* ② 动作微调（比时段更具体） */
  let subject = ''
  for (const a of ACTIVITY_BIAS) {
    if (a.re.test(text)) {
      if (!mode) mode = a.mode
      subject = a.subject
      break
    }
  }

  /* ③ 时段兜底 */
  if (!mode) {
    const bias = SLOT_BIAS[slot] ?? SLOT_BIAS.afternoon
    mode = bias[0]
  }

  /* 插画档：不受物理限制（二次元本来就是画的），但仍用模式来决定构图 */
  const plan = build(mode, { subject, reason: pickReason(mode, text) })
  if (anime) {
    plan.rules = plan.rules.filter((r) => !/不能凭空|不能出现第二|不要出现"第三方/.test(r))
  }
  return plan
}

function build(modeId, patch = {}) {
  const m = MODES[modeId] ?? MODES.front_selfie
  const faceVisible = patch.faceVisible !== undefined
    ? patch.faceVisible
    : (m.id === 'front_selfie' || m.id === 'mirror_selfie')
  return {
    mode: m.id,
    modeLabel: m.label,
    shooter: m.shooter,
    device: m.device,
    camera: m.camera,
    look: m.look,
    framing: m.framing,
    rules: m.rules,
    needs: m.needs,
    subject: patch.subject || '她自己',
    faceVisible,
    needsCharacterRef: patch.needsCharacterRef !== undefined
      ? patch.needsCharacterRef
      : (m.id !== 'first_person' && m.id !== 'rear_selfie'),
    skip: Boolean(patch.skip),
    reason: patch.reason || '',
  }
}

function pickReason(mode, text) {
  if (mode === 'front_selfie') return '想让他看看自己现在的样子'
  if (mode === 'mirror_selfie') return '想记录今天穿的这一身'
  if (mode === 'first_person') return '眼前的东西值得拍一张'
  if (mode === 'rear_selfie') return '想把眼前看到的东西发给他'
  if (mode === 'video_call') return '正在和他视频'
  return String(text).slice(0, 20)
}

/**
 * 判断"这一轮该不该拍照"。
 *
 * 用户要求：**没有值得分享的内容时可以不拍照**，不要为了完成任务机械拍摄。
 * 她主动输出了 `[画图:]` 标记 → 说明她想拍，一般不拦。
 * 只有明显"没什么可拍"的场景才劝退（比如纯文字闲聊、重复的同一件事）。
 *
 * @param {object} o
 * @param {string} o.scene
 * @param {string} [o.lastScene] 上一张图用的场景（判断重复）
 * @returns {{skip:boolean, reason:string}}
 */
export function shouldSkipPhoto({ scene = '', lastScene = '' } = {}) {
  const s = String(scene).trim()
  if (s.length < 4) return { skip: true, reason: '场景描述太短，没什么可拍' }
  if (lastScene && s === String(lastScene).trim()) {
    return { skip: true, reason: '和上一张图是同一个场景，重复了' }
  }
  return { skip: false, reason: '' }
}
