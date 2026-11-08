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
  { re: /(镜子|照镜子|穿衣镜|镜前|对着镜子|镜子里|对镜)/, mode: 'mirror_selfie' },
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

/**
 * ★★ V3.0 结构化意图（2026-11-08，按 GPT 建议的"多维拆解"重写第 2 步）。
 *
 * 核心：**intent 不直接决定 prompt，也不直接决定最终 mode**。
 * 它把"她这句话"拆成 7 个互不干扰的维度，后续模块各自取需要的维度：
 *   subject(主体) / activity(动作) / framing(构图) / camera(机位) / scene(环境) /
 *   explicitRequirements(明确要求) / confidence(置信度)
 *
 * 9 条历史误判在这里被"分维度"自然消解，而不是继续堆关键词优先级：
 *   1 全身=构图，不是机位    2 整理头发=动作对象是她自己
 *   3 看漫画=动作，主体看目的 4 窗=环境背景，不是主体
 *   5 背影=独立机位          6 穿搭→镜像（可被明确要求覆盖）
 *   7 明确要求 > 时段        8 人物动作 ≠ 拍摄动作
 *   9 背景物件 ≠ 拍摄对象
 */
/* ===================== V3.0 planIntent（复核后 v2 结构） ===================== */

/* 内容线索：她在拍什么（只描述画面主体，不看机位） */
const OBJECT_CUES = [
  { re: /(拍给你看|给你看这个|拍下它|拍这个|拍一下这个|给你看看这个)/, why: "explicit_object" },
  { re: /(手里|手上的|端着的|桌上|碗里|锅里|台面上|捧着的|眼前)/, why: "nearby_object" },
  { re: /(小物件|物件|摆件|饰品|钥匙|耳机|杯子特写|细节)/, why: "small_object" },
]
const SCENE_CUES = [
  { re: /(窗外|阳台|楼下|街景|风景|日落|整个房间|屋里的一切)/, why: "scene_cue" },
]
const PERSON_CUES = [
  { re: /(穿着|穿上|衣服|裙子|裙摆|领口|袖口|全身|半身|头肩|自拍|看我|背影|妆|头发|发饰|头饰|站在|坐在|坐着|躺|蹲)/, why: "person_cue" },
]

/* 动作（可多动作，按出现顺序） */
const ACTIVITY_RULES = [
  { type: "tidying", re: /(整理|收拾|擦拭|打扫|叠|洗|挑|翻找|摆弄)/g },
  { type: "reading", re: /(看漫画|看书|翻书|翻页|刷手机|看手机)/g },
  { type: "cooking", re: /(做饭|煮|炒|洗碗|切菜|蒸|熬)/g },
  { type: "holding_item", re: /(吃|喝|端|拿着|举着|捧着)/g },
  { type: "resting", re: /(躺|窝在|靠|坐|站|蹲)/g },
]
const ACTIVITY_ABOUT_HER = /(裙|衣|发|袖|领|围裙|袜|鞋|头饰|刘海|裙摆|肩带|吊带|妆)/

/* 构图（只描述画面包含什么） */
const FRAMING_RULES = [
  { type: "face", re: /(怼脸|面部特写|只拍脸|脸贴镜头)/ },
  { type: "head_shoulder", re: /(头肩|锁骨以上)/ },
  { type: "half", re: /(半身)/ },
  { type: "full", re: /(全身|三分之二身)/ },
  { type: "part", re: /(局部|特写|手上的|手里)/ },
]

/* 明确机位要求（最高优先级） */
const EXPLICIT_CAMERA = [
  { mode: "face_closeup", device: "front_cam", position: "close", re: /(怼脸|面部特写|只拍脸|脸贴镜头)/ },
  { mode: "mirror_selfie", device: "mirror", position: "mirror_front", re: /(对镜|照镜子|穿衣镜|镜前|对着镜子|镜子里)/ },
  { mode: "first_person", device: "phone", position: "eye", re: /(第一人称|第一视角|POV|pov)/ },
  { mode: "back_view", device: "phone", position: "behind", re: /(背影|后脑|背对)/ },
  { mode: "video_call", device: "phone", position: "desk", re: /(视频通话|视频里|通话中)/ },
  { mode: "front_selfie", device: "phone", position: "arm_length", re: /(前置|自拍)/ },
  { mode: "rear_object", device: "rear_cam", position: "rear", re: /(后置|拍这块|拍它)/ },
]

