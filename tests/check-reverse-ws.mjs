/**
 * 反向 WS 测试：起一个 WhalePod 的 OneBot 客户端（reverse 模式），
 * 用客户端模拟「协议端连进来」，验证握手 + 事件 + 发消息。
 */
import http from 'node:http'
import crypto from 'node:crypto'
import { OneBotClient } from '../src/qq/onebot.js'

// 拦 _sendFrameTo 以捕获服务端发出的内容（测试需要验证 API 请求真的发出去了）
let _lastSent = null
const origSend = OneBotClient.prototype._sendFrameTo
OneBotClient.prototype._sendFrameTo = function (conn, opcode, payload) {
  if (opcode === 0x1) _lastSent = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload)
  return origSend.call(this, conn, opcode, payload)
}
const lastSentText = () => _lastSent

let pass = 0, fail = 0
const check = (n, c, e = '') => { if (c) { pass++; console.log(`  ✅ ${n}`) } else { fail++; console.log(`  ❌ ${n} ${e}`) } }

const PORT = 16199
const PATH = '/onebot/v11/ws'
const TOKEN = 'test-token-123'

console.log('=== 1. 起 WhalePod 的 reverse 服务端 ===')
const events = []
const client = new OneBotClient({
  mode: 'reverse',
  reverseHost: '127.0.0.1',
  reversePort: PORT,
  reversePath: PATH,
  accessToken: TOKEN,
  httpUrl: '',   // 强制走 WS
}, { log: { info: (m) => console.log('    [client] ' + m), warn: (m) => console.log('    [client WARN] ' + m), debug: () => {} } })

client.on('event', (ev) => events.push(ev))
client.on('open', () => console.log('    [client] open 事件'))
client.connect()
await new Promise((r) => setTimeout(r, 800))
check('服务端已监听', client.server !== null)

console.log('\n=== 2. 模拟协议端连接（无 token → 应被拒）===')
{
  const r = await rawConnect(PORT, PATH, null)
  check('无 token 被拒绝', r.status === 401 || r.error, JSON.stringify(r).slice(0, 120))
}

console.log('\n=== 3. 带正确 token 连接 ===')
{
  const conn = await rawConnect(PORT, PATH, TOKEN)
  check('握手成功（101）', conn.status === 101, JSON.stringify(conn).slice(0, 150))
  check('客户端标记已连接', client.connected === true)
  check('方向标记为 reverse', client.stats.direction === 'reverse')

  if (conn.socket) {
    console.log('\n=== 4. 协议端推一条群消息事件 ===')
    const ev = {
      post_type: 'message',
      message_type: 'group',
      group_id: 999,
      user_id: 111,
      message_id: 'm1',
      time: Math.floor(Date.now() / 1000),
      sender: { card: '小明', nickname: 'xm' },
      message: [
        { type: 'at', data: { qq: '10001' } },
        { type: 'text', data: { text: ' 在吗' } },
      ],
    }
    sendTextFrame(conn.socket, JSON.stringify(ev))
    await new Promise((r) => setTimeout(r, 400))
    check('收到事件', events.length === 1, String(events.length))
    check('事件内容正确', events[0]?.group_id === 999)
    check('统计 received 增加', client.stats.received >= 1)

    console.log('\n=== 5. 调 API（应通过反向连接发出并收到 echo 回包）===')
    const callPromise = client.call('get_login_info', {}, 3000)
    await new Promise((r) => setTimeout(r, 250))
    const sent = lastSentText()
    check('服务端发出了请求帧', typeof sent === 'string' && sent.includes('get_login_info'), String(sent).slice(0, 100))
    if (sent) {
      const req = JSON.parse(sent)
      sendTextFrame(conn.socket, JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 10001, nickname: 'WhalePod' }, echo: req.echo }))
      const res = await callPromise
      check('收到 API 回包', res?.data?.user_id === 10001, JSON.stringify(res))
    } else {
      await callPromise.catch(() => {})
      fail++
      console.log('  ❌ 无法验证 API 回包（没抓到请求帧）')
    }

    conn.socket.destroy()
  }
}

console.log('\n=== 6. 关闭清理 ===')
client.close()
await new Promise((r) => setTimeout(r, 300))
check('服务端已关闭', client.server === null)
check('反向连接已清理', client.serverSockets.size === 0)

console.log(`\n${'='.repeat(40)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)

// ── 测试辅助：手写 WS 客户端 ──────────────────────────────────
function rawConnect(port, path, token) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64')
    const headers = {
      connection: 'Upgrade', upgrade: 'websocket',
      'sec-websocket-key': key, 'sec-websocket-version': '13',
    }
    if (token) headers.authorization = `Bearer ${token}`
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET', headers })
    const timer = setTimeout(() => resolve({ error: 'timeout' }), 4000)
    req.on('upgrade', (res, socket) => {
      clearTimeout(timer)
      resolve({ status: res.statusCode, socket })
    })
    req.on('response', (res) => {
      clearTimeout(timer)
      res.resume()
      resolve({ status: res.statusCode })
    })
    req.on('error', (e) => { clearTimeout(timer); resolve({ error: e.message }) })
    req.end()
  })
}

function sendTextFrame(socket, text) {
  const data = Buffer.from(text, 'utf8')
  const len = data.length
  let header
  if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2) }
  else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2) }
  header[0] = 0x81

  const mask = crypto.randomBytes(4)
  const masked = Buffer.from(data)
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4]
  socket.write(Buffer.concat([header, mask, masked]))
}

function readFrames() { return null }
