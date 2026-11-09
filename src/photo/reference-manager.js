/**
 * reference-manager · P1-1b（第 1~3 步，**仍未接入正式生图入口**）
 *
 * 只回答一件事：**这一次该用哪张参考图**。
 *
 * ## 相对上一版修正的三点（评审要求）
 * 1. **不看 `canon.match`**：match 是正则（用于 canonFor 命中），不是服装描述。
 *    比较只用 `outfitId`（优先）→ `outfitText`（次级）→ 信息不全则**保守判冲突**。
 * 2. `first_person` 等"画面无人物"模式返回 `strategy:'none'`，
 *    但 **`identityRef:null` 只表示"不用人物身份参考图"**，
 *    `humanPartsAllowed:true` 明确表示：手/小臂/腿是否出现由 camera/pose 决定，与本模块无关。
 * 3. **A/B 版本隔离**：canon 与 body 参考图都必须与 `characterVersion` 一致；
 *    版本未声明一律按 **A**（绝不默认 B）。
 */

const GARMENT_WORDS = [
  '吊带', '背心', '短裤', '长裤', '裙', '衬衫', '衬衣', 'T恤', 't恤', '卫衣', '毛衣',
  '针织', '开衫', '外套', '风衣', '睡衣', '睡裙', '制服', '水手', '女仆', '围裙', '泳',
]

const NO_PERSON_MODES = new Set(['first_person', 'rear_object', 'scene_only'])

/** 版本归一：只认 'A'/'B'，未声明 → 'A' */
export function normalizeVersion(v) {
  return String(v ?? '').trim().toUpperCase() === 'B' ? 'B' : 'A'
}

function normText(s) {
  return String(s ?? '')
    .replace(/[\s*·•\-—_,，。;；、:：()（）[\]【】"“”'']/g, '')
    .toLowerCase()
}

function garmentTokens(s) {
  const t = normText(s)
  const out = new Set()
  for (const w of GARMENT_WORDS) if (t.includes(normText(w))) out.add(w)
  return out
}

/**
 * 服装是否"同一套"。**刻意保守**：只共享"白色/蕾丝"这类不算同套。
 * 规则：共享主体词 ≥3；或共享 2 个且两边主体词都 ≥3 个。
 */
export function sameOutfitText(a, b) {
  const A = garmentTokens(a)
  const B = garmentTokens(b)
  if (!A.size || !B.size) return false
  let shared = 0
  for (const w of A) if (B.has(w)) shared++
  if (shared >= 3) return true
  if (shared === 2 && A.size >= 3 && B.size >= 3) return true
  return false
}

/**
 * @returns {{
 *   strategy:'canon'|'face'|'fallback'|'none',
 *   refImage:string|null, identityRef:string|null, humanPartsAllowed:boolean,
 *   reason:string, conflict:boolean,
 *   version:{ current:string, canon:string|null, body:string|null, assumed:boolean },
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
  const current = normalizeVersion(characterVersion)
  const assumedVersion = !String(characterVersion ?? '').trim()

  const base = {
    strategy: 'fallback',
    refImage: null,
    identityRef: null,
    humanPartsAllowed: true,
    reason: '',
    conflict: false,
    version: {
      current,
      canon: canon && canon.version ? normalizeVersion(canon.version) : null,
      body: bodyRefVersion ? normalizeVersion(bodyRefVersion) : null,
      assumed: assumedVersion,
    },
    checks,
  }

  /* ① 画面里本就不该有人：不用身份参考图（但**不禁止**人体局部） */
  if (NO_PERSON_MODES.has(String(mode))) {
    checks.push({ name: 'mode_has_no_person', ok: true, detail: String(mode) })
    return { ...base, strategy: 'none', identityRef: null, humanPartsAllowed: true, reason: 'mode_has_no_person' }
  }

  /* ② 版本校验（canon） */
  let versionConflict = false
  if (canon && canon.file) {
    const canonV = normalizeVersion(canon.version)
    if (!canon.version) checks.push({ name: 'canon_version_missing', ok: false, detail: '按 A 处理' })
    if (canonV !== current) {
      versionConflict = true
      checks.push({ name: 'canon_version_mismatch', ok: false, detail: `canon=${canonV} current=${current}` })
    } else {
      checks.push({ name: 'canon_version', ok: true, detail: canonV })
    }
  }

  /* ③ 版本校验（body 参考图，若有） */
  if (bodyRef) {
    const bodyV = normalizeVersion(bodyRefVersion)
    if (bodyV !== current) {
      versionConflict = true
      checks.push({ name: 'body_version_mismatch', ok: false, detail: `body=${bodyV} current=${current}` })
    } else {
      checks.push({ name: 'body_version', ok: true, detail: bodyV })
    }
  }

  /* ④ 服装是否同一套：ID 优先 → 文本 → 信息不全按冲突 */
  let same = false
  let outfitConflict = false
  if (canon && canon.file) {
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
        checks.push({ name: 'outfit_text', ok: same })
      } else {
        outfitConflict = true
        checks.push({ name: 'outfit_info_incomplete', ok: false, detail: '缺 outfitId 或 outfitText' })
      }
    }
  }

  const conflict = versionConflict || outfitConflict

  /* ⑤ 一致 → canon */
  if (canon && canon.file && same && !versionConflict) {
    return { ...base, strategy: 'canon', refImage: canon.file, identityRef: canon.file, reason: 'outfit_matches_canon' }
  }

  /* ⑥ 冲突或没有 canon → 只用"只锁脸"的参考图，否则兜底 */
  const headOk = Boolean(faceRef) && faceRefKind === 'head'
  if (headOk) {
    return {
      ...base,
      strategy: 'face',
      refImage: faceRef,
      identityRef: faceRef,
      conflict,
      reason: versionConflict
        ? 'version_conflict_use_head_ref'
        : (outfitConflict ? 'outfit_conflict_use_head_ref' : 'no_canon_use_head_ref'),
    }
  }

  return {
    ...base,
    strategy: 'fallback',
    conflict,
    reason: versionConflict
      ? 'version_conflict_and_no_head_ref'
      : (outfitConflict
        ? 'outfit_conflict_and_no_head_ref'
        : (faceRef && faceRefKind === 'costume' ? 'face_ref_carries_costume' : 'no_usable_reference')),
  }
}

export const REFERENCE_STRATEGIES = ['canon', 'face', 'fallback', 'none']
