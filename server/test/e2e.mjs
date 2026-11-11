/**
 * 端到端测试：起一个真实服务进程，用真实 WebSocket 跑完整链路
 * 运行：node test/e2e.mjs
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const PORT = 3801
const BASE = `http://127.0.0.1:${PORT}`
const WS = `ws://127.0.0.1:${PORT}/ws`
const DB = path.join(__dirname, 'test-data.db')
const INVITE = 'test-invite-9f3a'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++
  console.log((cond ? '  ✅ ' : '  ❌ ') + name + (extra ? ` — ${extra}` : ''))
}

/* ---------- 起服务 ---------- */
if (fs.existsSync(DB)) fs.unlinkSync(DB)
const child = spawn('node', ['server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_FILE: DB, INVITE_CODE: INVITE, DISABLE_CAPTCHA: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
})
const serverLog = []
child.stdout.on('data', (d) => serverLog.push(d.toString()))
child.stderr.on('data', (d) => serverLog.push('[err] ' + d.toString()))

const cleanup = () => {
  try {
    child.kill('SIGTERM')
  } catch {}
  try { fs.rmSync(path.join(__dirname, 'images'), { recursive: true, force: true }) } catch {}
  for (const f of [DB, DB + '-wal', DB + '-shm']) {
    try {
      fs.existsSync(f) && fs.unlinkSync(f)
    } catch {}
  }
}
process.on('exit', cleanup)

async function waitHealth(timeoutMs = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/health`)
      if (r.ok) return await r.json()
    } catch {}
    await sleep(120)
  }
  throw new Error('服务没起来:\n' + serverLog.join(''))
}

/* ---------- HTTP 小工具 ---------- */
async function api(method, p, body, token) {
  const r = await fetch(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  let d = null
  try {
    d = await r.json()
  } catch {}
  return { status: r.status, data: d }
}

/* ---------- WS 小工具 ---------- */
function connectWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}?token=${token}`)
    const inbox = []
    const waiters = []
    ws.addEventListener('message', (ev) => {
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      // 先看有没有人在等这个类型
      const i = waiters.findIndex((w) => w.pred(msg))
      if (i >= 0) {
        const w = waiters.splice(i, 1)[0]
        clearTimeout(w.timer)
        w.resolve(msg)
      } else {
        inbox.push(msg)
      }
    })
    ws.addEventListener('open', () => resolve({ ws, wait, drain: () => inbox.splice(0), inbox }))
    ws.addEventListener('error', (e) => reject(new Error('ws 连接失败')))
    ws.addEventListener('close', (e) => {
      for (const w of waiters.splice(0)) {
        clearTimeout(w.timer)
        w.reject(new Error('ws closed: ' + e.code))
      }
    })

    /** 等一条满足条件的消息（先查历史收件箱） */
    function wait(predicate, timeoutMs = 4000) {
      const hit = inbox.findIndex(predicate)
      if (hit >= 0) {
        const msg = inbox.splice(hit, 1)[0]
        return Promise.resolve(msg)
      }
      return new Promise((res, rej) => {
        const w = { pred: predicate, resolve: res, reject: rej }
        w.timer = setTimeout(() => {
          const i = waiters.indexOf(w)
          if (i >= 0) waiters.splice(i, 1)
          rej(new Error('等待超时: ' + predicate.toString().slice(0, 60)))
        }, timeoutMs)
        waiters.push(w)
      })
    }
  })
}

/* ------------------------------------------------------------------ */
/*  测试正文                                                           */
/* ------------------------------------------------------------------ */

console.log('\n=== IM 端到端测试 ===\n')

const health = await waitHealth()
ok('服务启动', health.ok === true, JSON.stringify(health))

/* 1. 注册 */
const regA = await api('POST', '/api/auth/register', { phone: '13800000001', password: 'passw0rdA', name: '小A', invite: INVITE })
const regB = await api('POST', '/api/auth/register', { phone: '13800000002', password: 'passw0rdB', name: '小B', invite: INVITE })
ok('注册 A', regA.status === 200 && !!regA.data.token)
ok('注册 B', regB.status === 200 && !!regB.data.token)
ok('注册不返回密码哈希', !JSON.stringify(regA.data).includes('pass_hash'), JSON.stringify(regA.data.user))

const dup = await api('POST', '/api/auth/register', { phone: '13800000001', password: 'passw0rdA', invite: INVITE })
ok('重复注册被拒 409', dup.status === 409)