/** 目的大类（少而稳；拿不准一律 null，不猜） */
function inferPurpose(text, subject, cameraMode) {
  if (cameraMode === "video_call") return "conversation"
  if (cameraMode === "face_closeup") return "show_face"
  if (/(穿搭|这身|这一身|新衣服|新买|试衣|好不好看|新发饰)/.test(text)) return "show_outfit"
  if (subject === "object") return "share_object"
  if (subject === "scene") return "share_scene"
  if (subject === "character") return "daily_moment"
  return null
}

/** 第一人称子型 */
function firstPersonSubtype(text) {
  const t = String(text)
  if (/(双手|两只手|捧|拧|撕开|掰|搓|揉)/.test(t)) return "two_hands"
  if (/(桌面|书桌|桌上|键盘|写字|笔记本|台面|砧板)/.test(t)) return "desk_work"
  if (/(窗外|房间|屋里|环境|风景)/.test(t)) return "observe"
  if (/(端着|拿着|举着|手握|喝|杯|碗|筷|勺|瓶)/.test(t)) return "handheld"
  return "object_only"
}

export function planIntent({ scene = "", slot = "afternoon", sceneOnly = false } = {}) {
  const text = String(scene)
  const diagnostics = { matchedRules: [], conflicts: [], unresolved: [] }

  if (sceneOnly) {
    return {
      subject: "scene",
      intent: { purpose: "share_scene", source: "explicit" },
      activities: [],
      framing: { type: "object", source: "explicit" },
      composition: null,
      camera: { mode: "scene_only", device: "rear_cam", position: "rear", source: "explicit" },
      scene: { location: "current", background: [] },
      explicitRequirements: [],
      constraints: ["no_person"],
      diagnostics: { matchedRules: ["sceneOnly"], conflicts: [], unresolved: [], decisionTrace: [{ field: "camera", value: "scene_only", reason: "sceneOnly_flag" }] },
      confidence: null,
    }
  }

  /* ---------- 1. activities（可多个，按出现顺序） ---------- */
  const hits = []
  for (const r of ACTIVITY_RULES) {
    const re = new RegExp(r.re.source, "g")
    let m
    while ((m = re.exec(text))) {
      const near = text.slice(Math.max(0, m.index - 6), m.index + m[0].length + 6)
      hits.push({ type: r.type, at: m.index, aboutHer: ACTIVITY_ABOUT_HER.test(near) })
    }
  }
  hits.sort((a, b) => a.at - b.at)
  const __seen = new Set()
  const activities = hits
    .filter((h) => (__seen.has(h.type) ? false : (__seen.add(h.type), true)))
    .map((h, i) => ({ type: h.type, target: null, order: i + 1 }))
  if (activities.length) diagnostics.matchedRules.push("activity:" + activities.map((a) => a.type).join("+"))

  /* ---------- 2. explicit camera ---------- */
  const explicitRequirements = []
  let camera = null
  for (const r of EXPLICIT_CAMERA) {
    const m = r.re.exec(text)
    if (!m) continue
    camera = { mode: r.mode, device: r.device, position: r.position, source: "explicit" }
    explicitRequirements.push({ type: "camera", mode: r.mode, source: "explicit", spans: [{ start: m.index, end: m.index + m[0].length, text: m[0] }] })
    diagnostics.matchedRules.push("explicit:" + r.mode)
    break
  }

  /* ---------- 3. subject（主体类型；不由机位推导） ---------- */
  let subject = null
  let subjectWhy = null
  const objHit = OBJECT_CUES.map((r) => ({ r, m: r.re.exec(text) })).find((x) => x.m)
  const scnHit = SCENE_CUES.map((r) => ({ r, m: r.re.exec(text) })).find((x) => x.m)
  const perHit = PERSON_CUES.map((r) => ({ r, m: r.re.exec(text) })).find((x) => x.m)

  const readingWantsObject = activities.some((a) => a.type === "reading") && /(拍|给你看|记录)/.test(text)
  const aboutHerOnly = hits.length > 0 && hits.every((h) => h.aboutHer)

  if (readingWantsObject) { subject = "object"; subjectWhy = "reading_wants_object" }
  else if (objHit && !(perHit && !aboutHerOnly && !activities.length)) { subject = "object"; subjectWhy = objHit.r.why }
  else if (scnHit && !perHit) { subject = "scene"; subjectWhy = scnHit.r.why }
  else if (perHit || aboutHerOnly) { subject = "character"; subjectWhy = "person_signal" }
  /* 只有动作、且动作对象不是她身上的东西 → 拍的是那些东西（例：桌前挑笔） */
  else if (activities.length) { subject = "object"; subjectWhy = "activity_target_object" }
  else { subject = "character"; subjectWhy = "default_character" }
  if (subjectWhy) diagnostics.matchedRules.push("subject:" + subjectWhy)

  /* 机位是"拍人"的模式时，主体必然是人物（特写/视频/自拍/背影/镜子） */
  const personCam = camera && ["face_closeup", "video_call", "front_selfie", "mirror_selfie", "back_view"].includes(camera.mode)
  if (personCam && subject !== "character" && !readingWantsObject) {
    diagnostics.conflicts.push(`camera=${camera.mode} 但 subject=${subject}`)
    subject = "character"
    subjectWhy = "forced_by_camera_mode"
  }

  /* ---------- 4. framing ---------- */
  let framing = null
  const fHit = FRAMING_RULES.map((r) => ({ r, m: r.re.exec(text) })).find((x) => x.m)
  if (fHit) framing = { type: fHit.r.type, source: "explicit" }
  else if (subject === "object") framing = { type: "object", source: "inferred" }
  else if (subject === "scene") framing = { type: "object", source: "inferred" }
  else if (/(穿搭|这身|这一身|新衣服|试衣|好不好看)/.test(text)) framing = { type: "full", source: "inferred" } /* show_outfit_framing */
  else framing = { type: null, source: "unresolved" }
  if (framing.type === null) diagnostics.unresolved.push("framing")

  /* ---------- 5. camera（没有明确要求时不要无脑默认 selfie） ---------- */
  if (!camera) {
    const outfit = /(穿搭|这身|这一身|新衣服|新买|试衣|好不好看|新发饰)/.test(text)
    const fpCue = framing.type === "part" || /(桌面|桌上|碗里|锅里|手里|手上|台面|眼前)/.test(text)
    const tidyOrCook = activities.some((a) => a.type === "tidying" || a.type === "cooking")
    if (outfit) camera = { mode: "mirror_selfie", device: "mirror", position: "mirror_front", source: "purpose" }
    else if (subject === "object" && (fpCue || tidyOrCook || activities.some((a) => a.type === "holding_item"))) {
      camera = { mode: "first_person", device: "phone", position: "eye", source: "inferred" }
    } else if (subject === "object") camera = { mode: "rear_object", device: "rear_cam", position: "rear", source: "inferred" }
    else if (subject === "scene") camera = { mode: "scene_only", device: "rear_cam", position: "rear", source: "inferred" }
    else {
      camera = { mode: null, device: null, position: null, source: "context" }
      diagnostics.unresolved.push("camera")
    }
  }

  /* ---------- 6. scene（只作背景，永不参与机位决策） ---------- */
  const background = []
  if (/(窗|窗帘|窗台)/.test(text)) background.push("window")
  if (/(书桌|桌子|台面)/.test(text)) background.push("desk")
  if (/(床|被|枕头)/.test(text)) background.push("bed")
  if (/(衣柜|镜子)/.test(text)) background.push("closet")
  const location = /(外面|街上|店里|公园|阳台)/.test(text) ? "outdoor" : "indoor"

  /* ---------- 7. constraints ---------- */
  const constraints = []
  const C = (type, source, scope) => ({ type, source, scope })
  /*
   * 三个限制**互不替代**（复核意见④）：
   *   no_phone   = 手机不进入画面（不是不能用手机拍）
   *   no_face    = 不展示脸（不等于不出现身体）
   *   no_person  = 完全不出现人物（不等于不能出现手）
   */
  if (camera.mode === "first_person") {
    constraints.push(C("no_face", "camera_mode", "frame"))
    constraints.push(C("no_phone", "camera_mode", "frame"))
  }
  if (camera.mode === "front_selfie" || camera.mode === "face_closeup") {
    constraints.push(C("no_phone", "camera_mode", "frame"))
  }
  if (camera.mode === "rear_object") {
    constraints.push(C("no_person", "camera_mode", "scene"))
  }
  if (camera.mode === "scene_only") {
    constraints.push(C("no_person", "camera_mode", "scene"))
  }
  if (camera.mode === "back_view") {
    constraints.push(C("no_face", "camera_mode", "frame"))
  }

  const purpose = inferPurpose(text, subject, camera.mode)

  /* 决策痕迹（复核意见⑤）：为什么有这个机位 / 为什么没有 */
  if (!diagnostics.decisionTrace) diagnostics.decisionTrace = []
  diagnostics.decisionTrace.push({
    field: "camera",
    value: camera.mode,
    reason: camera.mode ? camera.source : "no_explicit_camera_requirement",
  })
  diagnostics.decisionTrace.push({ field: "subject", value: subject, reason: subjectWhy })
  const intentSource = explicitRequirements.length ? "explicit" : (camera.source === "context" ? "context" : "inferred")

  /*
   * 次要主体（复核意见②）：主次关系必须保留，所以不做成 subject 数组。
   *   坐在床边看漫画 → character + ["comic"]
   *   双手捧碗       → object   + []（碗是主，手是画面元素）
   */
  const secondarySubjects = []
  if (/(漫画|书)/.test(text) && subject === "character") secondarySubjects.push("comic")
  if (/(碗|面)/.test(text) && subject === "object") secondarySubjects.push("bowl")
  if (/(穿搭|这身|新衣服)/.test(text)) secondarySubjects.push("outfit")

  return {
    schemaVersion: "3.0.0-intent",
    subject,
    secondarySubjects,
    intent: { purpose, source: intentSource },
    activities,
    framing,
    composition: null,
    camera,
    scene: { location, background },
    explicitRequirements,
    constraints,
    diagnostics,
    /* 原始文本：只给 camera-planner 细分几何用，不作为对外语义字段 */
    _raw: text,
    /* 兼容旧测试/旧代码的只读别名（不再作为真源） */
    legacy: { activity: activities[0] ? activities[0].type : null, framingType: framing.type },
    confidence: null,
  }
}

/**
 * 投影：intent → 旧 mode id（过渡层）。
 * ⚠️ 会掩盖 rear_object/scene_only 的差异，所以调用方必须同时记录**投影前后**。
 */
const LEGACY_MODE_MAP = {
  face_closeup: "face_closeup",
  front_selfie: "front_selfie",
  mirror_selfie: "mirror_selfie",
  video_call: "video_call",
  first_person: "first_person",
  back_view: "back_view",
}

/**
 * 投影：新 intent → 旧 mode id。
 * ⚠️ **未确定机位 ≠ 前置自拍**（复核意见①）：
 *    camera=null / 未知模式 / 映射不到 → 一律返回 null，绝不兜底成 front_selfie。
 */
export function projectMode(intent) {
  const mode = intent && intent.camera ? intent.camera.mode : null
  if (!mode) return null
  if (mode === "rear_object" || mode === "scene_only") return "rear_selfie"
  return LEGACY_MODE_MAP[mode] ?? null
}

