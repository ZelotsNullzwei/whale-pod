/**
 * 打包到 dist/，供 GitHub Release 上传。
 *
 * 用法：
 *   node scripts/pack-release.mjs          # 用 package.json 的 version
 *   node scripts/pack-release.mjs 0.3.0    # 指定版本号
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

// ⚠️ 版本号不要写死。写死过一次（v0.2.5），下次升级漏改就会
//    产出「0.3.0 的代码、0.2.5 的文件名」，人和脚本都会被误导。
const PKG = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))
const VERSION = String(process.argv[2] ?? PKG.version).replace(/^v/, '')
const ZIP = path.join(OUT_DIR, `dsh-whale-pod-v${VERSION}.zip`)

fs.mkdirSync(OUT_DIR, { recursive: true })
if (fs.existsSync(ZIP)) fs.unlinkSync(ZIP)
console.log(`版本：v${VERSION}`)

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