/* 2. 登录与校验 */
const badLogin = await api('POST', '/api/auth/login', { phone: '13800000001', password: 'wrongpass' })
ok('错误密码被拒 401', badLogin.status === 401)
const goodLogin = await api('POST', '/api/auth/login', { phone: '13800000001', password: 'passw0rdA', invite: INVITE })
ok('正确密码登录成功', goodLogin.status === 200 && !!goodLogin.data.token)

const noAuth = await api('GET', '/api/conversations')
ok('无 token 访问被拒 401', noAuth.status === 401)

const tokenA = regA.data.token
const tokenB = regB.data.token
const idA = regA.data.user.id
const idB = regB.data.user.id

/* 3. 建会话（双向去重） */
const c1 = await api('POST', '/api/conversations', { peerId: idB }, tokenA)
const c2 = await api('POST', '/api/conversations', { peerId: idA }, tokenB)
ok('建会话', c1.status === 200 && typeof c1.data?.conversationId === 'string' && c1.data.conversationId.startsWith('c_'), JSON.stringify(c1.data))
ok(
  '双向建会话是同一个（uniq_key）',
  !!c1.data?.conversationId && c1.data.conversationId === c2.data?.conversationId,
  c1.data?.conversationId
)
const convId = c1.data.conversationId

/* 4. WebSocket 实时收发 */
const A = await connectWs(tokenA)
const B = await connectWs(tokenB)
const helloA = await A.wait((m) => m.t === 'hello')
ok('WS 握手返回 hello', helloA.user.id === idA, helloA.user.name)
await B.wait((m) => m.t === 'hello')

A.ws.send(JSON.stringify({ t: 'send', convId, clientId: 'cli-001', body: '你好，在吗' }))
const ack = await A.wait((m) => m.t === 'ack')
ok('发送方收到 ack', ack.clientId === 'cli-001' && ack.message.body === '你好，在吗', `seq=${ack.message.seq}`)
ok('第一条 seq = 1', ack.message.seq === 1)

const recv = await B.wait((m) => m.t === 'message')
ok('对方实时收到', recv.message.body === '你好，在吗')
ok('对方收到的 seq 一致', recv.message.seq === ack.message.seq)

/* 5. 幂等：同一个 clientId 重发 */
A.ws.send(JSON.stringify({ t: 'send', convId, clientId: 'cli-001', body: '你好，在吗' }))
const dupAck = await A.wait((m) => m.t === 'ack' && m.duplicate === true)
ok('重复 clientId 不产生新消息', dupAck.message.seq === 1 && dupAck.duplicate === true)

/* 6. 对方回一条 */
B.ws.send(JSON.stringify({ t: 'send', convId, clientId: 'cli-B1', body: '在的' }))
const ackB = await B.wait((m) => m.t === 'ack')
ok('B 发送成功', ackB.message.seq === 2)
const recvA = await A.wait((m) => m.t === 'message' && m.message.seq === 2)
ok('A 实时收到 B 的消息', recvA.message.body === '在的')

/* 7. 已读回执 */
B.ws.send(JSON.stringify({ t: 'read', convId, seq: 2 }))
const readEvt = await A.wait((m) => m.t === 'read')
ok('A 收到已读回执', readEvt.userId === idB && readEvt.seq === 2)

/* 8. 离线补偿：B 下线，A 发消息，B 重连后拉增量 */
B.ws.close()
await sleep(300)
A.ws.send(JSON.stringify({ t: 'send', convId, clientId: 'cli-003', body: '你不在的时候发的' }))
await A.wait((m) => m.t === 'ack' && m.clientId === 'cli-003')

const B2 = await connectWs(tokenB)
await B2.wait((m) => m.t === 'hello')
const sync = await api('GET', `/api/conversations/${convId}/sync?since=2`, null, tokenB)
ok('离线消息可通过 sync 补回', sync.data.messages.length === 1 && sync.data.messages[0].body === '你不在的时候发的', JSON.stringify(sync.data.messages.map((m) => m.body)))
ok('补回的消息 seq = 3', sync.data.messages[0].seq === 3)

/* 9. 历史分页 */
const hist = await api('GET', `/api/conversations/${convId}/messages?limit=2`, null, tokenA)
ok('历史分页返回 2 条', hist.data.messages.length === 2)
ok('历史按 seq 升序', hist.data.messages[0].seq < hist.data.messages[1].seq, hist.data.messages.map((m) => m.seq).join(','))

