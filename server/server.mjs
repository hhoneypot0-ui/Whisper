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
// sharp 是可选的：装了就生成缩略图，没装就回原图
let sharp = null
try {
  sharp = (await import('sharp')).default
} catch {
  console.log('[im] sharp 没装，图片缩略图功能关闭（原图照常可用）')
}
import { WebSocketServer } from 'ws'
import { scanGarbage, cleanGarbage } from './gc-scan.mjs'
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
  // App 里页面从 http://127.0.0.1:xxxx 加载，也要允许跨域
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
  // 默认走单文件版：老版本 APK 只认一个 index.html
  // /lite 走拆分版（新版 APK 用，首屏更快）
  // 关键：老版本 APK 拉的是 /index.html，必须也给它单文件版，
  // 否则它拿到的是 20KB 的空壳（没有 CSS/JS），页面会整个错乱
  const single = path.join(PUBLIC_DIR, 'index.single.html')
  const hasSingle = fs.existsSync(single)
  const rel = (pathname === '/' || pathname === '/index.html')
    ? (hasSingle ? '/index.single.html' : '/index.html')
    : (pathname === '/lite' ? '/index.html' : pathname)
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

/* ------------------------------------------------------------------ */
/*  缩略图：第一次请求时生成，之后直接读磁盘                            */
/* ------------------------------------------------------------------ */
const THUMB_DIR = '/var/lib/im-server/thumbs'
try { fs.mkdirSync(THUMB_DIR, { recursive: true }) } catch {}

