/** 验证联网搜索：触发判断 + 真实搜索 + 上下文拼装。 */
import { needsFreshInfo, webSearch, formatSearchContext } from '../src/gateway/search.js'
import { Credentials } from '../src/config/credentials.js'

let pass = 0, fail = 0
const check = (n, ok, extra = '') => {
  if (ok) { pass++; console.log('  ✅ ' + n) }
  else { fail++; console.log('  ❌ ' + n + ' ' + extra) }
}

console.log('=== 1. 触发判断（该搜的 vs 不该搜的）===')
const SHOULD = [
  'GPT-6 Luna 真的假的',
  '搜一下今天有什么新闻',
  '帮我查查 iPhone 18 什么时候发布',
  '最新版本更新了吗',
  '黑神话悟空出新DLC了吗',
  'GPT-6 是不是真的有',
]
const SHOULD_NOT = [
  '哈哈',
  '在吗',
  '今天中午吃什么',
  '这个怎么弄？',
  '笑死我了',
  '你真菜',
  '好的',
]
for (const t of SHOULD) {
  const r = needsFreshInfo(t)
  check(`该搜：「${t}」→ ${r.why || '(没触发)'}`, r.need === true)
}
for (const t of SHOULD_NOT) {
  const r = needsFreshInfo(t)
  check(`不该搜：「${t}」`, r.need === false, `(误判为 ${r.why})`)
}

console.log('\n=== 2. 真实搜索 ===')
const creds = new Credentials({ mode: 'overlay' })
const key = creds.get('DEEPSEEK_API_KEY')
const r = await webSearch({
  question: '黑神话悟空 最新消息',
  apiKey: key,
  maxUses: 2,
  timeoutMs: 30000,
  log: (m) => console.log('     ' + m),
})
check('搜索成功', r.ok, r.error || '')
check('拿到答案正文', (r.answer || '').length > 20, `${(r.answer || '').length} 字`)
check('拿到来源列表', (r.sources || []).length > 0, `${(r.sources || []).length} 个`)
if (r.ok) {
  console.log('     答案前 160 字: ' + JSON.stringify(r.answer.slice(0, 160)))
  console.log('     来源前 3:')
  for (const s of r.sources.slice(0, 3)) console.log('       - ' + s.title + ' | ' + s.url.slice(0, 60))
}

console.log('\n=== 3. 上下文拼装 ===')
const ctx = formatSearchContext(r)
check('拼出上下文', ctx.includes('刚联网查到'))
check('含"优先于你的训练记忆"', ctx.includes('优先于你的训练记忆'))

console.log('\n=== 4. 失败降级（不抛错）===')
const bad = await webSearch({ question: '测试', apiKey: 'sk-invalid-key-for-test', maxUses: 1, timeoutMs: 8000 })
check('无效 key 时安全返回 ok=false', bad.ok === false && typeof bad.error === 'string', JSON.stringify(bad.error))
check('失败时 formatSearchContext 返回空串', formatSearchContext(bad) === '')

console.log('\n' + '='.repeat(46))
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
