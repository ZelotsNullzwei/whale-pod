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
  return findDshResources(explicit).appDir
}

/**
 * ★ 找到 DSH 的安装资源，**两种形态都认**（2026-11-02 加）。
 *
 * ## 为什么要分开
 * DSH 的安装形态变过：
 * ```
 * 旧：<安装>/resources/app/          ← 普通目录（能直接 import 里面的包）
 * 新：<安装>/resources/app.asar      ← 一个 190MB 的包（普通 Node 读不了）
 * ```
 * 老代码只看第一种，于是新版 DSH 一来就返回 null ——
 * 后果是 **`appDir` 为空 → 图片支持整段被跳过、一个字都不打**。
 *
 * 所以这里**两种都找**，并告诉调用方是哪种形态：
 *   · `appDir` —— 普通目录（旧布局）
 *   · `asar`   —— asar 文件（新布局；要用 `dsh-modules.js` 先提取才能 import）
 * 两个都可能为 null（没装 DSH）。
 *
 * ## 判据认「结构」，不认产品名
 * 旧版判据是 `<dir>/node_modules/@deepseek-ai/cordis` 存在 —— 认的是结构 ✓
 * 新版同理：`<resources>/app.asar` 存在即可。
 * 候选里带 `DSH Next` 只是**兜底猜测**；真正的来源是 `DSH_APP_DIR` 环境变量。
 *
 * @param {string} [explicit]
 * @returns {{appDir:string|null, asar:string|null, resources:string|null}}
 */
export function findDshResources(explicit) {
  const candidates = []
  if (explicit) candidates.push(explicit)
  if (process.env.DSH_APP_DIR) candidates.push(process.env.DSH_APP_DIR)

  const platform = process.platform
  if (platform === 'win32') {
    candidates.push('D:/DSH Desktop/resources/app')
    candidates.push('D:/DSH Next/resources/app')
    candidates.push('C:/Program Files/DSH Desktop/resources/app')
    candidates.push('C:/Program Files/DSH Next/resources/app')
    const local = process.env.LOCALAPPDATA
    if (local) {
      candidates.push(path.join(local, 'Programs', 'DSH Desktop', 'resources', 'app'))
      candidates.push(path.join(local, 'Programs', 'DSH Next', 'resources', 'app'))
    }
  } else if (platform === 'darwin') {
    candidates.push('/Applications/DSH Desktop.app/Contents/Resources/app')
    candidates.push('/Applications/DSH Next.app/Contents/Resources/app')
  } else {
    candidates.push('/opt/DSH Desktop/resources/app')
    candidates.push('/usr/lib/dsh-desktop/resources/app')
  }

  /*
   * 逐个候选看两种形态。
   *
   * ⚠️ 候选可能是 ① 直接的 `app` 目录 ② 它的**上一级**（`resources/`）——
   *    用户用 `--dsh-app` 时两种都可能传。所以每一层都试。
   */
  for (const c of candidates) {
    for (const base of [c, path.dirname(c)]) {
      // 旧布局：目录里有 @deepseek-ai/cordis
      try {
        if (fs.existsSync(path.join(base, 'node_modules', '@deepseek-ai', 'cordis'))) {
          return { appDir: base, asar: null, resources: path.dirname(base) }
        }
      } catch { /* ignore */ }
      // 新布局：同级有 app.asar
      try {
        const asar = path.join(base, 'app.asar')
        if (fs.existsSync(asar)) return { appDir: null, asar, resources: base }
      } catch { /* ignore */ }
    }
  }
  return { appDir: null, asar: null, resources: null }
}