/* 10. 会话列表带未读数 */
const listB = await api('GET', '/api/conversations', null, tokenB)
const convB = listB.data.conversations[0]
ok('会话列表有对方信息', convB.peer.id === idA, convB.peer?.name)
ok('未读数正确（B 已读到 2，第 3 条未读）', convB.unread === 1, 'unread=' + convB.unread)
ok('会话列表带最后一条消息', convB.lastMessage.body === '你不在的时候发的')

/* 11. 权限：第三人不能读别人的会话 */
const regC = await api('POST', '/api/auth/register', { phone: '13800000003', password: 'passw0rdC', name: '小C', invite: INVITE })
const peek = await api('GET', `/api/conversations/${convId}/messages`, null, regC.data.token)
ok('无关用户读会话被拒 403', peek.status === 403, 'status=' + peek.status)

/* 12. 参数校验 */
const empty = await api('POST', '/api/auth/register', { phone: '123', password: 'x', invite: INVITE })
ok('手机号格式校验 400', empty.status === 400)
const shortPass = await api('POST', '/api/auth/register', { phone: '13900000009', password: '123', invite: INVITE })
ok('密码长度校验 400', shortPass.status === 400)
A.ws.send(JSON.stringify({ t: 'send', convId, clientId: 'cli-empty', body: '   ' }))
const errMsg = await A.wait((m) => m.t === 'error')
ok('空消息被拒', errMsg.code === 400, errMsg.message)

/* 13. 未知指令 */
A.ws.send(JSON.stringify({ t: 'nonsense' }))
const errMsg2 = await A.wait((m) => m.t === 'error')
ok('未知指令返回错误', errMsg2.code === 400)

/* 14. 服务端统计 */
const h2 = await api('GET', '/api/health')
ok('统计正确（3 用户 / 1 会话 / 3 消息）', h2.data.users === 3 && h2.data.conversations === 1 && h2.data.messages === 3, JSON.stringify(h2.data))

/* 15. 邀请码 */
const noInvite = await api('POST', '/api/auth/register', { phone: '13800000077', password: 'passw0rdX', name: '陌生人' })
ok('不带邀请码注册被拒 403', noInvite.status === 403, JSON.stringify(noInvite.data))
const wrongInvite = await api('POST', '/api/auth/register', { phone: '13800000077', password: 'passw0rdX', invite: '猜的' })
ok('错误邀请码被拒 403', wrongInvite.status === 403)
const rightInvite = await api('POST', '/api/auth/register', { phone: '13800000077', password: 'passw0rdX', invite: INVITE })
ok('正确邀请码可注册', rightInvite.status === 200)

/* 16. 加密落盘验证（这条最要紧：不是看代码写了什么，是看磁盘上是什么） */
{
  const { DatabaseSync } = await import('node:sqlite')
  const raw = new DatabaseSync(DB, { readOnly: true })
  const rows = raw.prepare('SELECT body FROM messages').all()
  raw.close()
  ok('库里有数据可查', rows.length === 3, rows.length + ' 条')
  ok('磁盘上存的是密文（enc:v1: 前缀）', rows.every((r) => r.body.startsWith('enc:v1:')), rows[0]?.body.slice(0, 30) + '…')
  ok('磁盘上看不到任何明文', !rows.some((r) => r.body.includes('你好') || r.body.includes('在的')), '已加密')
  const sameBody = rows.filter((r) => r.body === rows[0].body).length
  ok('相同内容密文不同（每条独立 IV）', sameBody <= 1)
}

/* 17. 加密后 API 仍返回明文 */
const plainAgain = await api('GET', `/api/conversations/${convId}/messages?limit=10`, null, tokenA)
ok('API 返回解密后的明文', plainAgain.data.messages.some((m) => m.body === '你好，在吗'))
ok('会话列表的最后一条也已解密', (await api('GET', '/api/conversations', null, tokenA)).data.conversations[0].lastMessage.body === '你不在的时候发的')

/* 18. 图片消息 */
function multipart(filename, mime, data) {
  const boundary = '----testboundary' + Math.random().toString(36).slice(2)
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return { boundary, body: Buffer.concat([head, data, tail]) }
}

// 构造一个带 PNG 头的假图（服务端只校验 mime，不解析像素）
const FAKE_PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
  Buffer.from('这是一段用于测试的图片二进制内容'.repeat(20), 'utf8'),
])

async function upload(token, filename, mime, data) {
  const mp = multipart(filename, mime, data)
  const r = await fetch(BASE + '/api/upload', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': `multipart/form-data; boundary=${mp.boundary}` },
    body: mp.body,
  })
  return { status: r.status, data: await r.json().catch(() => null) }
}

