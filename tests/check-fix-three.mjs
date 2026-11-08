/**
 * 21:20 三修验证（用户：都修吧，你顺便测试）。
 * 1) 空消息不发  2) 说说一律摘下走确认  3) 发色/标志物末尾锁
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { QQBridge } from '../src/qq/bridge.js'

const flat = fs.readFileSync('D:/DSH WorkSpace/whale-pod/src/qq/bridge.js', 'utf8').split(String.fromCharCode(13)).join('')

let pass = 0
let fail = 0
function ok(name, fn) {
  try { fn(); console.log('  OK  ' + name); pass++ }
  catch (e) { console.log('  XX  ' + name + '\n      ' + e.message); fail++ }
}

console.log('=== 1. empty message guard ===')
ok('source has __emptyGuard', () => assert.match(flat, /__emptyGuard/))
ok('_send("") returns [] and sends nothing', async () => {
  const sent = []
  const fake = {
    log: { warn: () => {}, info: () => {} },
    onebot: { _sendPreferHttp: async (a) => { sent.push(a); return { status: 'ok' } } },
    selfId: '1', selfName: 'x', cfg: { home: 'C:/tmp' },
  }
  const r = await QQBridge.prototype._send.call(fake, { scope: 'private:1', kind: 'private', userId: '1' }, '   ', null)
  assert.deepEqual(r, [])
  assert.equal(sent.length, 0)
})

console.log('\n=== 2. qzone always deferred (cannot bypass) ===')
ok('no const hasAny = branch left', () => assert.ok(!/const hasAny =/.test(flat)))
ok('interception is unconditional if (qItem)', () => {
  const i = flat.indexOf("const qItem = marks.items.find((x) => x.id === 'qzone')")
  assert.ok(i > 0)
  const seg = flat.slice(i, i + 300)
  assert.match(seg, /if \(qItem\) \{/)
  assert.match(seg, /marks\.items\.filter/)
})
ok('confirm path still wired', () => assert.match(flat, /_askQzoneConfirm\(pq\)/))

console.log('\n=== 3. appearance lock at tail ===')
const { planShot } = await import(pathToFileURL('D:/DSH WorkSpace/whale-pod/src/photo/index.js').href)
const cfg = JSON.parse(fs.readFileSync('C:/Users/Null_zwei/.dsh/whale-pod/config.json', 'utf8')).qq.image
ok('person image has appearance lock', () => {
  const r = planShot({ scene: '坐在床边自拍', slot: 'evening', outfit: '白色大码衬衫当外套，浅灰家居短裤', hair: '披着', scope: 't1', mode: 'daily', imageCfg: cfg })
  const p = String(r.prompt ?? '')
  assert.match(p, /蓝色长卷发/)
  assert.match(p, /不要黑发/)
})
ok('scene-only has no appearance lock', () => {
  const r = planShot({ scene: '书桌上的台灯和书', slot: 'evening', scope: 't2', sceneOnly: true, mode: 'daily', imageCfg: cfg })
  assert.ok(!/不要黑发/.test(String(r.prompt ?? '')))
})

console.log('\npass ' + pass + ' / fail ' + fail)
process.exit(fail === 0 ? 0 : 1)
