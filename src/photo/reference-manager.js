/**
 * reference-manager · P1-1b（第 1~3 步复核修正版）
 * **仍未接入正式生图入口**。
 *
 * 只回答一件事：这一次该用哪张参考图。
 *
 * ## 本版修正（复核意见 2026-11-09）
 * 1. **版本校验先做**：canon 版本、bodyRef 版本、角色版本合法性都在
 *    NO_PERSON_MODES 判定**之前**执行；`first_person` 等模式只是"不使用身份参考图"，
 *    **不等于跳过版本安全检查**。
 * 2. **服装比较不再用"服装类别词数量"**：优先 outfitId；缺 ID 时对**规范化完整描述**
 *    做字符二元组 Dice 相似度（≥0.85 才判同套），否则保守判冲突。
 * 3. **非法版本值不静默降级**：`parseVersion()` 区分 未声明(A, assumed) / 显式A / 显式B / 非法；
 *    非法值直接产生 `invalid_character_version` 冲突。
 */

const NO_PERSON_MODES = new Set(['first_person', 'rear_object', 'scene_only'])

/** 版本解析：区分 未声明 / 显式 A / 显式 B / 非法 */
export function parseVersion(v) {
  const raw = String(v ?? '').trim()
  if (!raw) return { value: 'A', assumed: true, valid: true }
  const up = raw.toUpperCase()
  if (up === 'A') return { value: 'A', assumed: false, valid: true }
  if (up === 'B') return { value: 'B', assumed: false, valid: true }
  return { value: null, assumed: false, valid: false }
}

/** 兼容旧调用：等价于 parseVersion().value ?? 'A'（仅供展示，勿用于校验） */
export function normalizeVersion(v) {
  return parseVersion(v).value ?? 'A'
}

