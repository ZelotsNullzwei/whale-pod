/**
 * 服装搭配规则（2026-11-06）。
 *
 * ## 来源
 * ① 用户给的 B 站《半裙怎么搭？10年服装人4把干货喂你》字幕要点：
 *    · 宽窄关系没控制上 → 整个衣裙鞋的长短就不好看，腿脚的分量就大了
 *    · 配冷色也不好看
 *    · 裙子已经宽了，再配个大鞋子 → 下半身比例失衡
 *    · 有意识地强化下半身比例
 *    · 组合在一起要有**节奏感**；鞋子风格要统一
 *
 * ② 知乎《7个穿搭技巧;服饰搭配七大原则》(zhuanlan.zhihu.com/p/267103905)：
 *    · 提高腰线：高腰下装 + 上衣塞进去，腿能长 1/4；上衣长度在臀以上
 *    · 长裙压个子（重心下拉）；短裙/露脚踝更轻盈
 *    · **小个子公式是「上宽下窄」**：宽廓形放上半身（补肩窄），下装选修身/锥形；
 *      宽大 A 字长下装反而显臃肿
 *    · 包包要小（大包 + 长肩带把腰线拉低）；腋下包最合适
 *    · 避免累赘：超长喇叭裤裤脚堆积显笨重；七分锥形裤露脚踝更轻盈
 *    · **鞋子和下装同色系**：避免身体被切成三截，腿有顺延感
 *    · 短上衣别配低腰裤（腰长腿短）
 *    · 偏瘦的人宜横条/方格/大花，穿得丰满些更好看
 *
 * ## 这个模块怎么用
 * 出图时给模型一句**可执行的搭配约束**（不是"好看点"），因为这些细节
 * 模型不会自己想，画出来就上下都宽、颜色打架、长裙配高帮靴、三段分色。
 */

/** 这几条每张都给（短、不占地方）。 */
export const BASE_RULES = [
  '**上宽下窄**：宽松/有廓形的放上半身（针织衫、卫衣、开衫），下装选修身或直筒；**别上下都宽**',
  '**腰线看得见**：上衣塞进下装、或用短上衣配高腰，腰的位置抬到胸下两三指',
  '**鞋和下装同色系**：避免身体被切成三截（上装一色、裤一色、鞋又一色 → 显矮）',
  '**全身不超过三色**（含鞋包），主色占大面积，其余做点缀',
]

/**
 * 从衣服描述里推断版型，只在**容易出错的组合**上追加提示。
 * @param {string} outfit
 * @returns {string[]}
 */
export function pairingHints(outfit) {
  const o = String(outfit ?? '')
  const hints = []

  const wideBottom = /阔腿|宽松.*(裤|裙)|A字|伞裙|束脚/.test(o)
  const wideTop = /卫衣|宽松|开衫|大码|oversize|针织衫/.test(o)
  const longBottom = /长裤|长裙|过膝|到膝|直筒裤|阔腿裤|棉布长裤|直筒牛仔裤/.test(o)
  const bigShoe = /靴|高帮|厚底|运动鞋|老爹鞋/.test(o)
  const slimBottom = /直筒|锥形|修身|紧身|烟管/.test(o)

  if (wideTop && wideBottom) {
    hints.push('上身和下装都宽了 —— 把上衣前摆塞一角进腰里点出腰线，别上下一样宽')
  }
  if (longBottom && bigShoe) {
    hints.push('下装是长的，鞋就**别选高帮/大体积**；换浅口或露脚踝的，不然腿被压短（视频原话：配个大鞋子，下半身比例就失衡）')
  }
  if (wideBottom && bigShoe) {
    hints.push('下装已经很宽，鞋要**小而贴脚**（帆布鞋/浅口单鞋），别再加大鞋')
  }
  if (!slimBottom && !longBottom && /\w/.test(o)) {
    // 没有明确下装版型时不额外说，避免噪音
  }
  return hints
}

/**
 * 组装"这一张的搭配约束"。衣服为空时返回空串。
 * @param {string} outfit
 * @returns {string}
 */
export function pairingBlock(outfit) {
  if (!String(outfit ?? '').trim()) return ''
  const hints = pairingHints(outfit)
  const lines = ['**搭配要成立**（她是认真穿好才拍的，不是随手套上）：']
  for (const r of BASE_RULES) lines.push(`- ${r}`)
  for (const h of hints) lines.push(`- ⚠️ ${h}`)
  return lines.join('\n')
}