const noAuthUpload = await upload('', 'a.png', 'image/png', FAKE_PNG)
ok('未登录不能上传 401', noAuthUpload.status === 401)

const badType = await upload(tokenA, 'a.exe', 'application/x-msdownload', Buffer.from('MZ'))
ok('不支持的类型被拒 415', badType.status === 415, badType.data?.error)

const up = await upload(tokenA, 'pic.png', 'image/png', FAKE_PNG)
ok('上传图片成功', up.status === 200 && /^[0-9a-f]{32}$/.test(up.data?.id || ''), up.data?.id)
ok('返回大小正确', up.data?.size === FAKE_PNG.length, `${up.data?.size} vs ${FAKE_PNG.length}`)

// 图片文件必须是加密的：磁盘上不该能找到 PNG magic
{
  const { DatabaseSync } = await import('node:sqlite')
  const raw = new DatabaseSync(DB, { readOnly: true })
  const meta = raw.prepare('SELECT * FROM images WHERE id = ?').get(up.data.id)
  raw.close()
  ok('图片元数据入库', !!meta && meta.mime === 'image/png')
  const imgPath = path.join(__dirname, 'images', up.data.id + '.enc')
  const rawBytes = fs.readFileSync(imgPath)
  const hasPngMagic = rawBytes.subarray(0, 8).toString('hex').startsWith('89504e47')
  ok('图片文件已加密（磁盘无 PNG 魔数）', !hasPngMagic, rawBytes.subarray(0, 8).toString('hex'))
  ok('加密后有 IV+tag 开销', rawBytes.length === FAKE_PNG.length + 28, `${rawBytes.length} = ${FAKE_PNG.length}+28`)
}

// 图片改成「id 即凭证」：不带 token 也能读（id 是 128 位随机串，猜不到），
// 这样 URL 不会因 token 变化而失效，浏览器能长期缓存。
const noTokenImg = await fetch(`${BASE}/api/images/${up.data.id}`)
ok('图片可按 id 直接读取 200', noTokenImg.status === 200)

// 带一个无效 token 仍然拒绝
const badTokenImg = await fetch(`${BASE}/api/images/${up.data.id}?token=deadbeef`)
ok('带无效 token 被拒绝 401', badTokenImg.status === 401)

const gotImg = await fetch(`${BASE}/api/images/${up.data.id}?token=${tokenB}`)
const gotBuf = Buffer.from(await gotImg.arrayBuffer())
ok('带 token 能取图 200', gotImg.status === 200)
ok('返回的字节和上传一致', gotBuf.equals(FAKE_PNG), `${gotBuf.length} 字节`)
ok('Content-Type 正确', gotImg.headers.get('content-type') === 'image/png')

const ghostImg = await fetch(`${BASE}/api/images/${'0'.repeat(32)}?token=${tokenB}`)
ok('不存在的图片 404', ghostImg.status === 404)

A.ws.send(JSON.stringify({ t: 'send', convId, clientId: 'cli-img', body: up.data.id, kind: 'image' }))
const ackImg = await A.wait((m) => m.t === 'ack' && m.clientId === 'cli-img')
ok('图片消息发送成功', ackImg.message.kind === 'image' && ackImg.message.body === up.data.id)
const recvImg = await B2.wait((m) => m.t === 'message' && m.message.kind === 'image')
ok('对方收到图片消息', recvImg.message.body === up.data.id)

A.ws.send(JSON.stringify({ t: 'send', convId, clientId: 'cli-ghost-img', body: '0'.repeat(32), kind: 'image' }))
const ghostErr = await A.wait((m) => m.t === 'error' && m.code === 400 && /附件|图片/.test(m.message))
ok('发不存在的图片被拒', ghostErr.code === 400, ghostErr.message)

/* 19. Web Push 订阅管理 */
const vapid = await api('GET', '/api/push/vapid')
ok('vapid 接口可访问', vapid.status === 200 && typeof vapid.data?.enabled === 'boolean', JSON.stringify(vapid.data))

const noAuthSub = await api('POST', '/api/push/subscribe', {
  endpoint: 'https://push.example.com/a',
  keys: { p256dh: 'BOrX', auth: 'yy' },
})
ok('未登录不能订阅 401', noAuthSub.status === 401)

const badSub = await api('POST', '/api/push/subscribe', { endpoint: 'https://push.example.com/a' }, tokenA)
ok('订阅数据不完整 400', badSub.status === 400, badSub.data?.error)

