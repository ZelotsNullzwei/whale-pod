/**
 * 实测：自带 uv 链路能否跑通（下载 uv → 用它装 Python 3.12）。
 * 这是「AstrBot 能内置」的关键验证。
 *
 * 用法：node tests/check-runtime.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import * as rt from '../src/qq/runtime.js'

const HOME = path.join(os.homedir(), '.whale-pod')
const STEP = process.argv[2] ?? 'all'

let pass = 0
let fail = 0
const check = (n, c, e = '') => { if (c) { pass++; console.log('  ✅ ' + n) } else { fail++; console.log('  ❌ ' + n + ' ' + e) } }

console.log('=== 0. 环境 ===')
console.log('  数据目录:', HOME)
console.log('  平台资产:', JSON.stringify(rt.uvAssetFor()))

console.log('\n=== 1. uv 现状 ===')
let uv = await rt.findUv(HOME)
console.log('  找到 uv:', uv ? uv.exe + ' (' + uv.source + ')' : '无')
check('uv 资产映射可用', true)

if (STEP === 'download' || STEP === 'all') {
  if (!uv) {
    console.log('\n=== 2. 下载自带 uv（约 14.6 MB）===')
    const t0 = Date.now()
    let lastPct = -1
    try {
      const r = await rt.installUv({
        home: HOME,
        proxy: process.env.HTTPS_PROXY || undefined,
        onProgress: (m) => {
          const m2 = /(\d+)%/.exec(m)
          if (m2) {
            const p = Number(m2[1])
            if (p !== lastPct && p % 20 === 0) { lastPct = p; console.log('    ' + m) }
          } else if (!/^\d+%/.test(m)) {
            console.log('    ' + m)
          }
        },
      })
      console.log('  ✅ uv 安装完成:', r.version, `（${((Date.now() - t0) / 1000).toFixed(1)}s）`)
      pass++
    } catch (e) {
      console.log('  ❌ uv 安装失败:', String(e.message).slice(0, 300))
      fail++
    }
    uv = await rt.findUv(HOME)
  } else {
    console.log('  （uv 已存在，跳过下载）')
    const v = await rt.runCapture(uv.exe, ['--version'], { env: rt.uvEnv(HOME) })
    console.log('  版本:', v.trim())
  }
}

check('uv 可用', Boolean(uv), uv ? '' : '未找到')

if (uv && (STEP === 'python' || STEP === 'all')) {
  console.log('\n=== 3. 让 uv 装 Python 3.12（它自己下载，不碰系统）===')
  const t0 = Date.now()
  try {
    const r = await rt.ensurePython({
      home: HOME,
      pythonVersion: '3.12',
      onProgress: (m) => console.log('    ' + m.slice(0, 160)),
    })
    console.log(`  ✅ Python ${r.version} ${r.already ? '已存在' : '安装完成'}（${((Date.now() - t0) / 1000).toFixed(1)}s）`)
    pass++
  } catch (e) {
    console.log('  ❌ Python 安装失败:', String(e.message).slice(0, 400))
    fail++
  }
}

console.log('\n=== 4. uv 环境概况 ===')
try {
  const st = await rt.uvStatus(HOME)
  console.log('  uv:', JSON.stringify(st.uv))
  console.log('  Python:', st.python.join(' | ') || '(无)')
  console.log('  工具:', st.tools.join(' | ') || '(无)')
  console.log('  目录:')
  for (const [k, v] of Object.entries(st.dirs)) {
    const exists = fs.existsSync(v)
    let size = ''
    if (exists) {
      try {
        const mb = dirSize(v) / 1024 / 1024
        size = ' (' + mb.toFixed(1) + ' MB)'
      } catch { /* ignore */ }
    }
    console.log(`    ${k.padEnd(8)} ${exists ? '✅' : '—'}${size}  ${v}`)
  }
  check('自带的 Python 已就位', st.python.length > 0, st.python.join(','))
} catch (e) {
  console.log('  ❌', e.message)
  fail++
}

console.log(`\n${'='.repeat(44)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)

function dirSize(d) {
  let n = 0
  const walk = (p) => {
    for (const it of fs.readdirSync(p, { withFileTypes: true })) {
      const q = path.join(p, it.name)
      if (it.isDirectory()) walk(q)
      else { try { n += fs.statSync(q).size } catch { /* ignore */ } }
    }
  }
  try { walk(d) } catch { /* ignore */ }
  return n
}
