/**
 * IM 服务端：HTTP REST + WebSocket 实时
 *
 * 部署目标：VPS（不是本机常驻）
 * 运行：node server.mjs
 *
 * WebSocket 协议（JSON 行）
 *   客户端 → 服务端
 *     {t:'send', convId, clientId, body, kind?}
 *     {t:'read', convId, seq}
 *     {t:'typing', convId}
 *     {t:'ping'}
 *   服务端 → 客户端
 *     {t:'hello', user, serverTime}
 *     {t:'message', message}
 *     {t:'ack', clientId, message, duplicate}
 *     {t:'read', convId, userId, seq}
 *     {t:'typing', convId, userId}
 *     {t:'error', code, message}
 *     {t:'pong'}
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import * as store from './db.mjs'
import * as push from './push.mjs'
import * as captcha from './captcha.mjs'
import { Hub } from './hub.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(__dirname, 'public')
const PORT = Number(process.env.PORT || 4000)
const HOST = process.env.HOST || '127.0.0.1' // 生产放反代后面，只监听本机
const hub = new Hub()
push.initPush()

/* ------------------------------------------------------------------ */
/*  HTTP 工具                                                          */
/* ------------------------------------------------------------------ */

const CORS = {
  'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS'
}

function json(res, code, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...CORS
  })
  res.end(body)
}

function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > limit) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(Object.assign(new Error('JSON 格式不对'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

function tokenOf(req) {
  const h = req.headers.authorization || ''
  const m = h.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : null
}

function requireUser(req) {
  const user = store.userByToken(tokenOf(req))
  if (!user) throw store.statusError(401, '未登录或登录已过期')
  return user
}

/** 管理员专用：权限不够直接 403 */
function requireAdmin(req) {
  const user = requireUser(req)
  if (!store.isAdmin(user.id)) throw store.statusError(403, '需要管理员权限')
  return user
}

/* ------------------------------------------------------------------ */
/*  静态文件（极简客户端就一个 index.html）                            */
/* ------------------------------------------------------------------ */

const MIME = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  ico: 'image/x-icon',
  webmanifest: 'application/manifest+json'
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname
  let decoded
  try {
    decoded = decodeURIComponent(rel)
  } catch {
    return false
  }
  // 防路径穿越：解析后必须仍在 public 目录内
  let fp = path.resolve(PUBLIC_DIR, '.' + decoded)
  if (fp !== PUBLIC_DIR && !fp.startsWith(PUBLIC_DIR + path.sep)) return false
  try {
    if (!fs.existsSync(fp)) return false
    // 访问目录时自动用里面的 index.html
    if (fs.statSync(fp).isDirectory()) {
      const idx = path.join(fp, 'index.html')
      if (!fs.existsSync(idx)) return false
      fp = idx
    }
  } catch {
    return false
  }
  const ext = path.extname(fp).slice(1).toLowerCase()

  let stat
  try { stat = fs.statSync(fp) } catch { return false }

  // 用「大小 + 修改时间」做 ETag：内容没变就回 304，只传几百字节
  const etag = 'W/"' + stat.size.toString(16) + '-' + Math.floor(stat.mtimeMs).toString(16) + '"'
  const inm = req.headers['if-none-match']
  if (inm && inm === etag) {
    res.writeHead(304, {
      ETag: etag,
      'Cache-Control': 'no-cache'
    })
    res.end()
    return true
  }

  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    ETag: etag,
    // no-cache = 可以缓存，但每次都来问一句；配 ETag 就能命中 304
    'Cache-Control': 'no-cache'
  })
  fs.createReadStream(fp).pipe(res)
  return true
}

/* ------------------------------------------------------------------ */
/*  multipart 解析（手写，不引 multer）                                */
/* ------------------------------------------------------------------ */

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(Object.assign(new Error('文件太大'), { status: 413 }))
        req.destroy()
      } else {
        chunks.push(c)
      }
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * 必须收 Buffer，不能用字符串拼接——用字符串会把二进制图片写坏，
 * 而且坏得很隐蔽：文件大小对、能存进去、打开是花的。
 */
