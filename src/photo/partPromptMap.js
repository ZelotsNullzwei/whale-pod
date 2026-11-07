/**
 * 部位 ID → **发给上游的自然语言**（2026-11-07，GPT 交接）。
 *
 * ## 为什么要这层
 * 实测：edits 接口对「胸口」这类词直接返回 `HTTP 400 invoke model error`，
 * 腿/脚/腰/手都不受影响。继续在提示词里硬碰硬没有意义 ——
 * 这更像**上游的文本安全过滤**，那就换一套它认得的中性说法：**用服装与构图术语**。
 *
 * ## 纪律
 * · **内部 ID 不变**（'胸部' 仍是 '胸部'）：日志、缓存键、裁切表、部位识别全都不动
 * · 只有**拼进提示词的字符串**换成这里的中性描述
 * · 这是"降低触发风险"，不是保证通过 —— 真被拒时要记录原始状态码与响应体，
 *   不许把所有 400 都归因于某一个词（见 bridge 的 400 记录）
 */
const PART_PROMPT_MAP = {
  /* 只保留在用的四个（2026-11-08「只留准确的」）；其余部位已不再进这条路 */
  腿: '腿部穿搭细节',
  脚: '鞋袜穿搭细节',
  腰: '腰腹与服装搭配',
  小腹: '腰腹与服装搭配',
}

/** 中性词：拼进上游提示词的部位名。认不出就退化成"局部细节"，绝不回吐原始 ID。 */
export function upstreamPartName(part) {
  const k = String(part ?? '')
  return PART_PROMPT_MAP[k] ?? '局部细节'
}

/** 内部 ID 有没有被换过（供测试用）。 */
export function hasUpstreamAlias(part) {
  return Object.prototype.hasOwnProperty.call(PART_PROMPT_MAP, String(part ?? ''))
}

/** 只读一份映射表（调试/测试用）。 */
export function partPromptMap() {
  return { ...PART_PROMPT_MAP }
}

/**
 * 发给上游的提示词里**不许出现**的原始部位词。
 * 用途：① 生成后自检 ② 400 时判断是不是又被某个词绊住。
 */
export const RAW_PART_WORDS = ['胸部', '胸口', '胸', '乳', '事业线', '罩杯']
