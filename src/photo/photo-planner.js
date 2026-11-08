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
  /*
   * ★ 怼脸 / 面部特写排**最前**（2026-11-06 实测）：
   *   原来这种场景会被后面的"第一人称"规则抢走，画成局部特写而不是脸。
   */
  { re: /(怼脸|面部特写|脸的特写|特写.*脸|脸贴镜头|镜头贴脸|只拍脸)/, mode: 'face_closeup' },
  // 镜子：必须真有镜子
  { re: /(镜子|照镜子|穿衣镜|镜前|对着镜子|镜子里|对镜自拍)/, mode: 'mirror_selfie' },
  // 视频通话（排在前面：通话场景常写"架在桌上"，容易被其它规则抢走）
  { re: /(视频|通话|语音里|看着屏幕|视频聊天|视频里)/, mode: 'video_call' },
  /*
   * ★ 视频通话（2026-11-05）：必须排在自拍**前面** ——
   *   实测「手机架在桌上视频通话」被 front_selfie 抢走，判成了自拍。
   */
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
  /*
   * ★ 镜子**不是所有自拍都用**（2026-11-05 用户口径）：
   *   「只是在合适的场景才用」—— 看穿搭/看全身/看发型这类需要展示整体的才用镜子；
   *   赖床、刚睡醒这种，前置自拍就够（手机举起来就能拍）。
   */
  { re: /(躺在床上|赖在床上|赖床|刚睡醒|刚醒|还躺着|窝在床上|趴着)/, mode: 'front_selfie' },
  // 自拍 / 前置
  { re: /(自拍|前置|举着手机|镜头对着自己|看镜头|正脸|脸对镜头)/, mode: 'front_selfie' },
  /*
   * ★★ **构图词压过动作词**（2026-11-08，小红书参考）。
   *
   * 小红书那种「站在便利店里，手里拿着一瓶饮料，拍张全身」——
   * 原规则被下面的  抢成第一人称，出图就只有一只手和一瓶饮料（实测）。
   * 只要出现「全身 / 半身 / 站在」这类**构图词**，一律按人像处理。
   * ⚠️ 必须排在 mirror 之后（“站在镜子前”仍走对镜）。
   */
  { re: /(全身|半身|三分之二身|站着|站在)/, mode: 'front_selfie' },
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
   *
   * ★★ **但"整理自己的衣服/头发"例外**（2026-11-06 实测踩到）。
   *
   * 现场：
   * ```
   * 15:45:47 画图「穿着短款女仆装站在房间里，裙摆很短，
   *              侧身低头整理裙边，床靠着墙，窗边有绿萝…」
   *          拍摄方案 → 第一人称记录｜局部
   * 结果：一张吃面的图 —— 手、碗、筷子、白裤子，**她本人只露半个后脑**
   * ```
   * 「低头整理裙边」是在**整理她自己身上的东西**，主体就是她，
   * 该拍她本人（对镜/前置自拍）；而这条规则把它当成了"低头收拾房间"。
   *
   * 判据：**宾语是她自己身上的东西**（裙/衣/头发/袖/领口/围裙/袜子/鞋）
   * 时，这条**不生效**（交给后面的规则判成自拍）。
   */
  {
    re: /(挑出来|挑笔|翻找|整理|收拾|擦拭|擦桌|摆弄|抽屉|收纳|归类|叠好|码好)/,
    mode: 'first_person',
    /*
     * `notNear`：命中词**前后 6 个字**里出现这些词 → 这条不算。
     * 「整理**裙边**」「整理**头发**」都是她自己，不是收拾屋子。
     * ⚠️ 必须前后都看：「整理裙边」里"裙"在命中词**后面**（只看前面会漏）。
     */
    notNear: /(裙|衣|发|袖|领|围裙|袜|鞋|头饰|刘海|衣角|裙摆|肩带|吊带)/,
  },
  /*
   * ★ 看穿搭/新衣服 → 镜子自拍（2026-11-05）：
   *   这条必须排在「拍给你看/记录一下」前面，否则会被后置拍物抢走。
   */
  { re: /(新买|新入手|新衣服|这身|这一身|穿搭|试衣|穿上看看|好不好看)/, mode: 'mirror_selfie' },
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
  afternoon: ['first_person', 'front_selfie'],
  evening: ['first_person', 'front_selfie'],
  night: ['first_person', 'front_selfie'],
}