function parseMultipart(buf, boundary) {
  const delim = Buffer.from('--' + boundary)
  const parts = []
  let idx = buf.indexOf(delim)
  while (idx !== -1) {
    const start = idx + delim.length
    if (buf.slice(start, start + 2).toString() === '--') break
    const next = buf.indexOf(delim, start)
    if (next === -1) break
    let chunk = buf.slice(start, next)
    if (chunk.slice(0, 2).toString() === '\r\n') chunk = chunk.slice(2)
    if (chunk.slice(-2).toString() === '\r\n') chunk = chunk.slice(0, -2)
    const sep = chunk.indexOf('\r\n\r\n')
    if (sep !== -1) {
      const header = chunk.slice(0, sep).toString('utf8')
      const fileM = header.match(/filename="([^"]*)"/i)
      const typeM = header.match(/content-type:\s*([^\r\n]+)/i)
      parts.push({
        filename: fileM ? fileM[1] : null,
        type: typeM ? typeM[1].trim().toLowerCase() : 'application/octet-stream',
        data: chunk.slice(sep + 4)
      })
    }
    idx = next
  }
  return parts
}

/* ------------------------------------------------------------------ */
/*  HTTP 路由                                                          */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const pathname = url.pathname.replace(/\/+$/, '') || '/'
  const method = req.method.toUpperCase()

  if (method === 'OPTIONS') {
    res.writeHead(204, CORS)
    return res.end()
  }

  try {
    /* ---------- 健康检查 ---------- */
    if (method === 'GET' && pathname === '/api/health') {
      return json(res, 200, { ok: true, ...store.stats(), online: hub.onlineUsers().length })
    }

    /* ---------- 静态页面（不碰 /api 和 /ws） ---------- */
    if (method === 'GET' && !pathname.startsWith('/api/') && serveStatic(req, res, pathname)) return

    /* ---------- 图片上传 ---------- */
    if (method === 'POST' && pathname === '/api/upload') {
      const me = requireUser(req)
      const ct = req.headers['content-type'] || ''
      const bm = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i)
      if (!bm) return json(res, 400, { error: '需要 multipart/form-data' })
      let parts
      try {
        parts = parseMultipart(await readRaw(req, store.MAX_MEDIA_BYTES + 64 * 1024), bm[1] || bm[2].trim())
      } catch (e) {
        return json(res, e.status || 413, { error: e.message })
      }
      const file = parts.find((p) => p.filename && p.data && p.data.length)
      if (!file) return json(res, 400, { error: '没收到文件' })

      // 前端用 query 传类型信息，比塞进 multipart 简单
      const kind = url.searchParams.get('kind') || 'image'
      const name = url.searchParams.get('name') || file.filename || ''
      const duration = Number(url.searchParams.get('duration') || 0)
      const saved = store.saveMedia(me.id, file.type, file.data, { kind, name, duration })
      return json(res, 200, { ...saved, url: `/api/images/${saved.id}` })
    }

    /* ---------- 图片读取 ---------- */
    const imgMatch = pathname.match(/^\/api\/images\/([0-9a-f]{32})$/)
    if (imgMatch && method === 'GET') {
      // token 可选：带了就校验，没带也允许读。
      // 图片 id 是 32 位随机十六进制（128 bit），猜不到；
      // 这样 URL 不会因为 token 变化而失效，浏览器就能长期缓存。
      const token = url.searchParams.get('token') || tokenOf(req)
      if (token && !store.userByToken(token)) {
        return json(res, 401, { error: '登录已失效' })
      }
      const img = store.readImage(imgMatch[1])
      if (!img) return json(res, 404, { error: 'not found' })
      res.writeHead(200, {
        'Content-Type': img.mime,
        'Content-Length': img.data.length,
        // 图片内容永不改变（id 就是唯一标识），可以放心长缓存
        'Cache-Control': 'public, max-age=31536000, immutable',
        ...CORS
      })
      return res.end(img.data)
    }

    /* ---------- 前端错误上报（排障用，不对外暴露数据） ---------- */
    if (method === 'POST' && pathname === '/api/client-error') {
      try {
        const body = await readJson(req)
        const line = [
          new Date().toISOString(),
          'msg=' + String(body.message || '').slice(0, 300),
          'src=' + String(body.source || '').slice(0, 120),
          'ua=' + String(req.headers['user-agent'] || '').slice(0, 80)
        ].join(' | ')
        console.log('[client-error] ' + line)
      } catch (e) { /* 忽略 */ }
      return json(res, 200, { ok: true })
    }

    /* ---------- 图形验证码 ---------- */
    if (method === 'GET' && pathname === '/api/captcha') {
      const c = captcha.createCaptcha()
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...CORS
      })
      return res.end(JSON.stringify(c))
    }

    /* ---------- 注册 / 登录 ---------- */
    if (method === 'POST' && pathname === '/api/auth/register') {
      const body = await readJson(req)
      // 测试环境可以通过 DISABLE_CAPTCHA=1 跳过
      if (process.env.DISABLE_CAPTCHA !== '1') {
        if (!captcha.verifyCaptcha(body.captchaId, body.captchaCode)) {
          throw store.statusError(400, '验证码不对，换一张试试')
        }
      }
      const user = store.register(body)
      const token = store.createSession(user.id)
      return json(res, 200, { user, token })
    }

    if (method === 'POST' && pathname === '/api/auth/login') {
      const body = await readJson(req)
      // body 里给 imId 就用 ID 登录，给 phone 就用手机号
      const user = store.login(body)
      const token = store.createSession(user.id)
      return json(res, 200, { user, token })
    }

    if (method === 'POST' && pathname === '/api/auth/logout') {
      store.destroySession(tokenOf(req))
      return json(res, 200, { ok: true })
    }

    /* ---------- 我的资料 ---------- */
    if (pathname === '/api/me') {
      const me = requireUser(req)
      if (method === 'GET') return json(res, 200, { user: me })
      if (method === 'PATCH') {
        const body = await readJson(req)
        // 注意：ID 不在这里改，只有开发者能在管理后台分配
        if (body.imId !== undefined) throw store.statusError(403, 'ID 不能自行修改，需要开发者分配')
        return json(res, 200, { user: store.updateProfile(me.id, body) })
      }
    }

    /* ---------- 推送订阅 ---------- */
    if (method === 'GET' && pathname === '/api/push/vapid') {
      return json(res, 200, { enabled: push.isPushEnabled(), publicKey: push.vapidPublicKey() })
    }

    if (method === 'POST' && pathname === '/api/push/subscribe') {
      const me = requireUser(req)
      const body = await readJson(req)
      const devices = store.saveSubscription(me.id, body, req.headers['user-agent'] || '')
      return json(res, 200, { ok: true, devices })
    }

    if (method === 'POST' && pathname === '/api/push/unsubscribe') {
      requireUser(req)
      const body = await readJson(req)
      return json(res, 200, { ok: true, removed: store.deleteSubscription(body.endpoint || '') })
    }

    /* ---------- 所有用户（选人用） ---------- */
    if (method === 'GET' && pathname === '/api/users') {
      const me = requireUser(req)
      return json(res, 200, { users: store.listContacts(me.id) })
    }

    /* ---------- 按手机号找人 ---------- */
    if (method === 'GET' && pathname === '/api/users/lookup') {
      requireUser(req)
      const imId = url.searchParams.get('imId') || ''
      const phone = url.searchParams.get('phone') || ''
      let found = null
      if (imId) found = store.findByImId(imId)
      else if (phone) found = store.findUserByPhone(phone)
      if (!found) return json(res, 404, { error: imId ? '没有这个 ID' : '没有这个手机号' })
      return json(res, 200, { user: found })
    }

    /* ---------- 会话列表 ---------- */
    if (method === 'GET' && pathname === '/api/conversations') {
      const me = requireUser(req)
      const conversations = store.listConversations(me.id)
      // 顺手把在线状态贴上去，前端一进来就有准确状态，不用等推送
      for (const c of conversations) {
        if (c.peer) c.peer.online = hub.isOnline(c.peer.id)
        if (c.members) for (const m of c.members) m.online = hub.isOnline(m.id)
        if (Array.isArray(c.members)) for (const m of c.members) m.online = hub.isOnline(m.id)
      }
      return json(res, 200, { conversations })
    }

    if (method === 'POST' && pathname === '/api/conversations') {
      const me = requireUser(req)
      const body = await readJson(req)

      // 建群
      if (body.type === 'group') {
        const memberIds = Array.isArray(body.memberIds) ? body.memberIds : []
        const kind = body.kind === 'channel' ? 'channel' : 'group'
        const convId = store.createGroup(me.id, body.name, memberIds, kind)
        return json(res, 200, {
          conversationId: convId,
          type: 'group',
          members: store.membersOf(convId)
        })
      }

      // 一对一
      const peerId = body.peerId || store.findUserByPhone(body.phone || '')?.id
      if (!peerId) throw store.statusError(404, '对方不存在')
      const convId = store.getOrCreateDirect(me.id, peerId)
      return json(res, 200, { conversationId: convId, type: 'direct', members: store.membersOf(convId) })
    }

    /* ---------- 搜索聊天记录 ---------- */
    if (method === 'GET' && pathname === '/api/search') {
      const me = requireUser(req)
      const q = url.searchParams.get('q') || ''
      const convId = url.searchParams.get('convId') || null
      const messages = store.searchMessages(me.id, q, { convId, limit: 60 })
      // 补上对方/群名，搜索结果列表里要显示来自哪个对话
      const convs = store.listConversations(me.id)
      const byId = new Map(convs.map((c) => [c.id, c]))
      for (const m of messages) {
        const c = byId.get(m.convId)
        m.convTitle = c ? c.title || (c.peer ? c.peer.name : '对话') : '对话'
        m.convType = c ? c.type : 'direct'
      }
      return json(res, 200, { messages, query: q })
    }

    /* ---------- 撤回消息 ---------- */
    {
      const mm = pathname.match(/^\/api\/messages\/([^/]+)$/)
      if (mm && method === 'DELETE') {
        const me = requireUser(req)
        const { message, members } = store.deleteMessage(mm[1], me.id)
        // 通知会话里所有人（含自己其他设备）刷新
        hub.broadcastConv(members, { t: 'message-deleted', convId: message.convId, messageId: message.id, seq: message.seq })
        return json(res, 200, { ok: true, message })
      }
    }

    /* ---------- 会话详情 / 改群名 ---------- */
    {
      const mm = pathname.match(/^\/api\/conversations\/([^/]+)$/)
      if (mm) {
        const me = requireUser(req)
        const convId = mm[1]

        if (method === 'GET') {
          return json(res, 200, { members: store.membersOf(convId) })
        }
        if (method === 'PATCH') {
          const body = await readJson(req)
          const conv = store.updateGroup(convId, me.id, {
            title: body.title,
            announcement: body.announcement,
            avatar: body.avatar
          })
          hub.broadcastConv(store.membersOf(convId), {
            t: 'members',
            convId,
            members: store.membersOf(convId),
            title: conv.title,
            announcement: conv.announcement || '',
            avatar: conv.avatar || ''
          })
          return json(res, 200, { ok: true, title: conv.title })
        }
      }
    }

    /* ---------- 消息保留时长（自毁） ---------- */
    {
      const mm = pathname.match(/^\/api\/conversations\/([^/]+)\/ttl$/)
      if (mm && method === 'POST') {
        const me = requireUser(req)
        const body = await readJson(req)
        const r = store.setConversationTtl(mm[1], me.id, body.ttl)
        hub.broadcastConv(store.membersOf(mm[1]), { t: 'ttl-changed', convId: mm[1], ttl: r.ttl })
        return json(res, 200, r)
      }
    }

    /* ---------- 群话题 ---------- */
    {
      const mm = pathname.match(/^\/api\/conversations\/([^/]+)\/topics$/)
      if (mm) {
        const me = requireUser(req)
        if (method === 'GET') {
          return json(res, 200, { topics: store.listTopics(mm[1], me.id) })
        }
        if (method === 'POST') {
          const body = await readJson(req)
          const t = store.createTopic(mm[1], me.id, body.name)
          hub.broadcastConv(store.membersOf(mm[1]), { t: 'topics-changed', convId: mm[1] })
          return json(res, 200, { topic: t })
        }
      }
      const dm = pathname.match(/^\/api\/topics\/([^/]+)$/)
      if (dm && method === 'DELETE') {
        const me = requireUser(req)
        const r = store.deleteTopic(dm[1], me.id)
        hub.broadcastConv(store.membersOf(r.convId), { t: 'topics-changed', convId: r.convId })
        return json(res, 200, r)
      }
    }

    /* ---------- 置顶消息 ---------- */
    {
      const mm = pathname.match(/^\/api\/conversations\/([^/]+)\/pin$/)
      if (mm && method === 'POST') {
        const me = requireUser(req)
        const body = await readJson(req)
        const r = store.pinMessage(mm[1], body.messageId || null, me.id)
        hub.broadcastConv(store.membersOf(mm[1]), {
          t: 'pinned', convId: mm[1], pinnedMsgId: r.pinnedMsgId
        })
        return json(res, 200, r)
      }
    }

    /* ---------- 编辑消息 ---------- */
    {
      const mm = pathname.match(/^\/api\/messages\/([^/]+)\/edit$/)
      if (mm && method === 'POST') {
        const me = requireUser(req)
        const body = await readJson(req)
        const msg = store.editMessage(mm[1], me.id, body.body)
        hub.broadcastConv(store.membersOf(msg.convId), { t: 'message-edited', message: msg })
        return json(res, 200, { message: msg })
      }
    }

    /* ---------- 赞助开发者 ---------- */
    if (pathname === '/api/sponsor') {
      if (method === 'GET') {
        requireUser(req)
        return json(res, 200, store.sponsorInfo())
      }
      if (method === 'POST') {
        const me = requireAdmin(req)
        const body = await readJson(req)
        if (body.qr !== undefined) store.setSetting('sponsor_qr', body.qr)
        if (body.note !== undefined) store.setSetting('sponsor_note', body.note)
        if (body.enabled !== undefined) store.setSetting('sponsor_enabled', body.enabled ? '1' : '0')
        return json(res, 200, store.sponsorInfo())
      }
    }

    /* ---------- 管理员 ---------- */
    if (pathname.startsWith('/api/admin/')) {
      requireAdmin(req)

      if (method === 'GET' && pathname === '/api/admin/stats') {
        return json(res, 200, store.adminStats())
      }
      if (method === 'GET' && pathname === '/api/admin/users') {
        return json(res, 200, { users: store.adminListUsers() })
      }
      if (method === 'GET' && pathname === '/api/admin/conversations') {
        return json(res, 200, { conversations: store.adminListConversations() })
      }
      {
        const mm = pathname.match(/^\/api\/admin\/conversations\/([^/]+)\/messages$/)
        if (mm && method === 'GET') {
          const before = Number(url.searchParams.get('before') || 0) || undefined
          return json(res, 200, { messages: store.adminHistory(mm[1], { beforeSeq: before }) })
        }
      }
      {
        const mm = pathname.match(/^\/api\/admin\/messages\/([^/]+)$/)
        if (mm && method === 'DELETE') {
          const me = requireAdmin(req)
          return json(res, 200, store.adminDeleteMessage(mm[1], me.id))
        }
      }
      {
        const mm = pathname.match(/^\/api\/admin\/comments\/([^/]+)$/)
        if (mm && method === 'DELETE') {
          return json(res, 200, store.adminDeleteComment(mm[1]))
        }
      }
      {
        const mm = pathname.match(/^\/api\/admin\/moments\/([^/]+)$/)
        if (mm && method === 'DELETE') {
          return json(res, 200, store.adminDeleteMoment(mm[1]))
        }
      }
      {
        const mm = pathname.match(/^\/api\/admin\/users\/([^/]+)\/role$/)
        if (mm && method === 'POST') {
          const body = await readJson(req)
          return json(res, 200, { user: store.setRole(mm[1], body.role) })
        }
      }
    }

    /* ---------- 朋友圈 ---------- */
    if (pathname === '/api/moments') {
      const me = requireUser(req)
      if (method === 'GET') {
        const before = Number(url.searchParams.get('before') || 0) || undefined
        return json(res, 200, { moments: store.listMoments(me.id, { before }) })
      }
      if (method === 'POST') {
        const body = await readJson(req)
        const moment = store.createMoment(me.id, { content: body.content, images: body.images })
        return json(res, 200, { moment })
      }
    }
    {
      const mm = pathname.match(/^\/api\/moments\/([^/]+)(?:\/(like|comments))?$/)
      if (mm) {
        const me = requireUser(req)
        const mid = mm[1]
        const sub = mm[2]
        if (method === 'GET' && !sub) {
          const m = store.getMoment(mid, me.id)
          if (!m) return json(res, 404, { error: '动态不存在' })
          return json(res, 200, { moment: m })
        }
        if (sub === 'like' && method === 'POST') {
          return json(res, 200, { moment: store.toggleMomentLike(mid, me.id) })
        }
        if (sub === 'comments' && method === 'POST') {
          const body = await readJson(req)
          return json(res, 200, { moment: store.addMomentComment(mid, me.id, body.content, body.replyTo) })
        }
        if (!sub && method === 'DELETE') {
          return json(res, 200, store.deleteMoment(mid, me.id))
        }
      }
    }

    /* ---------- 会话个人设置（免打扰/置顶/删除）---------- */
    {
      const mm = pathname.match(/^\/api\/conversations\/([^/]+)\/settings$/)
      if (mm && method === 'PATCH') {
        const me = requireUser(req)
        const body = await readJson(req)
        const settings = store.updateMemberSettings(mm[1], me.id, {
          muted: body.muted, pinned: body.pinned, hidden: body.hidden,
          starred: body.starred, folder: body.folder
        })
        return json(res, 200, { ok: true, settings })
      }
    }

    /* ---------- 黑名单 ---------- */
    if (pathname === '/api/blocks') {
      const me = requireUser(req)
      if (method === 'GET') return json(res, 200, { blocks: store.listBlocks(me.id) })
      if (method === 'POST') {
        const body = await readJson(req)
        const blocks = store.blockUser(me.id, body.userId)
        return json(res, 200, { ok: true, blocks })
      }
    }
    {
      const mm = pathname.match(/^\/api\/blocks\/([^/]+)$/)
      if (mm && method === 'DELETE') {
        const me = requireUser(req)
        const blocks = store.unblockUser(me.id, mm[1])
        return json(res, 200, { ok: true, blocks })
      }
    }

    /* ---------- 解散群 ---------- */
    {
      const mm = pathname.match(/^\/api\/conversations\/([^/]+)\/disband$/)
      if (mm && method === 'POST') {
        const me = requireUser(req)
        const members = store.membersOf(mm[1])
        const r = store.disbandGroup(mm[1], me.id)
        hub.broadcastConv(members, { t: 'disbanded', convId: mm[1] })
        return json(res, 200, r)
      }
    }

    /* ---------- 管理员分配 ID ---------- */
    {
      const mm = pathname.match(/^\/api\/admin\/users\/([^/]+)\/imId$/)
      if (mm && method === 'POST') {
        const me = requireAdmin(req)
        const body = await readJson(req)
        const user = store.setImId(mm[1], body.imId, me.id)
        return json(res, 200, { user })
      }
    }

    /* ---------- 删除好友（私聊从我的列表移除） ---------- */
    {
      const mm = pathname.match(/^\/api\/conversations\/([^/]+)\/delete$/)
      if (mm && method === 'POST') {
        const me = requireUser(req)
        return json(res, 200, store.deleteFriend(mm[1], me.id))
      }
    }

    /* ---------- 清空聊天记录（仅本地） ---------- */
    {
      const mm = pathname.match(/^\/api\/conversations\/([^/]+)\/clear$/)
      if (mm && method === 'POST') {
        const me = requireUser(req)
        return json(res, 200, store.clearMessages(mm[1], me.id))
      }
    }

    /* ---------- 设置成员头衔 ---------- */
    {
      const mm = pathname.match(/^\/api\/conversations\/([^/]+)\/members\/([^/]+)\/title$/)
      if (mm && method === 'POST') {
        const me = requireUser(req)
        const body = await readJson(req)
        const members = store.setMemberTitle(mm[1], mm[2], body.title, me.id, body.titleColor)
        const conv = store.getConversation ? null : null
        hub.broadcastConv(members, { t: 'members', convId: mm[1], members })
        return json(res, 200, { members })
      }
    }

    /* ---------- 转让群主 ---------- */
    {
      const mm = pathname.match(/^\/api\/conversations\/([^/]+)\/owner$/)
      if (mm && method === 'POST') {
        const me = requireUser(req)
        const body = await readJson(req)
        const members = store.transferOwner(mm[1], body.userId, me.id)
        hub.broadcastConv(members, { t: 'members', convId: mm[1], members })
        return json(res, 200, { members })
      }
    }

    /* ---------- 任命 / 撤销群管理员 ---------- */
    {
      const mm = pathname.match(/^\/api\/conversations\/([^/]+)\/admins$/)
      if (mm && method === 'POST') {
        const me = requireUser(req)
        const body = await readJson(req)
        const members = store.setGroupAdmin(mm[1], body.userId, !!body.on, me.id)
        hub.broadcastConv(members, { t: 'members', convId: mm[1], members })
        return json(res, 200, { members })
      }
    }

    /* ---------- 群成员管理 ---------- */
    {
      const mm = pathname.match(/^\/api\/conversations\/([^/]+)\/members(?:\/([^/]+))?$/)
      if (mm) {
        const me = requireUser(req)
        const convId = mm[1]
        const targetId = mm[2]

        if (method === 'POST' && !targetId) {
          const body = await readJson(req)
          const members = store.addMember(convId, body.userId, me.id)
          hub.broadcastConv(members, { t: 'members', convId, members })
          return json(res, 200, { members })
        }
        if (method === 'DELETE' && targetId) {
          const members = store.removeMember(convId, targetId, me.id)
          hub.broadcastConv([...members, { id: targetId }], { t: 'members', convId, members })
          return json(res, 200, { members })
        }
        if (method === 'GET') {
          return json(res, 200, { members: store.membersOf(convId) })
        }
      }
    }

    /* ---------- 单个会话下的消息 ---------- */
    const m = pathname.match(/^\/api\/conversations\/([^/]+)(?:\/(messages|read|sync|members))?$/)
    if (m) {
      const me = requireUser(req)
      const convId = m[1]
      const sub = m[2]

      if (!sub && method === 'GET') {
        return json(res, 200, { members: store.membersOf(convId) })
      }

      if (sub === 'members' && method === 'GET') {
        return json(res, 200, { members: store.membersOf(convId) })
      }

      if (sub === 'messages' && method === 'GET') {
        const beforeSeq = Number(url.searchParams.get('before') || Number.MAX_SAFE_INTEGER)
        const limit = Number(url.searchParams.get('limit') || 50)
        const topicId = url.searchParams.get('topicId') || null
        const fromSeq = url.searchParams.get('fromSeq')
        const around = url.searchParams.get('around')
        if (around) {
          // 按时间跳转：先算出那个时间点的 seq，再往后取消息
          const seq = store.seqAtTime(convId, me.id, around)
          return json(res, 200, { messages: store.history(convId, me.id, { fromSeq: seq, limit }), fromSeq: seq })
        }
        return json(res, 200, { messages: store.history(convId, me.id, { beforeSeq, fromSeq, limit, topicId }) })
      }

      if (sub === 'sync' && method === 'GET') {
        const since = Number(url.searchParams.get('since') || 0)
        return json(res, 200, { messages: store.messagesSince(convId, me.id, since) })
      }

      if (sub === 'read' && method === 'POST') {
        const body = await readJson(req)
        const seq = store.markRead(convId, me.id, body.seq)
        // 通知对方「我读到哪了」，对方就能显示已读
        hub.broadcastConv(store.membersOf(convId), { t: 'read', convId, userId: me.id, seq }, { excludeUserId: me.id })
        return json(res, 200, { lastReadSeq: seq })
      }
    }

    json(res, 404, { error: 'no route: ' + method + ' ' + pathname })
  } catch (e) {
    const code = e.status || 500
    if (code >= 500) console.error('[http]', e)
    json(res, code, { error: e.message || 'server error' })
  }
})

