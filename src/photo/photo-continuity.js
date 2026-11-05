/**
 * 连续性管理（photo-continuity）
 *
 * 用户指出的事故：同一时段的几张照片，衣服/光线/场景应该是一致的。
 * 更重要的警告（方案第七条）：**不要继承整张图片的构图**，只继承场景状态。
 *
 * 三档连续性：
 *   强 —— 同一次拍摄的多张（同衣服、同场景、同光线、同发型）
 *   中 —— 同一天不同时段（可换姿势/光线，换衣必须有换衣事件）
 *   弱 —— 跨天（只保人物身份和生活习惯）
 */

const SESSION_TTL_MS = 45 * 60 * 1000   // 45 分钟内算"同一次拍摄"

/** 场景地点归一化（用来判断"是不是同一个地方"） */
const LOCATIONS = [
  { re: /(厨房|水池|灶台|锅|洗碗|做饭|煮|炒)/, id: 'kitchen', label: '厨房' },
  { re: /(沙发|客厅|电视|茶几)/, id: 'living_room', label: '客厅' },
  { re: /(书桌|写字|笔记本|台灯|书堆|书桌)/, id: 'desk', label: '书桌前' },
  { re: /(阳台|晾衣|晾|栏杆|花盆)/, id: 'balcony', label: '阳台' },
  { re: /(床|卧室|被|枕头|床头)/, id: 'bedroom', label: '卧室' },
  { re: /(镜子|穿衣镜|镜前)/, id: 'mirror', label: '镜子前' },
  { re: /(洗手台|浴室|卫生间)/, id: 'bathroom', label: '洗手台前' },
  { re: /(餐桌|吃饭|早餐|面包|牛奶)/, id: 'table', label: '餐桌边' },
]

export function detectLocation(scene) {
  const t = String(scene ?? '')
  for (const l of LOCATIONS) if (l.re.test(t)) return { id: l.id, label: l.label }
  return { id: 'home', label: '家里' }
}

/**
 * 拍摄会话（存在内存里就够了 —— 机器人重启后重新开始）。
 * 只保存"状态"，不保存图片。
 */
export class PhotoContinuity {
  constructor({ ttlMs = SESSION_TTL_MS } = {}) {
    this.ttlMs = ttlMs
    /** @type {Map<string, object>} key = scope（私聊/群），value = session */
    this.sessions = new Map()
  }

  /**
   * 记录一张刚拍的照片，返回它所属的会话（用于下次复用状态）。
   * @param {object} o
   * @param {string} o.scope    会话标识（如 private:2129024700）
   * @param {string} o.scene    场景原话
   * @param {string} o.outfit   当天穿着
   * @param {string} o.hair     当天发型
   * @param {string} o.slot     时段 id
   * @param {string} o.mode     拍摄模式
   * @param {string} [o.weather]
   * @param {number} [o.now]
   * @returns {{session:object, strength:'strong'|'medium'|'weak'}}
   */
  record({ scope, scene, outfit, hair, slot, mode, weather = '', now = Date.now() }) {
    const loc = detectLocation(scene)
    const prev = this.sessions.get(scope)

    const sameSlot = prev && prev.slot === slot && prev.outfit === outfit
    const fresh = prev && now - prev.at <= this.ttlMs
    const strength = sameSlot && fresh ? 'strong' : (prev && prev.day === todayKey(now) ? 'medium' : 'weak')

    const session = {
      scope,
      day: todayKey(now),
      at: now,
      slot,
      outfit,
      hair,
      weather,
      location: loc.id,
      locationLabel: loc.label,
      mode,
      /* 只记"状态"，不记构图 —— 下一张不要复制上一张的画面 */
      lastScene: String(scene ?? '').slice(0, 120),
      strength,
    }
    this.sessions.set(scope, session)
    return { session, strength }
  }

  /** 取当前会话（没有就返回 null） */
  peek(scope) {
    const s = this.sessions.get(scope)
    if (!s) return null
    if (Date.now() - s.at > this.ttlMs * 4) return null   // 太久就不算了
    return s
  }

  /**
   * 生成给提示词用的连续性说明。
   * **强**：明确"同一套衣服/同一个地方/同一段光线"；
   * **中**：同一天但可以说"和刚才在同一个家"；
   * **弱**：什么都不说（免得模型把上张画面搬过来）。
   */
  continuityNote(scope, { outfit, hair, slot } = {}) {
    const s = this.peek(scope)
    if (!s) return ''
    if (s.outfit !== outfit || s.hair !== hair) {
      /* 换衣服了 —— 必须有"换衣"这个事件，否则就是穿帮 */
      return '（注意：她换了衣服，说明中间有过换衣，不要在画面里同时出现两套衣服）'
    }
    if (s.slot === slot && s.strength === 'strong') {
      return `（同一段拍摄：同一个地方（${s.locationLabel}）、同一套衣服、同一段光线，`
        + '可以换姿势和角度，但不要换场景、不要换衣服、不要复制上一张的构图）'
    }
    if (s.slot === slot) {
      return `（还是${s.locationLabel}，衣服没换，光线可以略有变化）`
    }
    return ''
  }
}

function todayKey(now) {
  const d = new Date(now)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}
