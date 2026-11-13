/**
 * WebSocket 连接中枢
 * 只管三件事：谁在线、给谁发、谁死了。
 * 业务逻辑全在 server.mjs，这里不碰数据库。
 */

export class Hub {
  constructor() {
    /** userId -> Set<WebSocket>（同一账号可以多端在线） */
    this.byUser = new Map()
    /** ws -> { userId, alive } */
    this.meta = new WeakMap()
    // 5 秒一轮：最坏 10 秒就能判定掉线（用户要求更快反馈）
    this.heartbeat = setInterval(() => this._sweep(), 5000)
    // 别让心跳定时器拖住进程退出
    this.heartbeat.unref?.()
  }

  add(userId, ws) {
    let set = this.byUser.get(userId)
    if (!set) {
      set = new Set()
      this.byUser.set(userId, set)
    }
    set.add(ws)
    this.meta.set(ws, { userId, alive: true })
    ws.on('pong', () => {
      const m = this.meta.get(ws)
      if (m) m.alive = true
    })
    return set.size
  }

  remove(ws) {
    const m = this.meta.get(ws)
    if (!m) return 0
    const set = this.byUser.get(m.userId)
    if (!set) return 0
    set.delete(ws)
    if (set.size === 0) this.byUser.delete(m.userId)
    return set.size
  }

  isOnline(userId) {
    return (this.byUser.get(userId)?.size ?? 0) > 0
  }

  onlineUsers() {
    return [...this.byUser.keys()]
  }

  /** 发给某个用户的全部设备 */
  sendToUser(userId, payload) {
    const set = this.byUser.get(userId)
    if (!set?.size) return 0
    const raw = JSON.stringify(payload)
    let n = 0
    for (const ws of set) {
      if (ws.readyState === 1) {
        ws.send(raw)
        n++
      }
    }
    return n
  }

  /** 发给某个会话的所有成员 */
  broadcastConv(members, payload, { excludeUserId } = {}) {
    const raw = JSON.stringify(payload)
    let n = 0
    for (const m of members) {
      if (excludeUserId && m.id === excludeUserId) continue
      const set = this.byUser.get(m.id)
      if (!set?.size) continue
      for (const ws of set) {
        if (ws.readyState === 1) {
          ws.send(raw)
          n++
        }
      }
    }
    return n
  }

  /** 广播给所有在线连接（签到提醒之类） */
  broadcastAll(payload) {
    const raw = JSON.stringify(payload)
    let n = 0
    for (const set of this.byUser.values()) {
      for (const ws of set) {
        if (ws.readyState === 1) { ws.send(raw); n++ }
      }
    }
    return n
  }

  /** 心跳清扫：上一轮没回 pong 的直接断开 */
  _sweep() {
    for (const [, set] of this.byUser) {
      for (const ws of set) {
        const m = this.meta.get(ws)
        if (!m) continue
        if (m.alive === false) {
          ws.terminate()
          continue
        }
        m.alive = false
        try {
          ws.ping()
        } catch {
          ws.terminate()
        }
      }
    }
  }

  close() {
    clearInterval(this.heartbeat)
    for (const [, set] of this.byUser) {
      for (const ws of set) {
        try {
          ws.close(1001, 'server shutdown')
        } catch {}
      }
    }
    this.byUser.clear()
  }
}