/** 动作词 → 更合适的主体/模式微调 */
const ACTIVITY_BIAS = [
  { re: /(做饭|煮|炒|洗碗|洗锅|切菜|蒸|熬)/, mode: 'first_person', subject: '手上正在做的事' },
  /*
   * ★ **"整理/收拾"的对象是她自己身上的东西时，不归这条**（2026-11-06）。
   *
   * 现场：`穿着短款女仆装…侧身低头**整理裙边**…`
   *   → 命中"整理" → first_person → 画成一张吃面的图（只露半个后脑）。
   * 整理裙边/头发/领口是**在整理她自己**，主体就是她，该拍人。
   * `notNear` 命中 → 这条不算（前后各 6 字都看，见 planPhoto）。
   */
  {
    re: /(晾衣|收衣|叠衣|洗袜|打扫|擦|整理|收拾)/,
    mode: 'first_person',
    subject: '正在收拾的手边',
    notNear: /(裙|衣|发|袖|领|围裙|袜|鞋|头饰|刘海|衣角|裙摆|肩带|吊带)/,
  },
  { re: /(沙发|躺|窝在|靠枕|看剧|看漫画|听歌)/, mode: 'front_selfie', subject: '窝在沙发上的自己' },
  { re: /(穿搭|新衣服|新发饰|发型|头饰|试衣)/, mode: 'mirror_selfie', subject: '今天的穿搭' },
  /*
   * 背影/背对：这是**拍她自己**（不是拍眼前的东西）。
   *
   * 之前把它错映射成 first_person（镜头≈她的眼睛，画面里没有她），
   * 结果"只露出一点侧后方的背"被画成一个跟她无关的房间。
   * 她一个人拍不到自己后脑 → 用**镜子自拍**（能看到自己背面），
   * 没镜子就退成前置自拍（露正脸，也是"看看样子"）。
   */
  { re: /(背影|后脑|背对|背对镜头|侧后方)/, mode: 'mirror_selfie', subject: '镜子里的自己' },
  /*
   * ★ 「窗」只有**真的在拍窗外**才算（2026-11-06 实测踩到）。
   *
   * 现场：`穿着短款女仆装站在房间里…床靠着墙，**窗边有绿萝**，屋里…`
   *   → 命中「窗」→ rear_selfie（拍窗外）→ 但这是**房间背景**，要拍的是她。
   *
   * 判据：命中「窗」但**前后有"边/旁/台/帘/外有/绿植"这类"位置描述"**时，
   * 说明窗只是背景道具，不是拍摄对象 → 这条不算。
   */
  {
    re: /(窗|阳台|外面|楼下|天)/,
    mode: 'rear_selfie',
    subject: '窗外/阳台的样子',
    notNear: /(窗边|窗台|窗帘|窗旁|阳台边|窗外有|楼下有|天有)/,
  },
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
    const m = h.re.exec(text)
    if (!m) continue
    /*
     * `notNear`：命中词**前后 6 个字**里出现它 → 这条不算（2026-11-06）。
     * 例：「低头整理**裙边**」——"整理"通常判第一人称，但宾语是她自己的裙子
     * （在她自己的衣服上），主体就是她，该拍人。
     * ⚠️ 必须**前后都看**：「整理裙边」里"裙"在命中词**后面**，
     *    只看前面会漏（第一版就漏了，实测仍判成 first_person）。
     * ⚠️⚠️ 键名必须和表里一致（`notNear`）—— 这里曾写成 `h.notBefore`，
     *    而表里写的是 `notNear`，于是排除逻辑**从来没执行过**（2026-11-06 实测）。
     */
    if (h.notNear) {
      const near = text.slice(Math.max(0, m.index - 6), m.index + m[0].length + 6)
      if (h.notNear.test(near)) continue
    }
    mode = h.mode
    break
  }

  /* ② 动作微调（比时段更具体） */
  let subject = ''
  for (const a of ACTIVITY_BIAS) {
    const m = a.re.exec(text)
    if (!m) continue
    /*
     * `notNear`：命中词**前后 6 字**里有它 → 这条不算（2026-11-06）。
     * 「整理**裙边**」「整理**头发**」是在整理她自己，不该判第一人称。
     */
    if (a.notNear) {
      const near = text.slice(Math.max(0, m.index - 6), m.index + m[0].length + 6)
      if (a.notNear.test(near)) continue
    }
    if (!mode) mode = a.mode
    subject = a.subject
    break
  }

  /* ③ 时段兜底 */
  if (!mode) {
    /*
     * ★★ **兜底前先看"是不是在拍人"**（2026-11-06 实测踩到）。
     *
     * 现场：`穿着短款女仆装站在房间里…侧身低头整理裙边…`
     *   两个关键词表都因为"整理/窗"被排除而不命中 →
     *   落到 `SLOT_BIAS.afternoon = ['first_person', …]` →
     *   画成一张吃面的图（只有手和碗），**她本人只露半个后脑**。
     *
     * 判据：描述里有**穿着 / 衣服 / 站在 / 坐着 / 她**这类"主体是她"的词，
     * 就不该用"拍眼前的东西"兜底 —— 改成拍人（对镜自拍最稳：能全身、
     * 又有镜子这个合理的自拍理由）。
     */
    /*
     * ⚠️ 词表要**包含衣物本身**（裙摆/领口/袖口…），不能只有"穿着/衣服"——
     *    「低头整理裙摆」里一个"穿着/衣服"都没有，只有"裙摆"，
     *    第一版就漏了这一档（实测仍判成 first_person）。
     */
    const aboutHer = /(穿着|穿上|衣服|裙子|裙摆|裙边|领口|袖口|围裙|肩带|吊带|女仆装|睡衣|家居服|站在|坐在|坐着|躺|蹲|她|自己|身|妆|头发|发饰|头饰)/.test(text)
    const bias = SLOT_BIAS[slot] ?? SLOT_BIAS.afternoon
    mode = aboutHer ? 'mirror_selfie' : bias[0]
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
  /*
   * ⚠️ **不要因为"暗/在床上/只露一点"就不拍**（2026-11-05 用户驳回）。
   * 关灯躺在床上举着手机自拍是很正常的场景，拦掉反而错。
   * 那张"雷霆图"的真因是**判成了第一人称（不带参考图）** → 画了个空房间，
   * 已经由 photo-modes 的"拍自己必须带参考图"修掉了，不在这里拦。
   */
  return { skip: false, reason: '' }
}
