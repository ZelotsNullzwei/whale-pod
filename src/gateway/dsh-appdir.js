/**
 * 找到 DSH 的安装目录（含 `@deepseek-ai/*` 的那一层）。
 *
 * ## 为什么单独成一个模块
 *
 * 这个函数原来住在 `gateway/llm-core.js` 里 —— 但那个模块是**宿主渠道包**
 * （channel-pack 的 14 个免费渠道）的装载器，2026-11-02 已经拆掉了。
 *
 * 而 `findDshAppDir` 跟渠道包**没有关系**：它只是"DSH 装在哪"，
 * 两个地方还要用：
 *   · `src/gateway/dsh-providers.js` —— 读 DSH 设置里的模型提供商
 *     （magpie 就是这条发现的，**必须留**）
 *   · `scripts/restart.mjs` —— 重启脚本要定位 DSH
 *
 * 所以把它抽出来，别跟着渠道包一起陪葬。
 *
 * ## 查找顺序
 *   1. 显式传参
 *   2. 环境变量 `DSH_APP_DIR`
 *   3. 常见安装位置（按平台）
 *   4. 从 dsh CLI 的位置反推
 *
 * ⚠️ 认的是 `<dir>/node_modules/@deepseek-ai/cordis` 这个**结构**，
 *    不是目录名 —— 安装位置随平台/版本变，写死路径很脆。
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * @param {string} [explicit] 显式指定（`--dsh-app`）
 * @returns {string|null}
 */
export function findDshAppDir(explicit) {
  const candidates = []
  if (explicit) candidates.push(explicit)
  if (process.env.DSH_APP_DIR) candidates.push(process.env.DSH_APP_DIR)

  const platform = process.platform
  if (platform === 'win32') {
    candidates.push('D:/DSH Desktop/resources/app')
    candidates.push('C:/Program Files/DSH Desktop/resources/app')
    const local = process.env.LOCALAPPDATA
    if (local) candidates.push(path.join(local, 'Programs', 'DSH Desktop', 'resources', 'app'))
  } else if (platform === 'darwin') {
    candidates.push('/Applications/DSH Desktop.app/Contents/Resources/app')
  } else {
    candidates.push('/opt/DSH Desktop/resources/app')
    candidates.push('/usr/lib/dsh-desktop/resources/app')
  }

  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, 'node_modules', '@deepseek-ai', 'cordis'))) return c
    } catch { /* ignore */ }
  }
  return null
}