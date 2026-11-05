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

  /* ① 镜子自拍：场景里必须真有镜子 */
  if (plan.mode === 'mirror_selfie' && !ctx.hasMirror && !/(镜子|照镜子|穿衣镜|镜前|对着镜子|镜子里)/.test(text)) {
    issues.push({ code: 'no_mirror', msg: '镜子自拍但场景里没有镜子', level: 'high' })
    fix.mode = 'front_selfie'          // 退成前置自拍（半身以内仍成立）
    fix.reason = '没有镜子 → 改成前置自拍'
  }

  /* ③ 视频通话：场景里必须真的在通话，否则退成前置自拍
   *    （2026-11-05 用户定：线上陪伴关系，**没有现实见面** ——
   *      所以不存在"朋友帮拍/他人抓拍"，也不虚构摄影师、不假设他在她身边） */
  if (plan.mode === 'video_call' && !/(视频|通话|屏幕|聊天中)/.test(text)) {
    issues.push({ code: 'not_video_call', msg: '说是视频通话但场景里没有通话', level: 'high' })
    fix.mode = 'front_selfie'
    fix.reason = '场景不是通话 → 改成前置自拍'
  }

  /* ④ 前置自拍拍不到后脑/背影 —— 只能拍到自己面前的东西 */
  if (plan.mode === 'front_selfie' && /(背影|后脑|背对|背后)/.test(text)) {
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

  /* ⑥ 第一人称却要求露脸 —— 矛盾 */
  if (plan.mode === 'first_person' && /(正脸|看镜头|脸对镜头|自拍)/.test(text)) {
    issues.push({ code: 'fp_with_face', msg: '第一人称记录里出现了她的脸', level: 'high' })
    fix.mode = 'front_selfie'
    fix.reason = '第一人称拍不到自己的脸 → 改成前置自拍'
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