const SUB = { endpoint: 'https://push.example.com/abc123', keys: { p256dh: 'BOrXyZ'.repeat(8), auth: 'authauth' } }
const goodSub = await api('POST', '/api/push/subscribe', SUB, tokenA)
ok('订阅成功（1 台设备）', goodSub.status === 200 && goodSub.data?.devices === 1, JSON.stringify(goodSub.data))

const dupSub = await api('POST', '/api/push/subscribe', SUB, tokenA)
ok('重复订阅幂等，不重复计数', dupSub.status === 200 && dupSub.data?.devices === 1, 'devices=' + dupSub.data?.devices)

{
  const { DatabaseSync } = await import('node:sqlite')
  const raw = new DatabaseSync(DB, { readOnly: true })
  const row = raw.prepare('SELECT * FROM push_subs').get()
  raw.close()
  ok('订阅已入库', !!row && row.user_id === idA && row.endpoint === SUB.endpoint)
  ok('订阅记录了 UA', typeof row?.ua === 'string')
}

// 未配置 VAPID 时要优雅降级：不报错、不影响聊天
if (vapid.data.enabled === false) {
  ok('没配 VAPID 时推送关闭（不崩）', true, '服务仍在正常响应')
}

const unsub = await api('POST', '/api/push/unsubscribe', { endpoint: SUB.endpoint }, tokenA)
ok('取消订阅', unsub.status === 200 && unsub.data?.removed === 1)

const unsubAgain = await api('POST', '/api/push/unsubscribe', { endpoint: SUB.endpoint }, tokenA)
ok('重复取消不报错', unsubAgain.status === 200 && unsubAgain.data?.removed === 0)

/* 20. 群聊 */
const G = await api('POST', '/api/conversations', { type: 'group', name: '测试群', memberIds: [idB] }, tokenA)
ok('建群', G.status === 200 && G.data.type === 'group', G.data?.conversationId)
const groupId = G.data.conversationId
ok('群成员 2 人', G.data.members.length === 2)

A.ws.send(JSON.stringify({ t: 'send', convId: groupId, clientId: 'g1', body: '群里说话' }))
const gAck = await A.wait((m) => m.t === 'ack' && m.clientId === 'g1')
const gRecv = await B2.wait((m) => m.t === 'message' && m.message.convId === groupId)
ok('群消息实时送达', gRecv.message.body === '群里说话')

const addM = await api('POST', `/api/conversations/${groupId}/members`, { userId: regC.data.user.id }, tokenA)
ok('群主加人', addM.status === 200 && addM.data.members.length === 3)

const kick = await api('DELETE', `/api/conversations/${groupId}/members/${idA}`, null, regC.data.token)
ok('非群主不能踢人 403', kick.status === 403, kick.data?.error)

const leave = await api('DELETE', `/api/conversations/${groupId}/members/${regC.data.user.id}`, null, regC.data.token)
ok('自己可以退群', leave.status === 200 && leave.data.members.length === 2)

const oneOnOneKick = await api('DELETE', `/api/conversations/${convId}/members/${idA}`, null, tokenB)
ok('一对一不能移除成员 400', oneOnOneKick.status === 400)

/* 21. 搜索 */
A.ws.send(JSON.stringify({ t: 'send', convId: groupId, clientId: 'g2', body: '这条里有个关键词鲸鱼' }))
await A.wait((m) => m.t === 'ack' && m.clientId === 'g2')

const found = await api('GET', '/api/search?q=' + encodeURIComponent('鲸鱼'), null, tokenB)
ok('搜索命中', found.status === 200 && found.data.messages.length === 1, found.data?.messages?.length + ' 条')
ok('搜索结果带来源会话名', found.data.messages[0]?.convTitle === '测试群', found.data.messages[0]?.convTitle)

const notFound = await api('GET', '/api/search?q=' + encodeURIComponent('这个词不存在'), null, tokenB)
ok('搜不到返回空', notFound.data.messages.length === 0)

const peekSearch = await api('GET', '/api/search?q=' + encodeURIComponent('鲸鱼'), null, regC.data.token)
ok('搜不到自己不在的会话', peekSearch.data.messages.length === 0)

/* 22. 引用 + 撤回 */
A.ws.send(JSON.stringify({ t: 'send', convId: groupId, clientId: 'g3', body: '引用你那条', replyTo: gAck.message.id }))
const qAck = await A.wait((m) => m.t === 'ack' && m.clientId === 'g3')
ok('引用消息带摘要', qAck.message.reply && qAck.message.reply.body === '群里说话', JSON.stringify(qAck.message.reply))

