/**
 * 服务器垃圾扫描与清理
 * 分四类：孤儿媒体 / 旧缩略图 / 旧备份 / 系统日志
 * 每一类都先算大小，清理时要显式指定类别
 */
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const MEDIA_DIR  = '/var/lib/im-server/images'
const THUMB_DIR  = '/var/lib/im-server/thumbs'
const BACKUP_DIR = '/var/backups/im-server'

function dirStat(dir) {
  let bytes = 0, files = 0
  try {
    for (const f of fs.readdirSync(dir)) {
      try {
        const st = fs.statSync(path.join(dir, f))
        if (st.isFile()) { bytes += st.size; files++ }
      } catch {}
    }
  } catch {}
  return { bytes, files }
}

function listFiles(dir, filter) {
  const out = []
  try {
    for (const f of fs.readdirSync(dir)) {
      try {
        const p = path.join(dir, f)
        const st = fs.statSync(p)
        if (!st.isFile()) continue
        if (filter && !filter(f, st)) continue
        out.push({ name: f, size: st.size, mtime: st.mtimeMs })
      } catch {}
    }
  } catch {}
  return out.sort((a, b) => b.size - a.size)
}

/** 扫描四类垃圾 */
export function scanGarbage(usedMediaIds) {
  const result = { media: null, thumbs: null, backups: null, logs: null, totalBytes: 0 }

  // ① 孤儿媒体文件
  const mediaFiles = listFiles(MEDIA_DIR)
  const orphans = mediaFiles.filter(f => {
    const id = f.name.replace(/\.enc$/, '').replace(/\.bin$/, '')
    return !usedMediaIds.has(id)
  })
  result.media = {
    label: '没有被任何消息引用的图片/语音/文件',
    count: orphans.length,
    bytes: orphans.reduce((s, f) => s + f.size, 0),
    items: orphans.slice(0, 30).map(f => ({
      name: f.name,
      size: f.size,
      ageDays: Math.floor((Date.now() - f.mtime) / 86400000)
    })),
    more: Math.max(0, orphans.length - 30)
  }

  // ② 孤儿缩略图（原图没了，缩略图还在）
  const thumbFiles = listFiles(THUMB_DIR)
  const thumbOrphans = thumbFiles.filter(f => {
    const baseId = f.name.split('_')[0]
    return !mediaFiles.some(m => m.name.startsWith(baseId))
  })
  result.thumbs = {
    label: '原图已被删除、只剩缩略图的残留',
    count: thumbOrphans.length,
    bytes: thumbOrphans.reduce((s, f) => s + f.size, 0),
    items: thumbOrphans.slice(0, 20).map(f => ({ name: f.name, size: f.size })),
    more: Math.max(0, thumbOrphans.length - 20)
  }

  // ③ 旧备份（保留最近 3 个）
  const backups = listFiles(BACKUP_DIR, (n) => /\.(tar\.gz|db\.gz|db)$/.test(n))
  const keep = 3
  const oldBackups = backups.slice(keep)
  result.backups = {
    label: '超过最近 3 份的旧备份',
    count: oldBackups.length,
    bytes: oldBackups.reduce((s, f) => s + f.size, 0),
    items: oldBackups.slice(0, 20).map(f => ({
      name: f.name,
      size: f.size,
      ageDays: Math.floor((Date.now() - f.mtime) / 86400000)
    })),
    more: Math.max(0, oldBackups.length - 20),
    keepCount: keep
  }

  // ④ 系统日志（journal）
  let journalBytes = 0
  try {
    const out = execSync('journalctl --disk-usage 2>/dev/null || true', { encoding: 'utf8' })
    const m = out.match(/([\d.]+)\s*([KMG])/i)
    if (m) {
      const n = parseFloat(m[1])
      const u = m[2].toUpperCase()
      journalBytes = Math.round(n * (u === 'G' ? 1073741824 : u === 'M' ? 1048576 : 1024))
    }
  } catch {}
  // 各 log 文件
  const logFiles = listFiles('/var/log', (n) => /\.log$|\.log\.\d+$|\.gz$/.test(n))
  const logBytes = logFiles.reduce((s, f) => s + f.size, 0)
  // 只有 journal 我们能清（通过 sudo）；/var/log 下的 auth.log 等属于 root:syslog，清不了
  result.logs = {
    label: 'systemd 日志（保留最近 7 天）',
    count: journalBytes > 0 ? 1 : 0,
    bytes: journalBytes,
    items: [{ name: 'systemd journal', size: journalBytes, ageDays: 0 }].filter(x => x.size > 0),
    more: 0,
    note: logBytes > 1048576 ? ('另有 ' + Math.round(logBytes/1048576) + 'MB 系统日志（auth.log 等）属于 root，需要手动清理') : ''
  }
  // pcp 性能监控数据（没用就一直占着）
  let pcpBytes = 0, pcpFiles = 0
  try {
    const out = execSync('du -sb /var/log/pcp 2>/dev/null | cut -f1', { encoding: 'utf8' }).trim()
    pcpBytes = parseInt(out, 10) || 0
    const cnt = execSync('find /var/log/pcp -type f 2>/dev/null | wc -l', { encoding: 'utf8' }).trim()
    pcpFiles = parseInt(cnt, 10) || 0
  } catch {}
  let pcpRunning = false
  try { pcpRunning = execSync('systemctl is-active pmcd 2>/dev/null || true', { encoding: 'utf8' }).trim() === 'active' } catch {}
  result.pcp = {
    label: '性能监控数据（pcp）' + (pcpRunning ? ' · 服务正在运行' : ''),
    count: pcpFiles,
    bytes: pcpBytes,
    items: [{ name: '/var/log/pcp', size: pcpBytes, ageDays: 0 }].filter(x => x.size > 0),
    more: 0,
    canClean: true,
    note: pcpRunning ? '清理时会先停掉监控服务（不影响的其他功能）' : ''
  }

  // 系统垃圾：失败登录记录、caddy 访问日志（能通过 sudo 清）
  const sysFiles = [
    { path: '/var/log/btmp',     label: '失败登录记录（暴力破解留下的）' },
    { path: '/var/log/btmp.1',   label: '失败登录记录（滚动归档）' },
    { path: '/var/log/caddy/im-access.log',   label: '网站访问日志' },
    { path: '/var/log/caddy/im-access.log.1', label: '网站访问日志（归档）' }
  ].map(f => {
    let size = 0, mtime = Date.now()
    try { const st = fs.statSync(f.path); size = st.size; mtime = st.mtimeMs } catch {}
    return { name: f.label, path: f.path, size, ageDays: Math.floor((Date.now() - mtime) / 86400000) }
  }).filter(f => f.size > 0)

  result.sysTrash = {
    label: '系统垃圾（失败登录记录、访问日志）',
    count: sysFiles.length,
    bytes: sysFiles.reduce((s, f) => s + f.size, 0),
    items: sysFiles,
    more: 0,
    canClean: true
  }

  // 单独列一项：需要 root 的日志
  result.systemLogs = {
    label: '⚠️ 认证日志（不能删，fail2ban 靠它防爆破）',
    count: logFiles.length,
    bytes: logBytes,
    items: logFiles.sort((a, b) => b.size - a.size).slice(0, 8).map(f => ({
      name: f.name, size: f.size, ageDays: Math.floor((Date.now() - f.mtime) / 86400000)
    })),
    more: Math.max(0, logFiles.length - 8),
    canClean: false
  }

  result.totalBytes = result.media.bytes + result.thumbs.bytes + result.backups.bytes + result.logs.bytes
  return result
}