async function getThumb(id, img, width) {
  if (!sharp) return img.data;   // 没装 sharp 就直接给原图
  const key = id + '_' + width + '.jpg'
  const fp = path.join(THUMB_DIR, key)
  // 命中缓存
  try {
    if (fs.existsSync(fp)) return fs.readFileSync(fp)
  } catch {}

  const out = await sharp(img.data)
    .resize({ width, withoutEnlargement: true })
    .jpeg({ quality: 72, progressive: true })
    .toBuffer()

  try { fs.writeFileSync(fp, out) } catch {}
  return out
}

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

      // ?w=240 → 返回缩略图（第一次生成，之后走磁盘缓存）
      const wantW = Number(url.searchParams.get('w') || 0)
      if (wantW > 0 && wantW <= 800) {
        try {
          const thumb = await getThumb(imgMatch[1], img, wantW)
          res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Content-Length': thumb.length,
            'Cache-Control': 'public, max-age=31536000, immutable',
            ...CORS
          })
          return res.end(thumb)
        } catch (e) {
          // 生成失败就返回原图
        }
      }

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
      try {
        // body 里给 imId 就用 ID 登录，给 phone 就用手机号
        const user = store.login(body)
        // 设备指纹：UA + 粗略平台，够用
        const ua = String(req.headers['user-agent'] || '').slice(0, 180)
        const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()
        const isNew = store.isNewDevice(user.id, ua)
        const token = store.createSession(user.id, { device: ua, ip })
        // 新设备登录 → 通知本人
        if (isNew && ua) {
          try {
            hub.sendToUser(user.id, {
              t: 'new-device',
              device: ua.slice(0, 60),
              ip
            })
          } catch {}
        }
        return json(res, 200, { user, token, isNewDevice: isNew })
      } catch (e) {
        // 需要两步验证码时，明确告诉前端
        if (e.needTotp) return json(res, 401, { error: e.message, needTotp: true })
        throw e
      }
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

    /* ---------- 端到端加密：公钥交换 ----------
       服务器只存公钥包、只搬运密文，没有任何私钥，
       也不知道消息正文是什么。 */
    if (method === 'POST' && pathname === '/api/e2ee/bundle') {
      const me = requireUser(req)
      const body = await readJson(req)
      if (!body || !body.bundle || typeof body.bundle !== 'object') {
        return json(res, 400, { error: '缺少 bundle' })
      }
      store.saveE2eeBundle(me.id, body.bundle)
      return json(res, 200, { ok: true })
    }

    /* ---------- 群聊 SenderKey 分发 ----------
       payload 是客户端用一对一会话密钥加密后的密文，
       服务器只负责存取和转发，解不开也验证不了内容。 */
    if (method === 'POST' && pathname === '/api/e2ee/group/senderkey') {
      const me = requireUser(req)
      const body = await readJson(req)
      const convId = String(body.convId || '')
      const epoch = Number(body.epoch) || 1
      const list = Array.isArray(body.distributions) ? body.distributions : []
      if (!convId || !list.length) return json(res, 400, { error: '缺少 convId 或 distributions' })
      if (!store.membersOf(convId).some((m) => m.id === me.id)) {
        return json(res, 403, { error: '你不在这个群里' })
      }
      for (const d of list) {
        if (!d || !d.targetId || !d.payload) continue
        store.saveGroupSenderKey({
          convId,
          userId: me.id,
          targetId: d.targetId,
          epoch,
          payload: d.payload
        })
      }
      return json(res, 200, { ok: true, epoch, count: list.length })
    }

    if (method === 'GET' && pathname.startsWith('/api/e2ee/group/senderkey/')) {
      const me = requireUser(req)
      const rest = pathname.slice('/api/e2ee/group/senderkey/'.length).split('/')
      const convId = decodeURIComponent(rest[0] || '')
      const fromId = decodeURIComponent(rest[1] || '')
      if (!convId || !fromId) return json(res, 400, { error: '参数不全' })
      if (!store.membersOf(convId).some((m) => m.id === me.id)) {
        return json(res, 403, { error: '你不在这个群里' })
      }
      if (!store.membersOf(convId).some((m) => m.id === fromId)) {
        return json(res, 404, { error: '对方不在这个群里' })
      }
      const got = store.getGroupSenderKey(convId, fromId, me.id)
      if (!got) return json(res, 404, { error: '还没收到对方的密钥' })
      return json(res, 200, got)
    }

    if (method === 'GET' && pathname.startsWith('/api/e2ee/group/epoch/')) {
      const me = requireUser(req)
      const convId = decodeURIComponent(pathname.slice('/api/e2ee/group/epoch/'.length))
      if (!store.membersOf(convId).some((m) => m.id === me.id)) {
        return json(res, 403, { error: '你不在这个群里' })
      }
      return json(res, 200, { convId, epoch: store.maxGroupEpoch(convId, me.id) })
    }

    if (method === 'GET' && pathname === '/api/e2ee/me') {
      const me = requireUser(req)
      return json(res, 200, { enabled: store.e2eeEnabled(me.id) })
    }

    if (method === 'GET' && pathname.startsWith('/api/e2ee/bundle/')) {
      requireUser(req)
      const uid = decodeURIComponent(pathname.slice('/api/e2ee/bundle/'.length))
      const bundle = store.getE2eeBundle(uid)
      if (!bundle) return json(res, 404, { error: '对方还没开启端到端加密' })
      return json(res, 200, { bundle, userId: uid })
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
        // 隐身的人一律显示离线
        const vis = (id) => store.canSeeOnline(id) && hub.isOnline(id)
        if (c.peer) c.peer.online = vis(c.peer.id)
        if (Array.isArray(c.members)) for (const m of c.members) m.online = vis(m.id)
      }
      return json(res, 200, { conversations })
    }

    /* ---------- 密聊会话：创建 / 升级 ---------- */
    if (method === 'POST' && pathname === '/api/conversations/secret') {
      const me = requireUser(req)
      const body = await readJson(req)
      const peerId = body.peerId || store.findUserByPhone(body.phone || '')?.id
      if (!peerId) return json(res, 400, { error: '缺少 peerId' })
      const conversationId = store.getOrCreateSecret(me.id, peerId)
      return json(res, 200, { conversationId, isSecret: true, type: 'direct', members: store.membersOf(conversationId) })
    }

    if (method === 'POST' && pathname === '/api/conversations') {
      const me = requireUser(req)
      const body = await readJson(req)

      // 建群
      if (body.type === 'group') {
        const memberIds = Array.isArray(body.memberIds) ? body.memberIds : []
        const kind = body.kind === 'channel' ? 'channel' : 'group'
        const convId = store.createGroup(me.id, body.name, memberIds, kind, !!body.isPublic)
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
          // 公告更新了 → 顺带把新消息广播出去
          if (body.announcement !== undefined) {
            try {
              const last = store.lastMessageOf(convId)
              if (last && last.kind === 'pat') {
                hub.broadcastConv(store.membersOf(convId), { t: 'message', message: last })
              }
            } catch {}
          }
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

    /* ---------- 自定义头衔 ---------- */
    {
      const mm = pathname.match(/^\/api\/admin\/users\/([^/]+)\/title$/)
      if (mm && method === 'POST') {
        const me = requireUser(req)
        const body = await readJson(req)
        const user = store.setUserTitle(mm[1], body.title, body.color, me.id)
        return json(res, 200, { user })
      }
      // 自己改自己的
      const self = pathname.match(/^\/api\/me\/title$/)
      if (self && method === 'POST') {
        const me = requireUser(req)
        const body = await readJson(req)
        const user = store.setUserTitle(me.id, body.title, body.color, me.id)
        return json(res, 200, { user })
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

    /* ---------- 管理后台：一次性拿全部数据 ---------- */
    {
      if (pathname === '/api/admin/dashboard' && method === 'GET') {
        requireAdmin(req)
        return json(res, 200, {
          stats: store.adminStats(),
          users: store.adminListUsers(),
          conversations: store.adminListConversations()
        })
      }
    }

    /* ---------- 管理后台：媒体与全局消息 ---------- */
    {
      if (pathname === '/api/admin/media' && method === 'GET') {
        requireAdmin(req)
        return json(res, 200, { media: store.adminMedia() })
      }
      if (pathname === '/api/admin/messages' && method === 'GET') {
        requireAdmin(req)
        const limit = Number(url.searchParams.get('limit') || 100)
        return json(res, 200, { messages: store.adminRecentMessages(limit) })
      }
    }

    /* ---------- 发现公开频道 ---------- */
    {
      if (pathname === '/api/channels/public' && method === 'GET') {
        const me = requireUser(req)
        const q = url.searchParams.get('q') || ''
        return json(res, 200, { channels: store.listPublicChannels(me.id, q) })
      }
      const jm = pathname.match(/^\/api\/channels\/([^/]+)\/join$/)
      if (jm && method === 'POST') {
        const me = requireUser(req)
        const r = store.joinPublicChannel(jm[1], me.id)
        hub.broadcastConv(store.membersOf(r.convId), { t: 'members', convId: r.convId, members: store.membersOf(r.convId) })
        return json(res, 200, r)
      }
      const pm = pathname.match(/^\/api\/conversations\/([^/]+)\/public$/)
      if (pm && method === 'POST') {
        const me = requireUser(req)
        const body = await readJson(req)
        return json(res, 200, store.setChannelPublic(pm[1], me.id, !!body.isPublic))
      }
    }

    /* ---------- 管理后台：用户行为 ---------- */
    {
      const am = pathname.match(/^\/api\/admin\/users\/([^/]+)\/activity$/)
      if (am && method === 'GET') {
        const me = requireUser(req)
        if (me.role !== 'admin') return json(res, 403, { error: '需要管理员权限' })
        return json(res, 200, store.adminUserActivity(am[1]))
      }
    }

    /* ---------- 个人主页 ---------- */
    {
      const um = pathname.match(/^\/api\/users\/([^/]+)\/profile$/)
      if (um && method === 'GET') {
        const me = requireUser(req)
        return json(res, 200, store.userProfile(um[1], me.id))
      }
    }

    /* ---------- 撤回记录（管理后台） ---------- */
    {
      if (pathname === '/api/admin/recalls' && method === 'GET') {
        const me = requireUser(req)
        if (me.role !== 'admin') return json(res, 403, { error: '需要管理员权限' })
        const limit = Number(url.searchParams.get('limit') || 200)
        return json(res, 200, { recalls: store.adminRecallLog(limit) })
      }
    }

    /* ---------- 双向撤回 ---------- */
    {
      const pm = pathname.match(/^\/api\/conversations\/([^/]+)\/purge$/)
      if (pm && method === 'POST') {
        const me = requireUser(req)
        const r = store.purgeConversation(pm[1], me.id)
        // 告诉双方：这个会话已经清空，本地列表也要清
        const members = store.membersOf(pm[1])
        hub.broadcastConv(members, {
          t: 'conversation-purged',
          convId: pm[1],
          byId: me.id,
          byName: me.name
        })
        return json(res, 200, { deleted: r.deleted })
      }
    }

    /* ---------- 消息编辑历史 ---------- */
    {
      const mm = pathname.match(/^\/api\/messages\/([^/]+)\/edits$/)
      if (mm && method === 'GET') {
        const me = requireUser(req)
        return json(res, 200, { edits: store.messageEditHistory(mm[1], me.id) })
      }
    }

    /* ---------- 二维码 ---------- */
    {
      if (pathname === '/api/qr' && method === 'GET') {
        const text = url.searchParams.get('t') || 'https://im.bierlan.ccwu.cc/download/'
        // 颜色可指定：默认深色码 + 透明底（暗色主题用）；
        // 传 light=1 时用「黑码 + 白底」，亮色主题下也看得清
        const wantLight = url.searchParams.get('light') === '1'
        try {
          const QR = (await import('qrcode')).default
          const svg = await QR.toString(text.slice(0, 500), {
            type: 'svg',
            margin: 1,
            width: 220,
            color: wantLight
              ? { dark: '#14171f', light: '#ffffff' }
              : { dark: '#eceef5', light: '#00000000' }
          })
          res.writeHead(200, {
            'Content-Type': 'image/svg+xml; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
            ...CORS
          })
          return res.end(svg)
        } catch (e) {
          return json(res, 500, { error: e.message })
        }
      }
    }

    /* ---------- 下载列表（自动读 download 目录） ---------- */
    {
      if (pathname === '/api/download/list' && method === 'GET') {
        const dir = path.join(PUBLIC_DIR, 'download')
        const list = []
        try {
          for (const f of fs.readdirSync(dir)) {
            if (!/\.apk$/i.test(f)) continue
            const st = fs.statSync(path.join(dir, f))
            if (!st.isFile()) continue
            // 从文件名里抠版本号：qiaoqiao-2.5.apk → 2.5
            const m = f.match(/(\d+)\.(\d+)/)
            list.push({
              file: f,
              version: m ? m[1] + '.' + m[2] : '',
              size: st.size,
              mtime: st.mtimeMs
            })
          }
        } catch {}
        // 按版本号从大到小
        list.sort((a, b) => {
          const av = a.version.split('.').map(Number)
          const bv = b.version.split('.').map(Number)
          for (let i = 0; i < Math.max(av.length, bv.length); i++) {
            const x = av[i] || 0, y = bv[i] || 0
            if (x !== y) return y - x
          }
          return b.mtime - a.mtime
        })
        return json(res, 200, { list })
      }
    }

    /* ---------- 谁能接收密聊 ---------- */
    {
      if (pathname === '/api/e2ee/ready' && method === 'GET') {
        const me = requireUser(req)
        const ids = store.e2eeReadyUsers()
        const list = []
        const all = store.listAllUsers ? store.listAllUsers() : []
        for (const id of ids) {
          if (id === me.id) continue
          const u = all.find(x => x.id === id)
          if (u) list.push({ id: u.id, name: u.name, avatar: u.avatar || '', online: hub.isOnline(id) })
        }
        return json(res, 200, { ready: list })
      }
    }

    /* ---------- 管理后台：清理垃圾文件 ---------- */
    {
      if (pathname === '/api/admin/gc' && method === 'POST') {
        const me = requireUser(req)
        if (me.role !== 'admin') return json(res, 403, { error: '需要管理员权限' })
        const body = await readJson(req).catch(() => ({}))
        const category = body.category || 'media'
        const used = store.usedMediaIds ? store.usedMediaIds() : new Set()
        const r = cleanGarbage(category, used, store.removeMediaRow)
        console.log('[gc] 清理 ' + category + '：删了 ' + r.removed + ' 个，释放 ' + Math.round(r.freedBytes / 1024) + 'KB')
        return json(res, 200, r)
      }
      if (pathname === '/api/admin/gc/preview' && method === 'GET') {
        const me = requireUser(req)
        if (me.role !== 'admin') return json(res, 403, { error: '需要管理员权限' })
        // 先把「正在被引用」的媒体 id 全部收集出来
        const used = store.usedMediaIds ? store.usedMediaIds() : new Set()
        return json(res, 200, scanGarbage(used))
      }
    }

    /* ---------- 好友关系 ---------- */
    {
      if (pathname === '/api/friends' && method === 'GET') {
        const me = requireUser(req)
        return json(res, 200, { friends: store.listFriends(me.id) })
      }
      if (pathname === '/api/friends/requests' && method === 'GET') {
        const me = requireUser(req)
        return json(res, 200, { requests: store.myFriendRequests(me.id) })
      }
      if (pathname === '/api/friends/request' && method === 'POST') {
        const me = requireUser(req)
        const body = await readJson(req)
        const r = store.sendFriendRequest(me.id, body.toId, body.message)
        // 通知对方
        if (r.status === 'sent') {
          try{ hub.sendToUser(body.toId, { t: 'friend-request', fromName: me.name, fromId: me.id }) }catch(e){}
        }
        return json(res, 200, r)
      }
      const fr = pathname.match(/^\/api\/friends\/requests\/([^/]+)\/(accept|reject)$/)
      if (fr && method === 'POST') {
        const me = requireUser(req)
        const r = store.respondFriendRequest(fr[1], me.id, fr[2] === 'accept')
        return json(res, 200, r)
      }
      const st = pathname.match(/^\/api\/friends\/status\/([^/]+)$/)
      if (st && method === 'GET') {
        const me = requireUser(req)
        return json(res, 200, store.friendStatus(me.id, st[1]))
      }
    }

    /* ---------- 举报 ---------- */
    {
      if (pathname === '/api/reports' && method === 'POST') {
        const me = requireUser(req)
        const body = await readJson(req)
        return json(res, 200, store.submitReport(me.id, body))
      }
      if (pathname === '/api/admin/reports' && method === 'GET') {
        const me = requireUser(req)
        if (me.role !== 'admin') return json(res, 403, { error: '需要管理员权限' })
        return json(res, 200, { items: store.listReports(200) })
      }
      const hr = pathname.match(/^\/api\/admin\/reports\/([^/]+)\/handle$/)
      if (hr && method === 'POST') {
        const me = requireUser(req)
        if (me.role !== 'admin') return json(res, 403, { error: '需要管理员权限' })
        const body = await readJson(req)
        return json(res, 200, store.handleReport(hr[1], body.action))
      }
    }

    /* ---------- 谁能给我发消息 ---------- */
    {
      if (pathname === '/api/me/msg-policy' && method === 'POST') {
        const me = requireUser(req)
        const body = await readJson(req)
        return json(res, 200, store.setMsgPolicy(me.id, body.policy))
      }
    }

    /* ---------- 问题反馈 ---------- */
    {
      if (pathname === '/api/feedback' && method === 'POST') {
        const body = await readJson(req)
        let me = null
        try { me = requireUser(req) } catch {}
        const r = store.submitFeedback(me ? me.id : null, body)
        // 立刻通知所有管理员
        try {
          const admins = (store.adminDashboard ? store.adminDashboard().users || [] : []).filter(x => x.role === 'admin')
          for (const a of admins) {
            hub.sendToUser(a.id, { t: 'new-feedback', content: body.content, from: me ? me.name : '未登录用户' })
          }
        } catch {}
        return json(res, 200, r)
      }
      if (pathname === '/api/admin/feedback' && method === 'GET') {
        const me = requireUser(req)
        if (me.role !== 'admin') return json(res, 403, { error: '需要管理员权限' })
        return json(res, 200, { items: store.listFeedback(200) })
      }
      const fr = pathname.match(/^\/api\/admin\/feedback\/([^/]+)\/reply$/)
      if (fr && method === 'POST') {
        const me = requireUser(req)
        if (me.role !== 'admin') return json(res, 403, { error: '需要管理员权限' })
        const body = await readJson(req)
        return json(res, 200, store.replyFeedback(fr[1], body.reply))
      }
    }

    /* ---------- 登录设备管理 ---------- */
    {
      if (pathname === '/api/me/devices' && method === 'GET') {
        const me = requireUser(req)
        return json(res, 200, { devices: store.myDevices(me.id, me.token) })
      }
      if (pathname === '/api/me/devices/kick' && method === 'POST') {
        const me = requireUser(req)
        return json(res, 200, store.kickOtherDevices(me.id, me.token))
      }
    }

    /* ---------- 两步验证 ---------- */
    {
      if (pathname === '/api/me/totp/setup' && method === 'POST') {
        const me = requireUser(req)
        return json(res, 200, store.setupTotp(me.id))
      }
      if (pathname === '/api/me/totp/enable' && method === 'POST') {
        const me = requireUser(req)
        const body = await readJson(req)
        return json(res, 200, store.enableTotp(me.id, body.code))
      }
      if (pathname === '/api/me/totp/disable' && method === 'POST') {
        const me = requireUser(req)
        const body = await readJson(req)
        return json(res, 200, store.disableTotp(me.id, body.password))
      }
    }

    /* ---------- 账号注销 / 阅后即焚 ---------- */
    {
      if (pathname === '/api/me/delete' && method === 'POST') {
        const me = requireUser(req)
        const body = await readJson(req)
        const r = store.deleteAccount(me.id, body.password)
        return json(res, 200, r)
      }
      // 发阅后即焚消息：在普通发送里带 burnAfter 参数
      if (pathname === '/api/messages/burn' && method === 'POST') {
        const me = requireUser(req)
        const body = await readJson(req)
        const msg = store.sendMessage({
          convId: body.convId, senderId: me.id, body: body.body,
          kind: 'text', clientId: body.clientId || null
        })
        // 标记焚毁时间
        if (msg && msg.message) {
          const db = null
          // 直接更新（sendMessage 返回后补字段）
        }
        hub.broadcastConv(store.membersOf(body.convId), { t: 'message', message: msg.message || msg })
        return json(res, 200, msg)
      }
    }

    /* ---------- 批量操作 ---------- */
    {
      if (pathname === '/api/messages/batch-delete' && method === 'POST') {
        const me = requireUser(req)
        const body = await readJson(req)
        const r = store.deleteMessages(body.ids, me.id)
        return json(res, 200, r)
      }
    }

    /* ---------- 界面偏好 / 免打扰时段 ---------- */
    {
      if (pathname === '/api/me/prefs' && method === 'POST') {
        const me = requireUser(req)
        const body = await readJson(req)
        return json(res, 200, { user: store.setPrefs(me.id, body) })
      }
      const qh = pathname.match(/^\/api\/conversations\/([^/]+)\/quiet$/)
      if (qh && method === 'POST') {
        const me = requireUser(req)
        const body = await readJson(req)
        return json(res, 200, store.setQuietHours(qh[1], me.id, body.range))
      }
      const ms = pathname.match(/^\/api\/conversations\/([^/]+)\/members-search$/)
      if (ms && method === 'GET') {
        const me = requireUser(req)
        const q = url.searchParams.get('q') || ''
        return json(res, 200, { members: store.searchMembers(ms[1], me.id, q) })
      }
    }

    /* ---------- 导出聊天记录 ---------- */
    {
      const em = pathname.match(/^\/api\/conversations\/([^/]+)\/export$/)
      if (em && method === 'GET') {
        const me = requireUser(req)
        const format = url.searchParams.get('format') || 'txt'
        const r = store.exportConversation(em[1], me.id, format)
        res.writeHead(200, {
          'Content-Type': format === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
          'Content-Disposition': 'attachment; filename="' + encodeURIComponent(r.filename) + '"',
          ...CORS
        })
        return res.end(r.text)
      }
    }

    /* ---------- 隐私开关 ---------- */
    {
      if (pathname === '/api/me/watermark' && method === 'POST') {
        const me = requireUser(req)
        const body = await readJson(req)
        return json(res, 200, store.setWatermark(me.id, !!body.on))
      }
      if (pathname === '/api/me/privacy' && method === 'POST') {
        const me = requireUser(req)
        const body = await readJson(req)
        return json(res, 200, { user: store.setPrivacy(me.id, body) })
      }
    }

    /* ---------- 群权限 / 慢速模式 ---------- */
    {
      const pm = pathname.match(/^\/api\/conversations\/([^/]+)\/members\/([^/]+)\/perms$/)
      if (pm && method === 'POST') {
        const me = requireUser(req)
        const body = await readJson(req)
        const r = store.setMemberPerms(pm[1], pm[2], body.perms, me.id)
        hub.broadcastConv(store.membersOf(pm[1]), { t: 'members', convId: pm[1], members: store.membersOf(pm[1]) })
        return json(res, 200, r)
      }
      const sm = pathname.match(/^\/api\/conversations\/([^/]+)\/slow$/)
      if (sm && method === 'POST') {
        const me = requireUser(req)
        const body = await readJson(req)
        const r = store.setSlowMode(sm[1], body.seconds, me.id)
        hub.broadcastConv(store.membersOf(sm[1]), { t: 'slow-changed', convId: sm[1], slowMode: r.slowMode })
        return json(res, 200, r)
      }
    }

    /* ---------- 邀请链接 ---------- */
    {
      // 预览（不需要登录，落地页用）
      const pk = pathname.match(/^\/api\/invite\/([a-z0-9]+)$/)
      if (pk && method === 'GET') {
        const info = store.peekInvite(pk[1])
        if (!info) return json(res, 404, { error: '邀请链接无效' })
        return json(res, 200, info)
      }
      // 加入
      if (pk && method === 'POST') {
        const me = requireUser(req)
        const r = store.joinByInvite(pk[1], me.id)
        hub.broadcastConv(store.membersOf(r.convId), { t: 'members', convId: r.convId, members: store.membersOf(r.convId) })
        return json(res, 200, r)
      }
      // 获取/生成群邀请码
      const gc = pathname.match(/^\/api\/conversations\/([^/]+)\/invite$/)
      if (gc && method === 'POST') {
        const me = requireUser(req)
        return json(res, 200, store.getInviteCode(gc[1], me.id))
      }
    }

    /* ---------- 全局搜索 ---------- */
    {
      if (pathname === '/api/search' && method === 'GET') {
        const me = requireUser(req)
        const q = url.searchParams.get('q') || ''
        const convId = url.searchParams.get('convId') || null
        // 带 convId：只搜这个会话（聊天页的「查找聊天记录」）
        if (convId) {
          const messages = store.searchMessages(me.id, q, { convId, limit: 60 })
          const convs = store.listConversations(me.id)
          const byId = new Map(convs.map((c) => [c.id, c]))
          for (const m of messages) {
            const c = byId.get(m.convId)
            m.convTitle = c ? c.title || (c.peer ? c.peer.name : '对话') : '对话'
            m.convType = c ? c.type : 'direct'
          }
          return json(res, 200, { messages, query: q })
        }
        // 不带 convId：全局搜索（人 + 群 + 全部消息）
        const kindsParam = url.searchParams.get('kinds') || ''
        const kinds = kindsParam ? kindsParam.split(',').filter(Boolean) : null
        return json(res, 200, store.globalSearch(me.id, q, kinds))
      }
    }

    /* ---------- 消息收藏 ---------- */
    {
      const mm = pathname.match(/^\/api\/messages\/([^/]+)\/star$/)
      if (mm && method === 'POST') {
        const me = requireUser(req)
        return json(res, 200, store.toggleStar(mm[1], me.id))
      }
      if (pathname === '/api/stars' && method === 'GET') {
        const me = requireUser(req)
        return json(res, 200, { items: store.myStars(me.id) })
      }
    }

    /* ---------- 一起听 ---------- */
    {
      // 读当前状态
      const st = pathname.match(/^\/api\/conversations\/([^/]+)\/listen$/)
      if (st && method === 'GET') {
        const me = requireUser(req)
        return json(res, 200, { state: store.getListenState(st[1], me.id) })
      }
      // 换歌
      if (st && method === 'POST') {
        const me = requireUser(req)
        const body = await readJson(req)
        const state = store.setListenTrack(st[1], me.id, body.audioId, body.title)
        hub.broadcastConv(store.membersOf(st[1]), { t: 'listen', convId: st[1], state })
        return json(res, 200, { state })
      }
      // 控制
      const ct = pathname.match(/^\/api\/conversations\/([^/]+)\/listen\/control$/)
      if (ct && method === 'POST') {
        const me = requireUser(req)
        const body = await readJson(req)
        const state = store.controlListen(ct[1], me.id, body.action, body.position)
        hub.broadcastConv(store.membersOf(ct[1]), { t: 'listen', convId: ct[1], state })
        return json(res, 200, { state })
      }
    }

    /* ---------- 匿名提问 ---------- */
    {
      // 问某人（匿名）
      const ask = pathname.match(/^\/api\/ask\/([^/]+)$/)
      if (ask && method === 'POST') {
        const me = requireUser(req)
        const body = await readJson(req)
        // 用「提问者 + 目标」做盐，服务端不记是谁，但能防刷
        const r = store.askAnonymously(ask[1], body.question, me.id + ':' + ask[1])
        // 通知被问的人
        const target = store.publicUserById ? null : null
        hub.broadcastAll({ t: 'anon-question', to: ask[1] })
        return json(res, 200, r)
      }
      // 我收到的
      if (pathname === '/api/ask/mine' && method === 'GET') {
        const me = requireUser(req)
        return json(res, 200, { questions: store.myAnonQuestions(me.id) })
      }
      // 回答
      const ans = pathname.match(/^\/api\/ask\/([^/]+)\/answer$/)
      if (ans && method === 'POST') {
        const me = requireUser(req)
        const body = await readJson(req)
        const r = store.answerAnon(ans[1], me.id, body.answer)
        hub.broadcastAll({ t: 'anon-answered' })
        return json(res, 200, r)
      }
      // 某人公开的问答
      const pub = pathname.match(/^\/api\/ask\/public\/([^/]+)$/)
      if (pub && method === 'GET') {
        requireUser(req)
        return json(res, 200, { list: store.publicAnonOf(pub[1]) })
      }
    }

    /* ---------- 签到 / 活跃榜 ---------- */
    {
      if (pathname === '/api/checkin' && method === 'POST') {
        const me = requireUser(req)
        const r = store.checkin(me.id)
        hub.broadcastAll({ t: 'checkin', who: me.name, userId: me.id, firstIsMe: r.firstIsMe })
        return json(res, 200, r)
      }
      if (pathname === '/api/checkin' && method === 'GET') {
        requireUser(req)
        return json(res, 200, store.checkinBoard())
      }
    }

    /* ---------- 群投票 ---------- */
    {
      // 发起投票
      const mk = pathname.match(/^\/api\/conversations\/([^/]+)\/poll$/)
      if (mk && method === 'POST') {
        const me = requireUser(req)
        const body = await readJson(req)
        const poll = store.createPoll(mk[1], me.id, body.question, body.options, !!body.multi)
        // 同时在聊天里发一条消息指向这个投票
        const msg = store.sendMessage({
          convId: mk[1], senderId: me.id, body: poll.id, kind: 'poll', clientId: body.clientId || null
        })
        hub.broadcastConv(store.membersOf(mk[1]), { t: 'message', message: msg.message || msg })
        return json(res, 200, { poll, message: msg.message || msg, duplicate: msg.duplicate })
      }
      // 读投票 / 投票
      const one = pathname.match(/^\/api\/polls\/([^/]+)(?:\/vote)?$/)
      if (one) {
        const me = requireUser(req)
        if (method === 'GET' && !pathname.endsWith('/vote')) {
          return json(res, 200, { poll: store.getPoll(one[1], me.id) })
        }
        if (method === 'POST' && pathname.endsWith('/vote')) {
          const body = await readJson(req)
          const poll = store.votePoll(one[1], me.id, body.optionIndex)
          hub.broadcastConv(store.membersOf(poll.convId), { t: 'poll-updated', poll })
          return json(res, 200, { poll })
        }
      }
    }

    /* ---------- 表情回应 ---------- */
    {
      const mm = pathname.match(/^\/api\/messages\/([^/]+)\/reaction$/)
      if (mm && method === 'POST') {
        const me = requireUser(req)
        const body = await readJson(req)
        const r = store.toggleReaction(mm[1], me.id, body.emoji)
        hub.broadcastConv(store.membersOf(r.message.convId), { t: 'message-reaction', message: r.message })
        return json(res, 200, { message: r.message })
      }
    }

    /* ---------- 骰子 / 猜拳 ---------- */
    {
      const mm = pathname.match(/^\/api\/conversations\/([^/]+)\/game$/)
      if (mm && method === 'POST') {
        const me = requireUser(req)
        const body = await readJson(req)
        const kind = body.kind === 'rps' ? 'rps' : 'dice'
        // 结果用前端算好的（本地已经显示了，服务端再随机一次会和界面对不上）
        let value = String(body.value || '')
        if (kind === 'dice') {
          const n = Number(value)
          value = (n >= 1 && n <= 6) ? String(n) : String(1 + Math.floor(Math.random() * 6))
        } else {
          value = ['石头', '剪刀', '布'].includes(value) ? value : '石头'
        }
        const msg = store.sendMessage({
          convId: mm[1],
          senderId: me.id,
          body: value,
          kind,
          clientId: body.clientId || null
        })
        hub.broadcastConv(store.membersOf(mm[1]), { t: 'message', message: msg.message || msg })
        return json(res, 200, msg)          // msg 本身就是 { message, duplicate }
      }
    }

    /* ---------- 拍一拍 ---------- */
    {
      const mm = pathname.match(/^\/api\/conversations\/([^/]+)\/pat$/)
      if (mm && method === 'POST') {
        const me = requireUser(req)
        const body = await readJson(req)
        const msg = store.sendMessage({
          convId: mm[1],
          senderId: me.id,
          body: String(body.body || ''),
          kind: 'pat',
          clientId: body.clientId || null
        })
        hub.broadcastConv(store.membersOf(mm[1]), { t: 'message', message: msg.message || msg })
        return json(res, 200, msg)
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
          return json(res, 200, { user: store.setRole(mm[1], body.role, me.id) })
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
        const r = store.messagesSince(convId, me.id, since)
        return json(res, 200, { messages: r.messages, serverCount: r.serverCount })
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
            topicId: msg.topicId || null,
            burnAfter: msg.burnAfter || 0,
            noForward: !!msg.noForward
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

// 媒体清理已停用：之前的判定逻辑有 bug（body 是加密的，匹配不上），
// 会误删正在使用的图片和语音。修好之前不再自动清理。
// setInterval(() => { ... }, 60 * 60 * 1000)

// 每天清一次孤儿文件（只删超过 7 天、且没有任何引用的）
function scheduleMediaGc() {
  const run = () => {
    try {
      const r = store.purgeOrphanMedia()
      const removed = (r && r.removed) || 0
      const skipped = (r && r.skippedNew) || 0
      if (removed > 0 || skipped > 0) {
        console.log('[gc] 清理孤儿文件 ' + removed + ' 个（跳过 ' + skipped + ' 个新的）')
      }
    } catch (e) {
      console.error('[gc] 清理失败', e.message)
    }
    // 24 小时后再来
    setTimeout(run, 24 * 60 * 60 * 1000)
  }
  // 启动 10 分钟后再开始，避开服务刚起来的高峰
  setTimeout(run, 10 * 60 * 1000)
}
scheduleMediaGc()

// 每 5 分钟清一次过期消息（自毁 + 阅后即焚）
setInterval(() => {
  try {
    const n = store.purgeExpired()
    if (n > 0) console.log('[ttl] 清理过期消息 ' + n + ' 条')
  } catch (e) { console.error('[ttl] 清理失败', e.message) }
  try {
    const b = store.purgeBurned()
    if (b > 0) console.log('[burn] 焚毁消息 ' + b + ' 条')
  } catch (e) { console.error('[burn] 失败', e.message) }
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