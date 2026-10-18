/**
 * 检查前端资源模块的语法与完整性。
 *
 * 为什么不能只 `new vm.Script(CLIENT_JS)`：
 *   `CLIENT_CSS` / `CLIENT_JS` 都是**模板字符串**。注释里混进一个裸反引号
 *   就会提前闭合模板、把后面的代码变成表达式，于是：
 *     · import 整个 assets.js 直接抛 SyntaxError（服务起不来）
 *     · 但单独拿 CLIENT_JS 去 vm.Script 时，拿到的只是"被截断的前半段"，
 *       语法反而是合法的 —— 检查形同虚设。
 *
 * 所以这里做三件事：
 *   1. 真的 import 一次模块（能暴露模板串被截断的问题）
 *   2. 扫描两个模板串的**范围**，确认中间没有裸反引号
 *   3. 再用 vm.Script 校验客户端 JS 本身
 */
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web', 'assets.js')
const text = fs.readFileSync(file, 'utf8')

let bad = false
const fail = (msg) => { bad = true; console.error('  ❌ ' + msg) }
const ok = (msg) => console.log('  ✅ ' + msg)

// ── 1. 模块能整体 import（最关键的一步）───────────────────────
let mod = null
try {
  mod = await import('file://' + file.replace(/\\/g, '/').replace(/ /g, '%20'))
  ok('assets.js 能作为模块加载')
} catch (e) {
  fail(`assets.js 加载失败 — ${e.message}`)
  console.error('     （模板字符串很可能被裸反引号截断了）')
}

// ── 2. 扫描模板串内部是否有裸反引号 ───────────────────────────
// 逐行数反引号：不在注释里的反引号只应出现在两个导出语句上。
const lines = text.split(/\r?\n/)
const starts = []
lines.forEach((l, i) => {
  if (/^export const (CLIENT_CSS|CLIENT_JS)\s*=\s*`/.test(l)) starts.push({ name: RegExp.$1, line: i })
})

if (starts.length !== 2) {
  fail(`没找到 CLIENT_CSS / CLIENT_JS 的定义（找到 ${starts.length} 个）`)
} else {
  const TICK = String.fromCharCode(96)   // 反引号（不在模板串里直接写，免得自己踩坑）
  for (const { name, line } of starts) {
    // 真正的闭合是一个**独占一行**的反引号。往后找到它，
    // 区间内任何反引号都会截断模板串。
    let close = -1
    for (let i = line + 1; i < lines.length; i++) {
      if (lines[i].trim() === TICK) { close = i; break }
    }
    if (close < 0) { fail(`${name} 找不到独占一行的闭合反引号`); continue }

    const offenders = []
    for (let i = line + 1; i < close; i++) {
      if (lines[i].includes(TICK)) offenders.push({ line: i + 1, text: lines[i].trim().slice(0, 70) })
    }
    if (offenders.length) {
      fail(`${name} 模板串内部有 ${offenders.length} 处反引号（会导致截断）：`)
      for (const o of offenders.slice(0, 5)) console.error(`       行 ${o.line}: ${o.text}`)
    } else {
      ok(`${name} 模板串完整（第 ${line + 1}–${close + 1} 行，内部无裸反引号）`)
    }
  }
}

// ── 3. 客户端 JS 本身可执行 ───────────────────────────────────
if (mod?.CLIENT_JS) {
  try {
    new vm.Script(mod.CLIENT_JS, { filename: 'whale-pod-client.js' })
    ok(`CLIENT_JS 语法正确（${mod.CLIENT_JS.length} 字符）`)
  } catch (e) {
    fail('CLIENT_JS 语法错误：' + e.message)
  }
}
if (mod?.CLIENT_CSS) {
  ok(`CLIENT_CSS 长度 ${mod.CLIENT_CSS.length}`)
  // CSS 里出现 JS 关键字通常意味着串错了
  if (/\bfunction\s+\w+\s*\(/.test(mod.CLIENT_CSS)) fail('CLIENT_CSS 里混进了 JS 代码')
}

console.log('')
if (bad) { console.error('client assets FAILED'); process.exit(1) }
console.log('client assets OK')