/** 按类别清理 */
export function cleanGarbage(category, usedMediaIds, dbRemoveFn) {
  const out = { removed: 0, freedBytes: 0, errors: [] }

  if (category === 'media') {
    const files = listFiles(MEDIA_DIR)
    for (const f of files) {
      const id = f.name.replace(/\.enc$/, '').replace(/\.bin$/, '')
      if (usedMediaIds.has(id)) continue
      try {
        fs.unlinkSync(path.join(MEDIA_DIR, f.name))
        out.removed++
        out.freedBytes += f.size
      } catch (e) { out.errors.push(f.name + ': ' + e.message) }
    }
  }

  if (category === 'thumbs') {
    const mediaFiles = listFiles(MEDIA_DIR)
    for (const f of listFiles(THUMB_DIR)) {
      const baseId = f.name.split('_')[0]
      if (mediaFiles.some(m => m.name.startsWith(baseId))) continue
      try {
        fs.unlinkSync(path.join(THUMB_DIR, f.name))
        out.removed++
        out.freedBytes += f.size
      } catch (e) { out.errors.push(f.name + ': ' + e.message) }
    }
  }

  if (category === 'backups') {
    const backups = listFiles(BACKUP_DIR, (n) => /\.(tar\.gz|db\.gz|db)$/.test(n))
    for (const f of backups.slice(3)) {
      try {
        fs.unlinkSync(path.join(BACKUP_DIR, f.name))
        out.removed++
        out.freedBytes += f.size
      } catch (e) { out.errors.push(f.name + ': ' + e.message) }
    }
  }

  if (category === 'pcp') {
    try {
      // 先停服务，否则删了又生成
      execSync('sudo -n systemctl stop pmcd pmlogger pmproxy 2>/dev/null || true', { timeout: 20000 })
      const before = (() => {
        try { return parseInt(execSync('du -sb /var/log/pcp 2>/dev/null | cut -f1', { encoding: 'utf8' }).trim(), 10) || 0 } catch { return 0 }
      })()
      execSync('sudo -n find /var/log/pcp -type f -delete 2>/dev/null || find /var/log/pcp -type f -delete 2>/dev/null || true', { timeout: 30000 })
      const after = (() => {
        try { return parseInt(execSync('du -sb /var/log/pcp 2>/dev/null | cut -f1', { encoding: 'utf8' }).trim(), 10) || 0 } catch { return 0 }
      })()
      out.freedBytes = Math.max(0, before - after)
      out.removed = out.freedBytes > 0 ? 1 : 0
      if (out.freedBytes === 0) out.errors.push('pcp 目录已经空了，或者没权限')
    } catch (e) { out.errors.push('pcp: ' + e.message) }
  }

  if (category === 'sysTrash') {
    const targets = [
      '/var/log/btmp', '/var/log/btmp.1',
      '/var/log/caddy/im-access.log', '/var/log/caddy/im-access.log.1'
    ]
    for (const t of targets) {
      let before = 0
      try { before = fs.statSync(t).size } catch { continue }
      if (before === 0) continue
      try {
        execSync('sudo -n truncate -s 0 ' + t + ' 2>/dev/null || truncate -s 0 ' + t + ' 2>/dev/null || true', { timeout: 10000 })
        let after = 0
        try { after = fs.statSync(t).size } catch {}
        if (after < before) {
          out.removed++
          out.freedBytes += (before - after)
        }
      } catch (e) { out.errors.push(t + ': ' + e.message) }
    }
  }

  if (category === 'logs') {
    // 先记下清理前的大小
    let before = 0
    try {
      const o = execSync('journalctl --disk-usage 2>/dev/null || true', { encoding: 'utf8' })
      const m = o.match(/([\d.]+)\s*([KMG])/i)
      if (m) before = Math.round(parseFloat(m[1]) * (m[2].toUpperCase() === 'G' ? 1073741824 : m[2].toUpperCase() === 'M' ? 1048576 : 1024))
    } catch {}
    try {
      // 用 sudo（sudoers 里只放行了这两条命令）
      execSync('sudo -n journalctl --vacuum-time=7d 2>/dev/null || journalctl --vacuum-time=7d 2>/dev/null || true', { timeout: 40000 })
      execSync('sudo -n journalctl --vacuum-size=100M 2>/dev/null || journalctl --vacuum-size=100M 2>/dev/null || true', { timeout: 40000 })
      // 算清理后
      let after = 0
      try {
        const o2 = execSync('journalctl --disk-usage 2>/dev/null || true', { encoding: 'utf8' })
        const m2 = o2.match(/([\d.]+)\s*([KMG])/i)
        if (m2) after = Math.round(parseFloat(m2[1]) * (m2[2].toUpperCase() === 'G' ? 1073741824 : m2[2].toUpperCase() === 'M' ? 1048576 : 1024))
      } catch {}
      out.freedBytes = Math.max(0, before - after)
      out.removed = out.freedBytes > 0 ? 1 : 0
      if (out.freedBytes === 0) {
        out.errors.push('journal 已经是最小状态（没有超过 7 天的条目）')
      }
    } catch (e) { out.errors.push('journal: ' + e.message) }
  }

  return out
}

export { MEDIA_DIR, THUMB_DIR, BACKUP_DIR }
