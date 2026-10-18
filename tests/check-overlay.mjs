// 验证 overlay：模拟续期写入，确认只写 ~/.whale-pod，DSH 文件不变。
import fs from 'node:fs'
import crypto from 'node:crypto'
import { Credentials } from '../src/config/credentials.js'

const DSH = 'C:/Users/TestUser/.dsh/.credentials.yaml'
const OV = 'C:/Users/TestUser/.whale-pod/credentials-overlay.json'

const hash = (p) => fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16) : '(不存在)'

console.log('=== 写入前 ===')
console.log('  DSH  hash:', hash(DSH))
console.log('  OV   hash:', hash(OV))

const creds = new Credentials()
console.log('  refs:', creds.listRefs().length)

console.log('\n=== 模拟 pack.js 续期：写一个新的凭据 ===')
// ⚠️ 不要写死 ref 名。原来用的是 GEMINI_ACCOUNT_A8AA3E4F，但那个 ref 会
//    随用户的凭据文件变化而消失，测试就报 "undefined is not valid JSON"。
//    改成从现有 ref 里挑一个 JSON 形态的来测，测不到就明确跳过。
const targetRef = creds.listRefs().find((r) => {
  const v = creds.getRepaired(r)
  if (!v) return false
  try { JSON.parse(v); return true } catch { return false }
})

if (!targetRef) {
  console.log('  ⚠️ 没有 JSON 形态的凭据可用于测试，跳过写入验证。')
  console.log('  （这只说明本机凭据文件里没有可解析的 JSON ref，不是代码问题）')
} else {
  console.log('  使用 ref:', targetRef)
  const original = creds.getRepaired(targetRef)
  const parsed = JSON.parse(original)
  parsed.access_token = 'TEST_TOKEN_WRITTEN_BY_GUARDIAN'
  parsed.expiry = new Date(Date.now() + 3600_000).toISOString()

  await creds.set(targetRef, JSON.stringify(parsed))
  console.log('  写入完成')

  console.log('\n=== 写入后 ===')
  console.log('  DSH  hash:', hash(DSH), '(应不变)')
  console.log('  OV   hash:', hash(OV), '(应变化)')

  console.log('\n=== 读取验证（overlay 优先）===')
  const c2 = new Credentials()
  const v = c2.get(targetRef)
  console.log('  读到的 access_token:', String(v.access_token).slice(0, 40))
  console.log('  来自 overlay:', c2.isFromOverlay(targetRef))
  console.log('  预期: TEST_TOKEN_WRITTEN_BY_GUARDIAN')

  console.log('\n=== 其它 ref 仍然可读（来自 DSH 文件）===')
  for (const r of c2.listRefs().slice(0, 6)) {
    const val = c2.getRaw(r)
    console.log(`  ${r}: ${val ? String(val).slice(0, 30) + '…' : '❌'}`)
  }

  console.log('\n=== 清理测试数据（恢复原值）===')
  fs.rmSync(OV, { force: true })
  console.log('  已删除 overlay 文件')
  const c3 = new Credentials()
  console.log('  再读 access_token:', String(c3.get(targetRef).access_token).slice(0, 30))
  console.log('  DSH  hash:', hash(DSH), '(始终未变)')
}
