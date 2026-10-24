/**
 * 重新打包 v0.2.5 并上传到 GitHub Release。
 *
 * 用法：node scripts/pack-release.mjs
 *
 * 为什么写这个脚本：上一版是手动打包的，没有可复现的流程。
 * 重发 Release 需要「同样的结构、同样的排除规则」，手打容易漏东西。
 *
 * 打包内容（对照旧 zip 的结构）：
 *   - 插件运行所需的源码（src/、plugin/）
 *   - package.json / README / LICENSE
 *   - 不包含：node_modules、.git、测试数据、个人配置、日志
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const REPO = 'D:/DSH WorkSpace/whale-pod'
const OUT_DIR = path.join(REPO, 'dist')
const ZIP = path.join(OUT_DIR, 'dsh-whale-pod-v0.2.5.zip')

fs.mkdirSync(OUT_DIR, { recursive: true })
if (fs.existsSync(ZIP)) fs.unlinkSync(ZIP)

/**
 * 用 git archive 打包 —— 比手写白名单可靠：
 * 它只包含**已提交**的文件，天然排除 node_modules、日志、个人配置，
 * 也保证包里的内容和某个 commit 严格对应。
 */
const commit = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
console.log(`打包 commit: ${commit.slice(0, 7)}`)

execFileSync('git', [
  '-C', REPO,
  'archive',
  '--format=zip',
  `--output=${ZIP}`,
  'HEAD',
], { stdio: ['ignore', 'inherit', 'inherit'] })

const size = fs.statSync(ZIP).size
console.log(`✓ ${ZIP}`)
console.log(`  ${(size / 1024).toFixed(0)} KB`)
