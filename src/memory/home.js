/**
 * 她的家：一室一厅（2026-11-11 统一）
 *
 * 现场问题：
 *   · 户型描述原来只写在 bridge.js 一处，且**只有卧室/客厅**；
 *   · 「晾衣杆挂在客厅」不合理，做饭/洗漱也没有对应房间；
 *   · 没有"按活动选房间"的规则 → 出图默认全是卧室。
 *
 * 这里做成唯一真源：房间清单 + 活动→房间映射 + 给提示词用的环境句。
 */

export const HOME_ROOMS = {
  bedroom: '卧室：灰床单、书桌对着窗、窗台绿萝、衣柜门有点卡',
  living: '客厅：布艺小沙发、矮茶几、暖光落地灯、靠墙的小餐桌和两把椅子、电视柜',
  kitchen: '小厨房：L 型灶台、水槽、吊柜，台面不大但收拾得干净',
  balcony: '封闭阳台（在她家里的室内阳台，不是户外街边）：晾衣杆、洗衣篮、几盆绿植',
  bathroom: '卫生间：洗手台、镜子、牙刷杯、小窗透光',
  entry: '玄关：鞋柜、穿衣镜、换鞋凳',
}

/** 活动/物件 → 房间（找不到返回 null，不硬猜） */
export function roomForActivity(text = '') {
  const t = String(text ?? '')
  if (/(洗(?!衣|澡)|杯|水槽|碗|做饭|煮|炒|蒸|熬|洗碗|洗锅|切菜|灶台|厨房|锅)/.test(t)) return 'kitchen'
  if (/(晾|洗衣|衣服还没收|阳台|洗衣篮)/.test(t)) return 'balcony'
  if (/(洗漱|刷牙|洗脸|洗手|肥皂|卫生间|镜前刷牙)/.test(t)) return 'bathroom'
  if (/(睡|床|枕头|被子|衣柜|穿搭|对镜|镜子前)/.test(t)) return 'bedroom'
  if (/(沙发|电视|茶几|吃饭|餐桌|休息|窝着)/.test(t)) return 'living'
  if (/(出门|换鞋|鞋柜|玄关)/.test(t)) return 'entry'
  return null
}

/** 给提示词的单房间描述 */
export function roomScene(room) {
  return HOME_ROOMS[String(room ?? '')] ?? ''
}

/**
 * 环境句：先按活动选房间；没有线索时**白天默认客厅、夜里才卧室**，
 * 避免"所有图都在卧室"（2026-11-11 用户反馈）。
 *
 * 2026-11-13 修「按每日计划来」：
 *   用户「现在人的位置应该在床上，而不是玄关」+「按照每日计划来」。
 *   之前只按文本关键词 + hash 在 [卧室,玄关] 里随机挑房间，深夜也可能挑到玄关，
 *   跟当天计划（夜里在床上）完全脱节。
 *   现在优先看**当前时段的计划线索** `slotHint`：
 *     · 夜里/计划提到 睡床/关灯/洗漱后 → 卧室
 *     · 对镜 → 卧室（玄关只是白天匆匆出门才用，不再随机）
 */
export function homeEnvelope(text = '', hour = new Date().getHours(), slotHint = '') {
  const t = String(text ?? '')
  const hint = String(slotHint ?? '')
  const house = '家里是一室一厅（卧室、客厅、小厨房、阳台、卫生间、玄关）'
  const hash = (x) => { let h = 0; for (let i = 0; i < x.length; i++) h = (h * 31 + x.charCodeAt(i)) >>> 0; return h }
  /* 深夜（23 点后）或计划里提到睡/床/关灯/洗漱后 → 人就在卧室床上 */
  const nightInBed = hour >= 23 || hour < 6
    || /(睡|床|关灯|躺|被窝|睡前|洗漱后)/.test(hint)
  const wantsMirror = /(对镜|穿衣镜|镜子前|对着镜子|镜中)/.test(t)
  const wantsSelfie = /(自拍|看看你|露个脸|前置)/.test(t)
  if (nightInBed) {
    /* 夜里人就在卧室床上：无论对镜还是自拍，背景都是卧室，且明确"坐在/靠在床上" */
    return `${house}；这一张在${HOME_ROOMS.bedroom}（她此刻人在卧室，坐在床边/床上，台灯或床头灯）`
  }
  if (wantsMirror) {
    /* 对镜固定卧室（卧室有穿衣镜）；玄关只在与"出门/换鞋"相关时用 */
    const room = /(出门|换鞋|鞋柜|玄关|要走了)/.test(t) ? 'entry' : 'bedroom'
    return `${house}；这一张在${HOME_ROOMS[room]}（**这里才有穿衣镜**）`
  }
  const r = roomForActivity(t)
  if (r && !(wantsSelfie && r === 'bedroom')) return `${house}；这一张在${HOME_ROOMS[r]}`
  /* 前置自拍：客厅/卧室/阳台轮换，避免"每次都在卧室" */
  if (wantsSelfie || !r) {
    const pool = ['living', 'balcony', 'kitchen']
    const room = pool[hash(t + String(hour)) % pool.length]
    return `${house}；这一张在${HOME_ROOMS[room]}（前置自拍，画面里不要出现镜子）`
  }
  return `${house}；这一张在${HOME_ROOMS[r]}`
}