/* ------------------------------------------------------------------ */
/*  WebSocket                                                          */
/* ------------------------------------------------------------------ */

const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  if (url.pathname !== '/ws') {
    socket.destroy()
    return
  }
  // 小程序端不能自定义 header，所以 token 也支持放在 query 上
  const token = url.searchParams.get('token') || tokenOf(req)
  const user = store.userByToken(token)
  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, user))
})

wss.on('connection', (ws, user) => {
  const deviceCount = hub.add(user.id, ws)
  console.log(`[ws] +${user.name}(${user.id}) 设备数=${deviceCount}`)

  ws.send(JSON.stringify({ t: 'hello', user, serverTime: Date.now(), onlineUsers: hub.onlineUsers() }))

  // 上线通知：把这个用户所有会话的对方叫醒，以便对方刷新在线状态
  for (const conv of store.listConversations(user.id)) {
    if (conv.peer) hub.sendToUser(conv.peer.id, { t: 'presence', userId: user.id, online: true })
  }

  ws.on('message', async (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return ws.send(JSON.stringify({ t: 'error', code: 400, message: 'JSON 格式不对' }))
    }

    try {
      switch (msg.t) {
        case 'ping':
          return ws.send(JSON.stringify({ t: 'pong', serverTime: Date.now() }))

        case 'send': {
          const { message, duplicate } = store.sendMessage({
            convId: msg.convId,
            senderId: user.id,
            body: msg.body,
            kind: msg.kind || 'text',
            clientId: msg.clientId,
            replyTo: msg.replyTo || null,
            mentions: msg.mentions || null,
            topicId: msg.topicId || null
          })
          // 回执给发送方（带上 clientId，客户端拿来替换"发送中"的占位气泡）
          ws.send(JSON.stringify({ t: 'ack', clientId: msg.clientId, message, duplicate }))
          // 推给对方的其他设备（不含发送者自己的这一条连接）
          hub.broadcastConv(store.membersOf(msg.convId), { t: 'message', message }, { excludeUserId: user.id })
          // 对方不在线就发 Web Push（在线的已经通过 WS 收到了，不重复打扰）
          push.notifyOfflineMembers(store.membersOf(msg.convId), user, message, hub)
          // 发送者自己可能有多台设备，也要同步
          const set = hub.byUser.get(user.id)
          if (set && set.size > 1) {
            const payload = JSON.stringify({ t: 'message', message })
            for (const other of set) {
              if (other !== ws && other.readyState === 1) other.send(payload)
            }
          }
          return
        }

        case 'read': {
          const seq = store.markRead(msg.convId, user.id, msg.seq)
          hub.broadcastConv(store.membersOf(msg.convId), { t: 'read', convId: msg.convId, userId: user.id, seq }, { excludeUserId: user.id })
          return
        }

        case 'delete': {
          // 撤回：软删除同一条记录，会话里所有人（含自己其他设备）都会收到通知
          const { message, members } = store.deleteMessage(msg.messageId, user.id)
          const payload = { t: 'message-deleted', convId: message.convId, messageId: message.id, seq: message.seq }
          ws.send(JSON.stringify(payload))
          hub.broadcastConv(members, payload, { excludeUserId: user.id })
          return
        }

        case 'typing': {
          hub.broadcastConv(store.membersOf(msg.convId), { t: 'typing', convId: msg.convId, userId: user.id }, { excludeUserId: user.id })
          return
        }

        default:
          return ws.send(JSON.stringify({ t: 'error', code: 400, message: '未知指令: ' + msg.t }))
      }
    } catch (e) {
      ws.send(JSON.stringify({ t: 'error', code: e.status || 500, message: e.message }))
    }
  })

  ws.on('close', () => {
    const left = hub.remove(ws)
    if (left === 0) {
      for (const conv of store.listConversations(user.id)) {
        if (conv.peer) hub.sendToUser(conv.peer.id, { t: 'presence', userId: user.id, online: false })
      }
    }
  })

  ws.on('error', () => {})
})

// 每天凌晨 4 点清一次没人引用的媒体文件
setInterval(() => {
  const h = new Date().getHours();
  if (h !== 4) return;
  try {
    const n = store.purgeOrphanMedia()
    if (n > 0) console.log('[gc] 清理孤儿媒体 ' + n + ' 个')
  } catch (e) { console.error('[gc] 失败', e.message) }
}, 60 * 60 * 1000)

// 每 5 分钟清一次过期消息（自毁消息）
setInterval(() => {
  try {
    const n = store.purgeExpired()
    if (n > 0) console.log('[ttl] 清理过期消息 ' + n + ' 条')
  } catch (e) { console.error('[ttl] 清理失败', e.message) }
}, 5 * 60 * 1000)

server.listen(PORT, HOST, () => {
  console.log(`[im] HTTP  http://${HOST}:${PORT}`)
  console.log(`[im] WS    ws://${HOST}:${PORT}/ws?token=...`)
  console.log(`[im] DB    ${store.dbFile()}`)
  console.log('[im] 统计', JSON.stringify(store.stats()))
})

const shutdown = () => {
  console.log('\n[im] 正在关闭…')
  hub.close()
  wss.close()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)