function normText(s) {
  return String(s ?? '')
    .replace(/[\s*·•\-—_,，。;；、:：()（）[\]【】"“”'']/g, '')
    .toLowerCase()
}

function bigramCounts(s) {
  const t = normText(s)
  const m = new Map()
  for (let i = 0; i + 2 <= t.length; i++) {
    const g = t.slice(i, i + 2)
    m.set(g, (m.get(g) ?? 0) + 1)
  }
  return { m, len: t.length }
}

function dice(a, b) {
  const A = bigramCounts(a)
  const B = bigramCounts(b)
  if (!A.len || !B.len) return 0
  let overlap = 0
  for (const [g, c] of A.m) overlap += Math.min(c, B.m.get(g) ?? 0)
  const total = A.m.size + B.m.size
  if (!total) return 0
  /* 多重集 Dice：2*交集 / 总计数 */
  let sa = 0
  for (const c of A.m.values()) sa += c
  let sb = 0
  for (const c of B.m.values()) sb += c
  return (2 * overlap) / (sa + sb)
}

/**
 * 服装是否同一套（**保守**）。
 * - 规范化后完全相同 → true
 * - 任一侧过短（<12 字符）→ false（信息不足）
 * - 否则字符二元组 Dice ≥ 0.85 才算同套
 * 绝不因"裙/吊带/短裤"这类类别词相同而判同套。
 */
export function sameOutfitText(a, b) {
  const na = normText(a)
  const nb = normText(b)
  if (!na || !nb) return false
  if (na === nb) return true
  if (na.length < 12 || nb.length < 12) return false
  return dice(na, nb) >= 0.85
}

/**
 * @returns {{
 *   strategy:'canon'|'face'|'fallback'|'none',
 *   refImage:string|null, identityRef:string|null, humanPartsAllowed:boolean,
 *   reason:string, conflict:boolean,
 *   version:{current:string|null, canon:string|null, body:string|null, assumed:boolean, valid:boolean},
 *   checks:{name:string, ok:boolean, detail?:string}[]
 * }}
 */
export function resolveReference({
  outfitText = '',
  outfitId = '',
  canon = null,
  faceRef = '',
  faceRefKind = 'unknown',
  mode = '',
  characterVersion = '',
  bodyRef = '',
  bodyRefVersion = '',
} = {}) {
  const checks = []

  /* ---------- ① 版本校验（**必须在任何提前返回之前**） ---------- */
  const pv = parseVersion(characterVersion)
  checks.push({ name: 'character_version', ok: pv.valid, detail: pv.assumed ? '未声明 → 按 A' : String(pv.value) })
  let versionConflict = false
  let dualReject = false
  if (!pv.valid) versionConflict = true

  const cur = pv.value

  let canonV = null
  if (canon && canon.file) {
    const pc = parseVersion(canon.version)
    canonV = pc.value
    if (!pc.valid) {
      versionConflict = true
      checks.push({ name: 'canon_version_invalid', ok: false, detail: String(canon.version) })
    } else if (pc.assumed) {
      checks.push({ name: 'canon_version_missing', ok: false, detail: '按 A 处理' })
    }
    if (pc.value && cur && pc.value !== cur) {
      versionConflict = true
      checks.push({ name: 'canon_version_mismatch', ok: false, detail: `canon=${pc.value} current=${cur}` })
    } else if (pc.valid) {
      checks.push({ name: 'canon_version', ok: true, detail: String(pc.value ?? 'A') })
    }
  }

  let bodyV = null
  if (bodyRef) {
    const pb = parseVersion(bodyRefVersion)
    bodyV = pb.value
    if (!pb.valid) {
      versionConflict = true
      checks.push({ name: 'body_version_invalid', ok: false, detail: String(bodyRefVersion) })
    } else if (!cur) {
      /* 角色版本非法 → 无法比较，不能记为成功 */
      checks.push({ name: 'body_version_unchecked', ok: false, detail: 'character_version_invalid' })
    } else if (pb.value !== cur) {
      versionConflict = true
      checks.push({ name: 'body_version_mismatch', ok: false, detail: `body=${pb.value} current=${cur}` })
    } else {
      checks.push({ name: 'body_version', ok: true, detail: String(pb.value) })
    }
    /* faceRef 与 bodyRef 同一张图 → 双重身份，拒绝 */
    if (faceRef && String(faceRef) === String(bodyRef)) {
      versionConflict = true
      dualReject = true
      checks.push({ name: 'dual_identity_reference', ok: false, detail: 'faceRef === bodyRef' })
    }
  }

  const version = { current: cur, canon: canonV, body: bodyV, assumed: pv.assumed, valid: pv.valid }

  /* ---------- ② 画面本就不该有人：不用身份参考图（但版本检查已做完） ---------- */
  if (NO_PERSON_MODES.has(String(mode))) {
    checks.push({ name: 'mode_has_no_person', ok: true, detail: String(mode) })
    return {
      strategy: 'none',
      refImage: null,
      identityRef: null,
      humanPartsAllowed: true,
      reason: versionConflict ? 'no_person_with_version_conflict' : 'mode_has_no_person',
      conflict: versionConflict,
      version,
      checks,
    }
  }

  /* ---------- ③ 服装是否同一套 ---------- */
  let same = false
  let outfitConflict = false
  if (canon && canon.file && !versionConflict) {
    const canonId = String(canon.outfitId ?? '').trim()
    const curId = String(outfitId ?? '').trim()
    if (canonId && curId) {
      same = canonId === curId
      outfitConflict = !same
      checks.push({ name: 'outfit_id', ok: same, detail: `${curId} vs ${canonId}` })
    } else {
      const canonText = String(canon.outfitText ?? '').trim()
      const curText = String(outfitText ?? '').trim()
      if (canonText && curText) {
        same = sameOutfitText(curText, canonText)
        outfitConflict = !same
        checks.push({ name: 'outfit_text', ok: same, detail: `dice>=0.85? ${same}` })
      } else {
        outfitConflict = true
        checks.push({ name: 'outfit_info_incomplete', ok: false, detail: '缺 outfitId 或 outfitText' })
      }
    }
  }

  const conflict = versionConflict || outfitConflict

  /* ---------- ④ 一致 → canon ---------- */
  if (canon && canon.file && same && !versionConflict) {
    return { strategy: 'canon', refImage: canon.file, identityRef: canon.file, humanPartsAllowed: true, reason: 'outfit_matches_canon', conflict: false, version, checks }
  }

  /* ---------- ⑤ 冲突 / 无 canon → 只用"只锁脸"的图，否则兜底 ---------- */
  /* dual_identity_reference 是**独立拒绝条件**：检测到就不得再通过 face fallback 用同一张图 */
  if (dualReject) {
    return {
      strategy: 'fallback',
      refImage: null,
      identityRef: null,
      humanPartsAllowed: true,
      conflict: true,
      reason: 'dual_identity_reference_rejected',
      version,
      checks,
    }
  }

  const headOk = Boolean(faceRef) && faceRefKind === 'head'
  if (headOk) {
    return {
      strategy: 'face',
      refImage: faceRef,
      identityRef: faceRef,
      humanPartsAllowed: true,
      conflict,
      reason: versionConflict
        ? 'version_conflict_use_head_ref'
        : (outfitConflict ? 'outfit_conflict_use_head_ref' : 'no_canon_use_head_ref'),
      version,
      checks,
    }
  }

  return {
    strategy: 'fallback',
    refImage: null,
    identityRef: null,
    humanPartsAllowed: true,
    conflict,
    reason: versionConflict
      ? 'version_conflict_and_no_head_ref'
      : (outfitConflict
        ? 'outfit_conflict_and_no_head_ref'
        : (faceRef && faceRefKind === 'costume' ? 'face_ref_carries_costume' : 'no_usable_reference')),
    version,
    checks,
  }
}

export const REFERENCE_STRATEGIES = ['canon', 'face', 'fallback', 'none']
