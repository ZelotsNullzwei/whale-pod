/**
 * 摄影可行性检查（photo-validator）
 *
 * 这是 v2.0 方案里最关键的"闸门"：**在调用生图之前**先判断
 * "这个拍摄方案物理上能不能成立"，不成立就修正，修正不了就换方案。
 *
 * 今天出过的事故（就是被这里拦住的）：
 *   · 场景写"背影"，规则判成"她不在画面里"→ 不带参考图 → 画成路人；
 *   · 场景写"只露侧脸"，模型把脸怼到镜头前（自拍拍不到自己侧脸）；
 *   · 全身照顶到底边，裁水印把脚切掉；
 *
 * 这个模块不生成提示词，只输出 `{ ok, issues, fix }`。
 */

/**
 * @param {object} plan   photo-planner 的输出
 * @param {object} ctx
 * @param {string} ctx.scene      场景原话
 * @param {boolean} [ctx.hasMirror] 场景里有没有镜子
 * @param {string} [ctx.timeOfDay]  morning/noon/afternoon/evening/night
 * @returns {{ok:boolean, issues:Array<{code:string,msg:string,level:string}>, fix:object}}
 */
export function validatePhotoPlan(plan, ctx = {}) {
  const issues = []
  const fix = {}
  const text = String(ctx.scene ?? '')

  /*
   * ① 镜子：**默认就有**（2026-11-05 用户口径）——
   *   「要露脸可以通过镜子，大镜子小镜子都可以，女孩子有镜子很正常」。
   *   所以不再因为"场景里没写镜子"就退成前置自拍（那会让模型画成两条自拍臂+多手）。
   */
  if (plan.mode === 'mirror_selfie' && ctx.noMirror === true) {
    issues.push({ code: 'no_mirror', msg: '明确说了没有镜子', level: 'high' })
    fix.mode = 'front_selfie'
    fix.reason = '明确没有镜子 → 改成前置自拍'
  }

  /* ③ 视频通话：场景里必须真的在通话，否则退成前置自拍
   *    （2026-11-05 用户定：线上陪伴关系，**没有现实见面** ——
   *      所以不存在"朋友帮拍/他人抓拍"，也不虚构摄影师、不假设他在她身边） */
  if (plan.mode === 'video_call' && !/(视频|通话|屏幕|聊天中)/.test(text)) {
    issues.push({ code: 'not_video_call', msg: '说是视频通话但场景里没有通话', level: 'high' })
    fix.mode = 'front_selfie'
    fix.reason = '场景不是通话 → 改成前置自拍'
  }

  /*
   * ④ 前置自拍拍不到后脑/背影 —— 只能拍到自己面前的东西。
   *
   * ★★ **别把"背景"当成"背影"**（2026-11-06 实测踩到）。
   *
   * 现场：
   * ```
   * 14:54:28 他「全是全身，不来点面部妆容特写？」
   * 14:54:30 画图「…她凑近手机镜头自拍，脸占满画面，
   *              浅色的窗帘和书桌在背后虚…」   ← 这里的"背后"是**背景**
   *          拍摄方案 → 第一人称记录｜局部
   *              （原 front_selfie → 修正：前摄拍不到背影 → 改成第一人称记录）
   * 14:54:54 [我]「（凑到镜头前，就露脸）行，那这张专拍脸，别眨眼。」
   *          结果发出去是一碗饭 + 手 + 白裤子，**脸完全没入镜**
   * ```
   *
   * 根因：`/(背影|后脑|背对|背后)/` 把「书桌在背后虚化」也匹配了，
   * 于是要**拍脸**的方案被降级成第一人称（从她眼睛看出去）——
   * 第一人称物理上就拍不到自己，脸当然不在画面里。
   *
   * 所以：只有「背对镜头 / 拍背影 / 只拍后脑」这类**真的要求背面**
   * 的说法才降级；「背后有…」只是构图描述，不降。
   */
  if (plan.mode === 'front_selfie' && /(背影|后脑|背对[镜着]?头|拍背|拍后背|背部特写|转过身)/.test(text)) {
    issues.push({ code: 'front_cannot_back', msg: '前置自拍拍不到背影', level: 'high' })
    fix.mode = 'first_person'
    fix.reason = '前摄拍不到背影 → 改成第一人称记录（不拍自己背后）'
  }

  /* ⑤ 前置自拍拍不到自己的侧脸特写（自拍角度到不了 90°） */
  if (plan.mode === 'front_selfie' && /(纯侧|侧脸特写|只露侧脸|侧面特写)/.test(text)) {
    issues.push({ code: 'front_cannot_profile', msg: '前置自拍拍不到纯侧脸特写', level: 'medium' })
    fix.softenFace = true              // 不换模式，只把"纯侧脸特写"改成"侧脸一点点"
    fix.reason = '自拍角度到不了纯侧脸 → 弱化为轻微侧脸'
  }

  /*
   * ⑥ 第一人称却要求露脸 —— 矛盾。
   *
   * ⚠️ 正则原来只认「正脸/看镜头/脸对镜头/自拍」，而线上那句是
   *    「脸占满画面」「面部妆容特写」「专拍脸」—— 一条都不命中，
   *    于是**没有反向拦回来**，错方案一路走到底。
   *
   *    现在补全"要脸"的各种说法：脸占满 / 拍脸 / 露脸 / 特写脸 /
   *    面部 / 妆容 / 五官 / 表情特写。
   */
  if (plan.mode === 'first_person' && /(正脸|看镜头|脸对镜头|自拍|脸占满|脸占画面|拍脸|露脸|只拍脸|脸的特写|面部|妆容|五官|表情特写)/.test(text)) {
    issues.push({ code: 'fp_with_face', msg: '第一人称记录里出现了她的脸', level: 'high' })
    fix.mode = 'front_selfie'
    fix.reason = '第一人称拍不到自己的脸 → 改成前置自拍'
  }

  /*
   * ★★ 前置自拍却要拍身形 → 改成镜子自拍（2026-11-07 实测事故）。
   *
   * 前摄只有一臂距离，拍不到全身/三分之二身；模型为了构图会往后退，
   * 于是画面里多出"别人的手臂举着手机"、还带镜子边。
   * 想要身形，物理上只有镜子自拍（站到镜子前）能做到。
   */
  const wantsFigure = /(身材|三围|体型|全身|腿长|比例|这一身|这身|穿搭|好不好看)/.test(String(text) + ' ' + String(ctx.request ?? ''))
  /*
   * ★ 但**不是所有地方都该有镜子**（2026-11-07 用户）：
   *   「没镜子或者不应该存在镜子的地方，就正常拿着手机自拍」。
   *   床上/被窝/餐桌/厨房/车里/地铁/公司/教室 —— 这些地方硬塞一面穿衣镜，
   *   构图立刻假（卧室床边那张就是这么来的）。
   *   这种地方：保持前置自拍，只拍半身，别为了全身去加镜子或加别人的手。
   */
  const noMirrorPlace = /(没有镜子|没镜子|床上|床边|床前|床头|床沿|被窝|躺着|趴着|餐桌|饭桌|厨房|车里|车上|地铁|公交|路上|公司|办公室|教室|工位)/.test(String(text))
  if (plan.mode === 'front_selfie' && wantsFigure && !noMirrorPlace) {
    issues.push({ code: 'fp_figure', msg: '前置自拍拍不到全身/身形', level: 'high' })
    fix.mode = 'mirror_selfie'
    fix.reason = '前置自拍拍不到全身/身形 → 改成镜子自拍'
  }

  /* ⑦ 手机悬空：定时/后置却没提到任何支撑 */
  if (/(手机悬空|飘在|浮在)/.test(text)) {
    issues.push({ code: 'floating_phone', msg: '手机悬空', level: 'high' })
    fix.dropPhone = true
  }

  /* ⑧ 夜间：别拍"阳光明媚" */
  if (ctx.timeOfDay === 'night' && /(阳光|日照|正午的光|大太阳)/.test(text)) {
    issues.push({ code: 'time_light_mismatch', msg: '夜里却写阳光', level: 'medium' })
    fix.lighting = '室内暖光/台灯'
  }

  const ok = issues.filter((i) => i.level === 'high').length === 0
  return { ok, issues, fix }
}

/**
 * 把 fix 应用回 plan，得到"修正后的方案"。
 * @param {object} plan
 * @param {object} fix  validatePhotoPlan 返回的 fix
 * @param {object} modes MODES 表（避免循环依赖，由调用方传入）
 */
export function applyFix(plan, fix = {}, modes = {}) {
  const out = { ...plan }
  if (fix.mode && modes[fix.mode]) {
    const m = modes[fix.mode]
    out.mode = m.id
    out.modeLabel = m.label
    out.shooter = m.shooter
    out.device = m.device
    out.camera = m.camera
    out.look = m.look
    out.framing = m.framing
    out.rules = m.rules
    out.needs = m.needs
    out.needsCharacterRef = m.id !== 'first_person' && m.id !== 'rear_selfie'
    out.faceVisible = m.id === 'front_selfie' || m.id === 'mirror_selfie'
    out.fixedFrom = plan.mode
    out.fixReason = fix.reason ?? ''
  }
  if (fix.dropPhone) out.hidePhone = true
  if (fix.softenFace) out.softenFace = true
  if (fix.lighting) out.lighting = fix.lighting
  return out
}
