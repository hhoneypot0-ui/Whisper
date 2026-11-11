/**
 * Web Push 发送
 *
 * 为什么用 web-push 而不是手写：
 * 推送 payload 必须按 RFC 8291 处理（ECDH 生成一次性密钥 → HKDF 派生 →
 * AES-128-GCM 加密 → 按 aes128gcm 分包），任何一步错了推送服务只回
 * 一个没有细节的 400/403，调试成本极高。这部分交给经过验证的库。
 *
 * 没有配置 VAPID 密钥时，整个推送功能静默关闭，不影响聊天主流程。
 */
import { createRequire } from 'node:module'
import * as store from './db.mjs'

// web-push 是 CommonJS 包，ESM 里没有 default 导出，用 createRequire 桥接
const require = createRequire(import.meta.url)
const webpush = require('web-push')

let enabled = false

export function initPush() {
  const publicKey = process.env.VAPID_PUBLIC
  const privateKey = process.env.VAPID_PRIVATE
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@localhost'

  if (!publicKey || !privateKey) {
    console.log('[push] 未配置 VAPID 密钥，推送功能关闭（聊天不受影响）')
    return false
  }
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey)
    enabled = true
    console.log('[push] 已启用，公钥前 16 位:', publicKey.slice(0, 16) + '…')
  } catch (e) {
    console.warn('[push] VAPID 密钥无效，推送关闭:', e.message)
    enabled = false
  }
  return enabled
}

export function isPushEnabled() {
  return enabled
}

export function vapidPublicKey() {
  return enabled ? process.env.VAPID_PUBLIC : null
}

/** 预览文本：别把整条消息塞进通知栏 */
function previewOf(message) {
  if (message.kind === 'sticker') return '[表情]'
  if (message.kind === 'image') return '[图片]'
  const text = String(message.body || '')
  return text.length > 80 ? text.slice(0, 80) + '…' : text
}

/**
 * 给某个用户的所有设备推一条通知。
 * 失效的订阅（410 Gone / 404）就地删掉，不然会一直发一直失败。
 */
export async function pushToUser(userId, { title, body, convId, senderName }) {
  if (!enabled) return 0
  const subs = store.listSubscriptions(userId)
  if (!subs.length) return 0

  const payload = JSON.stringify({
    title: title || '新消息',
    body: body || '',
    convId: convId || '',
    senderName: senderName || '',
    ts: Date.now()
  })

  let sent = 0
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
          { TTL: 3600, urgency: 'high' }
        )
        sent++
      } catch (e) {
        const code = e.statusCode
        if (code === 404 || code === 410) {
          // 订阅已失效（用户清了站点数据、卸载了 PWA）
          store.deleteSubscription(s.endpoint)
        } else if (code === 413) {
          console.warn('[push] payload 过大')
        } else {
          console.warn('[push] 发送失败', code, String(e.body || e.message).slice(0, 120))
        }
      }
    })
  )
  return sent
}

/** 收到消息时调用：对方不在线才推，在线的走 WebSocket 就够了 */
export function notifyOfflineMembers(members, sender, message, hub) {
  if (!enabled) return
  for (const m of members) {
    if (m.id === sender.id) continue
    if (hub.isOnline(m.id)) continue // 在线就别打扰，WS 会实时送到
    pushToUser(m.id, {
      title: sender.name || '新消息',
      body: previewOf(message),
      convId: message.convId,
      senderName: sender.name
    }).catch(() => {})
  }
}