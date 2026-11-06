/**
 * 外出（2026-11-06 用户：「总不能一直待在家里吧」）。
 *
 * 用户定的尺度：**A 为主（附近）、B 经常（市区）、C 偶尔（出远门）**。
 *   A 附近：楼下买菜、便利店、快递站、菜市场、药店、小区里走一圈
 *   B 市区：商场、公园、看展、看电影、书店、吃碗面
 *   C 远门：周边古镇、爬山、海边、隔壁城市
 *
 * 三条纪律（跟她的设定对齐）：
 *   ① **一个人去** —— 她的设定是独居、线上陪伴，没有现实里同行的人
 *   ② 不写具体城市名/景点名（GirlStyle 上那些是香港、首尔的，搬不过来）
 *   ③ 远近靠"怎么去 / 花多久"体现，不靠地名
 */
import fs from 'node:fs'

/** A 附近（最常见）。 */
/**
 * 日期字符串 → 稳定哈希（同一天永远同一个值，跨月也不容易撞）。
 * @param {string} key
 * @returns {number}
 */
function hashKey(key) {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

export const OUTING_NEARBY = [
  '下楼去小区门口的超市，买了瓶酱油和一袋挂面',
  '去楼下便利店拿了个快递，顺手买了杯酸奶',
  '走到菜市场买了把青菜和两块豆腐，跟摊主聊了两句涨价',
  '去药店买了盒创可贴和一瓶维生素',
  '下楼扔垃圾，顺便在小区里走了两圈',
  '去楼下的水果摊挑了几个橘子，挑了半天',
  '去快递站取件，排队排了十几分钟',
  '下楼买早餐，带回来一碗豆浆两根油条',
  '去小区门口的理发店剪了个头发，剪短了一点',
  '走到街角的便利店，买了包纸巾和一盒牛奶',
]

/** B 市区（经常）。 */
export const OUTING_CITY = [
  '坐了两站公交去商场，在化妆品柜台试了半天色号，最后只买了一支润唇膏',
  '去公园坐了一下午，看别人遛狗，自己什么也没干',
  '去看了一个小展览，人不算多，逛了一个多小时',
  '去电影院看了场电影，买了一大桶爆米花没吃完',
  '在书店待了一下午，翻了半本书，最后没买',
  '去吃了碗牛肉面，店里很吵，但面好吃',
  '去大超市采购，拎回来两大袋东西，手勒出印子',
  '去逛了趟家居店，看了半天收纳盒，没买',
  '坐地铁去了趟城的另一边，办完事顺便在街上走了走',
  '去咖啡店坐了一下午，点了杯拿铁，用电脑看了会儿剧',
]

/** C 出远门（偶尔）。 */
export const OUTING_TRIP = [
  '坐了一个多小时的车去了趟邻近的古镇，逛了老街，吃了碗当地的馄饨',
  '去爬了趟山，两个多小时登顶，出了一身汗，下山腿有点抖',
  '坐车去了海边，风很大，头发被吹乱，站了会儿就回来了',
  '去隔壁城市找表姐玩了一天，晚上才回来',
  '报了个一日的团去了郊外，看了片花田，拍了不少照片',
  '坐高铁去了趟外地，当天来回，累得不行',
]

/**
 * 日期 → 稳定的外出安排。
 *
 * 比例按用户口径：A 为主、B 经常、C 偶尔。
 *   用日期序号取模：0-4 → A，5-7 → B，8 → C（10 天里 5 天附近、3 天市区、1 天远门、1 天不出去）
 *
 * @param {string} dayKey YYYY-MM-DD
 * @returns {{kind:'none'|'nearby'|'city'|'trip', label:string, text:string, slot:string}}
 */
export function outingForDay(dayKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey ?? ''))
  if (!m) return { kind: 'none', label: '', text: '', slot: '' }
  const n = Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000)

  // 时段：外出多半在上午或下午
  const slot = n % 2 === 0 ? 'morning' : 'afternoon'

  const r = ((n % 10) + 10) % 10
  if (r <= 4) {
    const text = OUTING_NEARBY[hashKey(dayKey) % OUTING_NEARBY.length]
    return { kind: 'nearby', label: '附近', text, slot }
  }
  if (r <= 7) {
    const text = OUTING_CITY[hashKey(dayKey) % OUTING_CITY.length]
    return { kind: 'city', label: '市区', text, slot }
  }
  if (r === 8) {
    const text = OUTING_TRIP[hashKey(dayKey) % OUTING_TRIP.length]
    return { kind: 'trip', label: '出远门', text, slot }
  }
  // r === 9：这一天不出门
  return { kind: 'none', label: '', text: '', slot: '' }
}

/** 调试用：打印一段时间的外出安排。 */
export function describeOutings(startDate = new Date(), days = 14) {
  const out = []
  for (let i = 0; i < days; i++) {
    const d = new Date(startDate.getTime() + i * 86_400_000)
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const o = outingForDay(k)
    out.push(`${k}  ${o.label || '在家'}  ${o.text.slice(0, 40)}`)
  }
  return out.join('\n')
}