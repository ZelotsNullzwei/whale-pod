/**
 * 运行模式与互斥规则。
 *
 * ## 为什么需要「模式」
 *
 * QQ 侧的链路是：`NapCat（协议端）→ OneBot v11 → 机器人框架 → LLM`
 *
 * 中间那个「机器人框架」只能有**一个** —— 两个都去连 NapCat 的同一个
 * OneBot 端点，会互相抢事件、抢回包，表现为时而回两次、时而不回。
 * 所以框架必须二选一，这就是「模式」：
 *
 *   mode = 'whale-pod'  WhalePod 自己当框架（内置人格/记忆/决策）
 *   mode = 'astrbot'   AstrBot 当框架（换它的 1000+ 插件生态）
 *
 * 两种模式下 **WhalePod 都在跑**：它要么当框架，要么当 LLM 网关。
 *
 * ## 每个模式里各组件的位置
 *
 * ```
 * mode = whale-pod
 *   NapCat ──OneBot──► WhalePod.bridge ──► WhalePod.gateway ──► 免费渠道
 *                       （人格/记忆/决策都在这里）
 *
 * mode = astrbot
 *   NapCat ──OneBot──► AstrBot ──► WhalePod.gateway ──► 免费渠道
 *                                  （AstrBot 的 api_base 指向这里）
 * ```
 *
 * 注意第二种模式下 WhalePod 的角色变成**纯 LLM 网关**：不接 OneBot、
 * 不跑决策层，只提供 `/v1/chat/completions`。这样免费渠道的省钱效果
 * 依然由 WhalePod 提供，而聊天逻辑交给 AstrBot 的插件生态。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 可选的运行模式。 */
export const MODES = {
  'whale-pod': {
    id: 'whale-pod',
    name: 'WhalePod 独立模式',
    summary: 'WhalePod 自己充当机器人框架：内置人格、记忆、决策层，不依赖 Python。',
    framework: 'whale-pod',
    needsAstrBot: false,
    pros: ['零额外运行时（不需要 Python）', '人格/记忆/决策一体化', '安装体积最小'],
    cons: ['没有 AstrBot 那 1000+ 插件生态'],
  },
  astrbot: {
    id: 'astrbot',
    name: 'AstrBot 框架模式（未完善）',
    summary: 'AstrBot 充当机器人框架，WhalePod 退居为 LLM 网关。⚠️ 框架已有，但尚未在真机跑通验证。',
    framework: 'astrbot',
    needsAstrBot: true,
    /** 未完善的模式：UI 据此标警示、切换时给二次确认。 */
    incomplete: true,
    /** 切换前的提示语（incomplete 为 true 时展示）。 */
    incompleteNote: '这个模式的代码架子是完整的，但从未被验证跑通过：initArgs 未调用、启动后不做就绪校验、OneBot 对接按 NapCat 的逻辑推的。切过去大概率用不了，建议先用 whale-pod 模式。',
    pros: ['代码骨架完整（安装/启停/模式切换都已实现）', '自带 uv + Python，不用系统装 Python'],
    cons: [
      '⚠️ 未在真机验证，当前不可用',
      '需要 Python 3.12（约 95 MB）',
      '两套配置（AstrBot 里要填本网关地址）',
    ],
  },
}

/** 列出所有模式（供 Web UI）。 */
export function listModes() {
  return Object.values(MODES)
}

/**
 * 校验模式切换是否安全。
 *
 * 切换模式涉及「谁连 OneBot」，所以要做冲突检查：
 *   切到 astrbot   → 必须先停掉 WhalePod 的桥接
 *   切回 whale-pod  → 必须先停掉 AstrBot
 *
 * @param {object} opts
 * @param {string} opts.from       当前模式
 * @param {string} opts.to         目标模式
 * @param {boolean} opts.bridgeRunning   WhalePod 桥接是否在跑
 * @param {boolean} opts.astrbotRunning  AstrBot 是否在跑
 * @returns {{ok:boolean, steps:string[], warning?:string}}
 */
export function planModeSwitch(opts) {
  const { from, to, bridgeRunning, astrbotRunning } = opts
  if (!MODES[to]) return { ok: false, steps: [], warning: `未知模式：${to}` }
  if (from === to) return { ok: true, steps: [], warning: '已经是该模式，无需切换' }

  const steps = []
  // 1. 先把当前占着 OneBot 的一方停掉
  if (from === 'astrbot' && astrbotRunning) steps.push('停止 AstrBot（它当前连着 OneBot）')
  if (from === 'whale-pod' && bridgeRunning) steps.push('停止 WhalePod 桥接（它当前连着 OneBot）')

  // 2. 准备好目标模式需要的东西
  if (to === 'astrbot') steps.push('确认 AstrBot 已安装（未装则需先安装，约 95 MB）')
  steps.push('切换配置里的 qq.mode')
  steps.push(to === 'astrbot' ? '启动 AstrBot' : '启动 WhalePod 桥接')
  if (to === 'astrbot') {
    steps.push('把 AstrBot 的 API 地址指向本网关（WhalePod 会给出一条可直接复制的配置）')
  }

  // 目标模式未完善时，把警告放在最前面 —— 用户应该先看到这个，再决定要不要点。
  const target = MODES[to]
  const warning = target.incomplete === true
    ? `⚠️ ${target.name}：${target.incompleteNote}`
    : '切换期间 QQ 会短暂掉线（几秒）。两个框架不能同时连同一个 OneBot 端点。'

  return { ok: true, steps, warning }
}

/**
 * 生成给 AstrBot 用的「接入本网关」提示。
 *
 * AstrBot 的 provider 配置只需要 api_key + api_base 两个字段（已实测），
 * 所以这里直接给出可复制的值，省得用户去猜。
 */
export function astrbotGatewayHint(gatewayCfg) {
  const host = gatewayCfg?.host === '0.0.0.0' ? '127.0.0.1' : (gatewayCfg?.host ?? '127.0.0.1')
  const port = gatewayCfg?.port ?? 18899
  return {
    apiBase: `http://${host}:${port}/v1`,
    apiKey: gatewayCfg?.key ?? '',
    modelSuggest: 'auto',
    steps: [
      'AstrBot 控制台 → 服务提供商 → 新增 → OpenAI 兼容',
      `API Base URL 填：http://${host}:${port}/v1`,
      'API Key 填：本网关的 key（点上面的复制按钮）',
      '模型名填 auto（让 WhalePod 按免费优先策略自动选）',
      '保存后设为默认对话模型',
    ],
  }
}

/** 检查运行前提：模式需要的组件是否就绪。 */
export function checkModeReadiness(mode, ctx = {}) {
  const m = MODES[mode]
  if (!m) return { ok: false, missing: ['未知模式'] }
  const missing = []
  if (m.needsAstrBot && !ctx.astrbotInstalled) missing.push('AstrBot（约 95 MB，含自带 Python）')
  if (!ctx.protocolInstalled) missing.push('NapCat 协议端')
  return { ok: missing.length === 0, missing }
}