B2.ws.send(JSON.stringify({ t: 'delete', messageId: qAck.message.id }))
const delErr = await B2.wait((m) => m.t === 'error')
ok('不能撤回别人的消息 403', delErr.code === 403, delErr.message)

A.ws.send(JSON.stringify({ t: 'delete', messageId: qAck.message.id }))
const delSelf = await A.wait((m) => m.t === 'message-deleted')
ok('撤回自己的消息', delSelf.messageId === qAck.message.id)
const delRecv = await B2.wait((m) => m.t === 'message-deleted' && m.messageId === qAck.message.id)
ok('对方收到撤回通知', !!delRecv)

const hist2 = await api('GET', `/api/conversations/${groupId}/messages?limit=50`, null, tokenA)
const deletedMsg = hist2.data.messages.find((m) => m.id === qAck.message.id)
ok('撤回后 body 已清空', deletedMsg && deletedMsg.deleted === true && deletedMsg.body === '', JSON.stringify(deletedMsg?.body))

A.ws.send(JSON.stringify({ t: 'send', convId: groupId, clientId: 'g4', body: '撤回那条不该被搜到' }))
const g4Ack = await A.wait((m) => m.t === 'ack' && m.clientId === 'g4')
A.ws.send(JSON.stringify({ t: 'delete', messageId: g4Ack.message.id }))
await A.wait((m) => m.t === 'message-deleted')
const afterDel = await api('GET', '/api/search?q=' + encodeURIComponent('不该被搜到'), null, tokenA)
ok('撤回的消息搜不到', afterDel.data.messages.length === 0)

/* 23. 语音与文件 */
async function uploadTyped(token, filename, mime, data, query) {
  const mp = multipart(filename, mime, data)
  const r = await fetch(BASE + '/api/upload' + (query || ''), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': `multipart/form-data; boundary=${mp.boundary}` },
    body: mp.body,
  })
  return { status: r.status, data: await r.json().catch(() => null) }
}

const voiceUp = await uploadTyped(tokenA, 'v.webm', 'audio/webm', Buffer.from('fake-voice-bytes'), '?kind=voice&duration=7')
ok('语音上传', voiceUp.status === 200 && voiceUp.data?.kind === 'voice' && voiceUp.data?.duration === 7, JSON.stringify(voiceUp.data))

const voiceMsg = await api('POST', `/api/conversations/${groupId}/read`, {}, tokenA).catch(() => null)
A.ws.send(JSON.stringify({ t: 'send', convId: groupId, clientId: 'v1', body: voiceUp.data.id, kind: 'voice' }))
const vAck = await A.wait((m) => m.t === 'ack' && m.clientId === 'v1')
ok('语音消息发送', vAck.message.kind === 'voice')
const vRecv = await B2.wait((m) => m.t === 'message' && m.message.kind === 'voice')
ok('对方收到语音', vRecv.message.body === voiceUp.data.id)

const fileUp = await uploadTyped(tokenA, '文档.pdf', 'application/pdf', Buffer.from('%PDF-1.4 fake'), '?kind=file&name=' + encodeURIComponent('文档.pdf'))
ok('文件上传（含中文名）', fileUp.status === 200 && fileUp.data?.kind === 'file' && fileUp.data?.name === '文档.pdf', JSON.stringify(fileUp.data))

const fileGet = await fetch(`${BASE}/api/images/${fileUp.data.id}?token=${tokenB}`)
ok('文件可下载', fileGet.status === 200 && fileGet.headers.get('content-type').startsWith('application/pdf'))

/* 24. 群会话在列表里的样子 */
const listAfter = await api('GET', '/api/conversations', null, tokenB)
const groupConv = listAfter.data.conversations.find((c) => c.id === groupId)
ok('会话列表识别群聊', groupConv?.type === 'group', groupConv?.type)
ok('群有标题和成员数', groupConv?.title === '测试群' && groupConv?.memberCount === 2, `${groupConv?.title} / ${groupConv?.memberCount}`)
ok('群成员带已读位置', Array.isArray(groupConv?.readSeqs) && groupConv.readSeqs.length === 2)

/* 收尾 */
A.ws.close()
B2.ws.close()
await sleep(200)

console.log(`\n通过 ${pass} / 失败 ${fail}\n`)
if (fail > 0) {
  console.log('--- 服务端日志 ---')
  console.log(serverLog.join(''))
}
cleanup()
process.exit(fail ? 1 : 0)