/**
 * IM 存储层（node:sqlite，零额外依赖）
 *
 * 数据模型：
 *   users                账号（手机号 + scrypt 密码哈希）
 *   sessions             登录 token
 *   conversations        会话（1v1 用排序后的 "u1|u2" 做唯一键，防重复建）
 *   conversation_members 成员 + 各自已读位置
 *   messages             消息，seq 在会话内单调递增
 *   conversation_counters seq 分配器（事务内 +1，避免并发抢号）
 */
import { DatabaseSync } from 'node:sqlite'
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data.db')

export const db = new DatabaseSync(DB_FILE)

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    phone      TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    avatar     TEXT NOT NULL DEFAULT '',
    salt       TEXT NOT NULL,
    pass_hash  TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id         TEXT PRIMARY KEY,
    type       TEXT NOT NULL DEFAULT 'direct',
    uniq_key   TEXT NOT NULL UNIQUE,
    title      TEXT NOT NULL DEFAULT '',
    owner_id   TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conversation_members (
    conv_id       TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_seq INTEGER NOT NULL DEFAULT 0,
    joined_at     INTEGER NOT NULL,
    PRIMARY KEY (conv_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS conversation_counters (
    conv_id  TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    last_seq INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         TEXT PRIMARY KEY,
    conv_id    TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    body       TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'text',
    client_id  TEXT,
    reply_to   TEXT,
    created_at INTEGER NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER,
    UNIQUE (conv_id, seq),
    UNIQUE (conv_id, client_id)
  );

  CREATE INDEX IF NOT EXISTS idx_msg_conv_seq ON messages(conv_id, seq DESC);
  CREATE INDEX IF NOT EXISTS idx_members_user  ON conversation_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  -- 端到端加密：用户公钥包（服务器只能存公钥，解不开任何消息）
  -- 端到端加密：群聊 SenderKey 分发包（服务器只搬运密文）
  CREATE TABLE IF NOT EXISTS e2ee_group_state (
    conv_id    TEXT NOT NULL,
    user_id    TEXT NOT NULL,   -- 谁在发
    target_id  TEXT NOT NULL,   -- 分给谁
    epoch      INTEGER NOT NULL,
    payload    TEXT NOT NULL,   -- 已用一对一会话密钥加密
    created_at INTEGER NOT NULL,
    PRIMARY KEY (conv_id, user_id, target_id, epoch)
  );

  CREATE TABLE IF NOT EXISTS e2ee_bundles (
    user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    bundle     TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS images (
    id         TEXT PRIMARY KEY,
    owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mime       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'image',
    name       TEXT NOT NULL DEFAULT '',
    duration   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_images_owner ON images(owner_id);

  CREATE TABLE IF NOT EXISTS push_subs (
    endpoint   TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    ua         TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_push_user ON push_subs(user_id);

  CREATE TABLE IF NOT EXISTS moments (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_moments_time ON moments(created_at DESC);

  CREATE TABLE IF NOT EXISTS moment_images (
    moment_id TEXT NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
    url       TEXT NOT NULL,
    sort      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (moment_id, url)
  );

  CREATE TABLE IF NOT EXISTS moment_likes (
    moment_id  TEXT NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (moment_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS moment_comments (
    id         TEXT PRIMARY KEY,
    moment_id  TEXT NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS listen_state (
    conv_id    TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    audio_id   TEXT NOT NULL,          -- 音频媒体 id
    title      TEXT NOT NULL DEFAULT '',
    host_id    TEXT NOT NULL,
    position   REAL NOT NULL DEFAULT 0, -- 秒
    playing    INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,       -- 开始播放时的服务器时间
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS message_stars (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, message_id)
  );

  CREATE TABLE IF NOT EXISTS anon_questions (
    id          TEXT PRIMARY KEY,
    target_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    asker_hash  TEXT NOT NULL,        -- 提问者的匿名指纹（不可反查）
    question    TEXT NOT NULL,
    answer      TEXT,
    created_at  INTEGER NOT NULL,
    answered_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_anon_target ON anon_questions(target_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS checkins (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day        TEXT NOT NULL,          -- YYYY-MM-DD
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, day)
  );
  CREATE INDEX IF NOT EXISTS idx_checkin_day ON checkins(day);

  CREATE TABLE IF NOT EXISTS polls (
    id         TEXT PRIMARY KEY,
    conv_id    TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    question   TEXT NOT NULL,
    options    TEXT NOT NULL,          -- JSON 数组
    multi      INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id      TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    option_index INTEGER NOT NULL,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (poll_id, user_id, option_index)
  );

  CREATE TABLE IF NOT EXISTS friends (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    friend_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, friend_id)
  );
  CREATE INDEX IF NOT EXISTS idx_friends_user ON friends(user_id);

  CREATE TABLE IF NOT EXISTS friend_requests (
    id         TEXT PRIMARY KEY,
    from_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message    TEXT,
    status     TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    handled_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_freq_to ON friend_requests(to_id, status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_freq_once ON friend_requests(from_id, to_id, status);

  CREATE TABLE IF NOT EXISTS reports (
    id          TEXT PRIMARY KEY,
    reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    reporter    TEXT,
    target_id   TEXT,
    target_name TEXT,
    reason      TEXT NOT NULL,
    detail      TEXT,
    message_id  TEXT,
    status      TEXT NOT NULL DEFAULT 'open',
    created_at  INTEGER NOT NULL,
    handled_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_reports_time ON reports(created_at DESC);

  CREATE TABLE IF NOT EXISTS feedback (
    id         TEXT PRIMARY KEY,
    user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
    user_name  TEXT,
    content    TEXT NOT NULL,
    contact    TEXT,
    device     TEXT,
    version    TEXT,
    image      TEXT,
    status     TEXT NOT NULL DEFAULT 'open',
    reply      TEXT,
    created_at INTEGER NOT NULL,
    handled_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_feedback_time ON feedback(created_at DESC);

  CREATE TABLE IF NOT EXISTS message_edits (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    old_body   TEXT NOT NULL,
    edited_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_edits_msg ON message_edits(message_id, edited_at);

  CREATE TABLE IF NOT EXISTS message_reactions (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
  );
  CREATE INDEX IF NOT EXISTS idx_react_msg ON message_reactions(message_id);

  CREATE TABLE IF NOT EXISTS topics (
    id         TEXT PRIMARY KEY,
    conv_id    TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_topics_conv ON topics(conv_id, created_at);

  CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS blocks (
    blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id)
  );
`)

/* ------------------------------------------------------------------ */
/*  增量迁移：给已存在的库补齐新列（老库升级不丢数据）                  */
/* ------------------------------------------------------------------ */
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`)
    console.log(`[db] 迁移: ${table}.${column} 已添加`)
  }
}

// 群聊
ensureColumn('conversations', 'title', "TEXT NOT NULL DEFAULT ''")
ensureColumn('conversations', 'owner_id', 'TEXT')
// 密聊会话标记：1 = 走端到端加密，服务器解不开内容
ensureColumn('conversations', 'is_secret', 'INTEGER NOT NULL DEFAULT 0')
// 消息引用 + 撤回
ensureColumn('messages', 'reply_to', 'TEXT')
ensureColumn('messages', 'deleted_at', 'INTEGER')
// 媒体表扩展为 image / voice / file 通用
ensureColumn('images', 'kind', "TEXT NOT NULL DEFAULT 'image'")
ensureColumn('images', 'name', "TEXT NOT NULL DEFAULT ''")
ensureColumn('images', 'duration', 'INTEGER NOT NULL DEFAULT 0')
// 会话级设置：免打扰 / 置顶 / 从我的列表里删掉
ensureColumn('conversation_members', 'muted', 'INTEGER NOT NULL DEFAULT 0')
ensureColumn('conversation_members', 'pinned', 'INTEGER NOT NULL DEFAULT 0')
ensureColumn('conversation_members', 'hidden', 'INTEGER NOT NULL DEFAULT 0')
// 管理员：能看所有人的消息、删任何人的内容
ensureColumn('users', 'role', "TEXT NOT NULL DEFAULT 'user'")
// 谁撤回的（用来区分「自己撤回」「管理员已撤回」「群主已撤回」）
ensureColumn('messages', 'deleted_by', 'TEXT')
// 消息里的 @ 提及（JSON 数组：["u_xxx", "all"]）
ensureColumn('messages', 'mentions', 'TEXT')
// 消息编辑时间
ensureColumn('messages', 'edited_at', 'INTEGER')
// 消息属于哪个话题（空表示主聊天）
ensureColumn('messages', 'topic_id', 'TEXT')
// 阅后即焚：读后多少秒自动删除（0/空 = 不焚）
ensureColumn('messages', 'burn_after', 'INTEGER')
// 禁止转发：发送时勾上，别人转不出去
ensureColumn('messages', 'no_forward', 'INTEGER NOT NULL DEFAULT 0')
// 登录设备信息：用来做「登录设备管理」
ensureColumn('sessions', 'device', 'TEXT')
ensureColumn('sessions', 'ip', 'TEXT')
// 用户对外 ID（代替手机号给别人加好友用）
ensureColumn('users', 'im_id', 'TEXT')
// 元老：早期注册的用户，可以自定义靓号 ID
ensureColumn('users', 'is_veteran', 'INTEGER NOT NULL DEFAULT 0')
// 超级管理员：只有他能任免其他管理员，且任何人都不能降他的级
ensureColumn('users', 'is_super', 'INTEGER NOT NULL DEFAULT 0')
// 自定义头衔：留空则显示默认（开发者 / 超级管理员）
ensureColumn('users', 'title', 'TEXT')
ensureColumn('users', 'title_color', 'TEXT')
// 隐私开关：默认都开
ensureColumn('users', 'show_online', 'INTEGER NOT NULL DEFAULT 1')
ensureColumn('users', 'show_read', 'INTEGER NOT NULL DEFAULT 1')
// 界面偏好
// 两步验证：密钥（base32）+ 是否开启
ensureColumn('users', 'totp_secret', 'TEXT')
ensureColumn('users', 'totp_on', 'INTEGER NOT NULL DEFAULT 0')
// 消息水印：聊天背景淡显自己的 ID，防截图外传
ensureColumn('users', 'watermark', 'INTEGER NOT NULL DEFAULT 0')
// 谁能给我发消息：all=所有人 friend=有过对话的人 none=谁都不行
ensureColumn('users', 'msg_policy', 'TEXT')
ensureColumn('users', 'font_size', 'TEXT')       // 空/normal/large/xlarge
ensureColumn('users', 'bubble_style', 'TEXT')    // 空/round/square
// 免打扰时间段："22:00-08:00"，空表示全天可打扰
ensureColumn('conversation_members', 'quiet_hours', 'TEXT')
// 朋友圈评论可以回复某条评论
ensureColumn('moment_comments', 'reply_to', 'TEXT')
// 朋友圈动态可以带地点
ensureColumn('moments', 'location', 'TEXT')
// 群公告和群头像
ensureColumn('conversations', 'announcement', 'TEXT')
ensureColumn('conversations', 'avatar', 'TEXT')
// 群置顶消息
ensureColumn('conversations', 'pinned_msg_id', 'TEXT')
// 消息保留秒数（0 或空 = 永久）；到点由后台任务清掉
ensureColumn('conversations', 'ttl', 'INTEGER NOT NULL DEFAULT 0')
// 群邀请码：进群链接用，空表示没开启
ensureColumn('conversations', 'invite_code', 'TEXT')
// 慢速模式：普通成员每隔几秒才能发一条（0 = 关闭）
ensureColumn('conversations', 'slow_mode', 'INTEGER NOT NULL DEFAULT 0')
// 频道是否公开（公开的会出现在「发现频道」里）
ensureColumn('conversations', 'is_public', 'INTEGER NOT NULL DEFAULT 0')
// 群内角色：member / group_admin（群主由 conversations.owner_id 决定）
ensureColumn('conversation_members', 'role', "TEXT NOT NULL DEFAULT 'member'")
// 群内自定义头衔（群主/开发者可设置，如「话痨」「技术顾问」）
ensureColumn('conversation_members', 'title', 'TEXT')
// 头衔颜色（存色号，如 #f76b1c；空表示用默认橙）
ensureColumn('conversation_members', 'title_color', 'TEXT')
// 特别关心：这个人的消息会特殊提醒
ensureColumn('conversation_members', 'starred', 'INTEGER NOT NULL DEFAULT 0')
// 会话分类（每个人自己的分组，空表示未分类）
ensureColumn('conversation_members', 'folder', 'TEXT')
// 细粒度权限：JSON 对象，空表示用默认（成员只能发消息）
ensureColumn('conversation_members', 'perms', 'TEXT')

const now = () => Date.now()
const uid = (p) => p + randomBytes(8).toString('hex')

/* ------------------------------------------------------------------ */
/*  消息内容加密（静态加密 / encryption at rest）                       */
/*                                                                     */
/*  背景：数据库文件落在云厂商的磁盘上。TLS 只保护"传输中"，一旦有人   */
/*  拿到磁盘镜像（快照泄露、运维误操作、机器被回收），明文消息就全裸。 */
/*  这里用 AES-256-GCM 把 body 加密后入库，密钥只存在服务端本地文件。  */
/*                                                                     */
/*  注意这不是端到端加密：服务端需要解密才能把消息发给对方。          */
/*  防的是"拿到磁盘的人"，不是"服务端本身"。                         */
/* ------------------------------------------------------------------ */

const ENC_PREFIX = 'enc:v1:'
let _msgKey = null

function messageKey() {
  if (_msgKey) return _msgKey
  // 1) 优先环境变量（部署脚本会生成）
  const env = process.env.MSG_KEY
  if (env && /^[0-9a-f]{64}$/i.test(env)) {
    _msgKey = Buffer.from(env, 'hex')
    return _msgKey
  }
  // 2) 其次数据目录下的密钥文件（首次自动生成，权限 600）
  const keyFile = path.join(path.dirname(DB_FILE), 'msg.key')
  try {
    if (fs.existsSync(keyFile)) {
      const raw = fs.readFileSync(keyFile, 'utf8').trim()
      if (/^[0-9a-f]{64}$/i.test(raw)) {
        _msgKey = Buffer.from(raw, 'hex')
        return _msgKey
      }
    }
    const fresh = randomBytes(32)
    fs.writeFileSync(keyFile, fresh.toString('hex'), { mode: 0o600 })
    console.log('[crypto] 已生成消息加密密钥:', keyFile)
    _msgKey = fresh
    return _msgKey
  } catch (e) {
    // 读不到就降级明文，但必须吼出来，不能悄悄不加密
    console.warn('[crypto] 密钥不可用，消息将以明文存储:', e.message)
    return null
  }
}

function encryptBody(plain) {
  const key = messageKey()
  if (!key) return plain
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return (
    ENC_PREFIX +
    [iv, tag, ct].map((b) => b.toString('base64url')).join(':')
  )
}

function decryptBody(stored) {
  if (typeof stored !== 'string' || !stored.startsWith(ENC_PREFIX)) {
    // 兼容加密功能上线前的明文数据
    return stored
  }
  const key = messageKey()
  if (!key) return '[无法解密：密钥缺失]'
  try {
    const [ivB, tagB, ctB] = stored.slice(ENC_PREFIX.length).split(':')
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64url'))
    d.setAuthTag(Buffer.from(tagB, 'base64url'))
    return Buffer.concat([d.update(Buffer.from(ctB, 'base64url')), d.final()]).toString('utf8')
  } catch {
    return '[解密失败]'
  }
}

/** 换密钥时用：把库里的密文全部重加密（改 MSG_KEY 后跑一次） */
export function reencryptAll(oldKeyHex, newKeyHex) {
  const oldKey = Buffer.from(oldKeyHex, 'hex')
  const newKey = Buffer.from(newKeyHex, 'hex')
  const rows = db.prepare(`SELECT id, body FROM messages WHERE body LIKE '${ENC_PREFIX}%'`).all()
  const upd = db.prepare('UPDATE messages SET body = ? WHERE id = ?')
  db.exec('BEGIN')
  try {
    for (const r of rows) {
      const [ivB, tagB, ctB] = r.body.slice(ENC_PREFIX.length).split(':')
      const d = createDecipheriv('aes-256-gcm', oldKey, Buffer.from(ivB, 'base64url'))
      d.setAuthTag(Buffer.from(tagB, 'base64url'))
      const plain = Buffer.concat([d.update(Buffer.from(ctB, 'base64url')), d.final()]).toString('utf8')
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', newKey, iv)
      const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
      upd.run(ENC_PREFIX + [iv, c.getAuthTag(), ct].map((b) => b.toString('base64url')).join(':'), r.id)
    }
    db.exec('COMMIT')
    return rows.length
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/* ------------------------------------------------------------------ */
/*  账号                                                               */
/* ------------------------------------------------------------------ */

const stInsertUser = db.prepare(`
  INSERT INTO users (id, phone, name, avatar, salt, pass_hash, created_at, im_id, is_veteran)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
const stUserByPhone = db.prepare('SELECT * FROM users WHERE phone = ?')
const stUserById = db.prepare('SELECT * FROM users WHERE id = ?')

const hashPassword = (password, salt) => scryptSync(password, salt, 64).toString('hex')

export function normalizePhone(raw) {
  const s = String(raw || '').replace(/[\s-]/g, '').replace(/^\+86/, '')
  if (!/^1[3-9]\d{9}$/.test(s)) throw statusError(400, '手机号格式不对')
  return s
}

/** 密码强度：至少 8 位，含字母和数字 */
export function checkPasswordStrength(pw) {
  const s = String(pw || '')
  if (s.length < 8) return '密码至少 8 位'
  if (!/[a-zA-Z]/.test(s)) return '密码要包含字母'
  if (!/[0-9]/.test(s)) return '密码要包含数字'
  return null
}

export function register({ phone, password, name, invite }) {
  // 只有几个朋友用 —— 开放注册等于把服务器地址泄露就等于被陌生人挤进来
  const required = (process.env.INVITE_CODE || '').trim()
  if (required && String(invite || '').trim() !== required) {
    throw statusError(403, '邀请码不对')
  }
  const p = normalizePhone(phone)
  const pass = String(password || '')
  const weak = checkPasswordStrength(pass)
  if (weak) throw statusError(400, weak)
  const nick = String(name || '').trim() || '用户' + p.slice(-4)
  if (stUserByPhone.get(p)) throw statusError(409, '这个手机号已经注册过')

  const salt = randomBytes(16).toString('hex')
  const id = uid('u_')
  const userCount = db.prepare('SELECT COUNT(*) n FROM users').get().n
  const veteran = userCount < 10 ? 1 : 0   // 前 10 个注册的是元老
  stInsertUser.run(id, p, nick, '', salt, hashPassword(pass, salt), now(), genImId(), veteran)
  return publicUser(stUserById.get(id))
}

export function login({ phone, password, imId, totpCode }) {
  // 支持用 ID 或手机号登录
  // 注意：不能只靠"长得像不像手机号"来分流 —— 如果有人把 ID 设成
  // 13800008888 这种 11 位且 1 开头的数字，会被前端当成手机号，
  // 那样用 ID 就登不进去了。所以手机号查不到时，再按 ID 试一次。
  let row
  const idLike = String(imId || phone || '').trim()
  if (imId) {
    row = db.prepare('SELECT * FROM users WHERE im_id = ?').get(String(imId).trim())
  } else {
    // normalizePhone 对非手机号会抛错，先兜住，再按 ID 试
    try {
      row = stUserByPhone.get(normalizePhone(phone))
    } catch (e) {
      row = undefined
    }
    if (!row && idLike) {
      row = db.prepare('SELECT * FROM users WHERE im_id = ?').get(idLike)
    }
  }
  // 账号不存在也走一遍哈希，避免用响应时间探测哪些号注册过
  const salt = row?.salt ?? 'x'.repeat(32)
  const expect = row?.pass_hash ?? 'x'.repeat(128)
  const actual = hashPassword(String(password || ''), salt)
  const okLen = expect.length === actual.length
  const ok = okLen && timingSafeEqual(Buffer.from(expect, 'hex'), Buffer.from(actual, 'hex'))
  if (!row || !ok) throw statusError(401, '账号或密码不对')

  // 两步验证：开了就必须带正确的 6 位码
  if (row.totp_on) {
    if (!totpCode) {
      const e = statusError(401, '需要两步验证码')
      e.needTotp = true
      throw e
    }
    const secretBuf = base32Decode(row.totp_secret || '')
    const counter = Math.floor(Date.now() / 30000)
    const input = String(totpCode).replace(/\D/g, '')
    let okTotp = false
    for (let i = -1; i <= 1; i++) {
      if (hotp(secretBuf, counter + i) === input) { okTotp = true; break }
    }
    if (!okTotp) {
      const e = statusError(401, '验证码不对')
      e.needTotp = true
      throw e
    }
  }

  return publicUser(row)
}

/** 对外输出的用户对象，永远不带 salt / pass_hash */
export function publicUser(row) {
  if (!row) return null
  return { id: row.id, phone: row.phone, name: row.name, avatar: row.avatar, role: row.role || 'user', imId: row.im_id || '', isVeteran: !!row.is_veteran, isSuper: !!row.is_super, title: row.title || '', titleColor: row.title_color || '',
    showOnline: row.show_online !== 0, showRead: row.show_read !== 0,
    fontSize: row.font_size || 'normal', bubbleStyle: row.bubble_style || 'round',
    watermark: row.watermark === 1,
    msgPolicy: row.msg_policy || 'all' }
}

export function getUser(id) {
  return publicUser(stUserById.get(id))
}

export function updateProfile(userId, { name, avatar }) {
  const u = stUserById.get(userId)
  if (!u) throw statusError(404, '用户不存在')
  const n = name === undefined ? u.name : String(name).trim() || u.name
  const a = avatar === undefined ? u.avatar : String(avatar)
  db.prepare('UPDATE users SET name = ?, avatar = ? WHERE id = ?').run(n, a, userId)
  return publicUser(stUserById.get(userId))
}

/** 按手机号找人（加好友 / 发起会话时用） */
/**
 * 我认识的人 = 和我有共同会话的人（一对一的对方 + 群里的其他成员）。
 * 不列全部用户，避免陌生人注册后混进选人列表。
 */
/** 生成一个没被占用的数字 ID（6 位，不以 0 开头） */
export function genImId() {
  for (let i = 0; i < 200; i++) {
    const id = String(Math.floor(100000 + Math.random() * 900000))
    if (!db.prepare('SELECT 1 x FROM users WHERE im_id = ?').get(id)) return id
  }
  throw statusError(500, 'ID 生成失败，重试')
}

/** 老用户没有 ID 或还是字母 ID 的，补成数字 ID */
function backfillImIds() {
  const all = db.prepare('SELECT id, im_id FROM users').all()
  let fixed = 0
  for (const r of all) {
    if (!r.im_id || !/^\d+$/.test(r.im_id)) {
      db.prepare('UPDATE users SET im_id = ? WHERE id = ?').run(genImId(), r.id)
      fixed++
    }
  }
  if (fixed) console.log(`[db] 已为 ${fixed} 个用户换成数字 ID`)
}
backfillImIds()

/** 前 10 个注册的都是元老 */
function backfillVeterans() {
  const list = db.prepare('SELECT id FROM users ORDER BY created_at LIMIT 10').all()
  if (!list.length) return
  const st = db.prepare('UPDATE users SET is_veteran = 1 WHERE id = ? AND is_veteran = 0')
  for (const u of list) st.run(u.id)
}
backfillVeterans()

/** 改自己的 ID（唯一性校验） */
/**
 * 设置某个用户的 ID。
 * 规则：ID 不允许自行修改，只有开发者可以通过管理后台分配。
 */
export function setImId(targetUserId, raw, byUserId) {
  const by = stUserById.get(byUserId)
  if (!by || by.role !== 'admin') throw statusError(403, '只有开发者能设置 ID')
  const target = stUserById.get(targetUserId)
  if (!target) throw statusError(404, '用户不存在')
  const id = String(raw || '').trim()
  if (!/^\d{4,10}$/.test(id)) throw statusError(400, 'ID 只能是 4-10 位数字')
  const taken = db.prepare('SELECT name FROM users WHERE im_id = ? AND id <> ?').get(id, targetUserId)
  if (taken) throw statusError(409, '这个号码已经被 ' + taken.name + ' 占用')
  db.prepare('UPDATE users SET im_id = ? WHERE id = ?').run(id, targetUserId)
  return publicUser(stUserById.get(targetUserId))
}

/** 按 ID 或手机号找人 */
export function findByImId(imId) {
  const row = db.prepare('SELECT * FROM users WHERE im_id = ?').get(String(imId || '').trim().toLowerCase())
  return publicUser(row)
}

export function listContacts(userId) {
  return db.prepare(`
    SELECT DISTINCT u.id, u.name, u.phone, u.avatar, u.role
    FROM conversation_members me
    JOIN conversation_members other
      ON other.conv_id = me.conv_id AND other.user_id <> me.user_id
    JOIN users u ON u.id = other.user_id
    WHERE me.user_id = ? AND u.id <> ?
    ORDER BY u.name
  `).all(userId, userId).map((u) => ({
    id: u.id, name: u.name, phone: u.phone, avatar: u.avatar, role: u.role,
    imId: db.prepare('SELECT im_id FROM users WHERE id = ?').get(u.id)?.im_id || ''
  }))
}

export function findUserByPhone(phone) {
  const p = normalizePhone(phone)
  return publicUser(stUserByPhone.get(p))
}

/* ------------------------------------------------------------------ */
/*  会话 token                                                         */
/* ------------------------------------------------------------------ */

const SESSION_TTL = 30 * 24 * 3600 * 1000
const stInsertSession = db.prepare(
  'INSERT INTO sessions (token, user_id, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?)'
)
const stSession = db.prepare('SELECT * FROM sessions WHERE token = ?')
const stTouchSession = db.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?')
const stDeleteSession = db.prepare('DELETE FROM sessions WHERE token = ?')

/** 从 User-Agent 解析出人看得懂的设备描述 */
export function parseDevice(ua) {
  const s = String(ua || '')
  if (!s) return '未知设备'

  let type = '设备'
  let os = ''
  let model = ''
  let app = ''

  // ── iPhone / iPad ──
  if (/iPhone/i.test(s)) { type = '手机'; os = 'iOS'; model = 'iPhone' }
  else if (/iPad/i.test(s)) { type = '平板'; os = 'iPadOS'; model = 'iPad' }
  else if (/iPod/i.test(s)) { type = '设备'; os = 'iOS'; model = 'iPod' }

  // ── Android ──
  if (/Android/i.test(s)) {
    const m = s.match(/Android\s+([\d.]+)/i)
    const ver = m ? m[1] : ''
    // 型号：Android x; 型号 Build/
    const mm = s.match(/Android[^;]*;\s*([^;)]+?)\s*(?:Build|;|\))/i)
    model = mm ? mm[1].trim() : ''
    os = 'Android' + (ver ? ' ' + ver : '')
    const isTablet = /Tablet|Pad/i.test(s) || (!/Mobile/i.test(s) && /Android/i.test(s))
    type = isTablet ? '平板' : '手机'
    // WebView 里跑的就是我们的 App
    if (/;\s*wv\)/.test(s) || /Version\/[\d.]+\s+Chrome/i.test(s) && /; wv\)/.test(s)) app = '悄悄 App'
  }

  // ── Windows ──
  if (/Windows NT 10/i.test(s)) { type = '电脑'; os = 'Windows 10/11' }
  else if (/Windows NT 6\.3/i.test(s)) { type = '电脑'; os = 'Windows 8.1' }
  else if (/Windows NT 6\.1/i.test(s)) { type = '电脑'; os = 'Windows 7' }
  else if (/Windows/i.test(s) && !os) { type = '电脑'; os = 'Windows' }

  // ── macOS ──
  if (/Mac OS X|Macintosh/i.test(s) && !os) {
    type = '电脑'
    os = 'macOS'
    model = 'Mac'
  }

  // ── Linux ──
  if (/Linux/i.test(s) && !/Android/i.test(s) && !os) { type = '电脑'; os = 'Linux' }

  // ── 浏览器 / App ──
  if (!app) {
    if (/Edg\//i.test(s)) app = 'Edge'
    else if (/OPR\/|Opera/i.test(s)) app = 'Opera'
    else if (/Firefox\//i.test(s)) app = 'Firefox'
    else if (/Chrome\//i.test(s) && !/Edg|OPR/i.test(s)) app = 'Chrome'
    else if (/Safari\//i.test(s) && !/Chrome/i.test(s)) app = 'Safari'
    else if (/curl|node|python/i.test(s)) app = '程序'
  }

  // 组装：手机 PLK110 · Android 17 · 悄悄 App
  const parts = []
  if (type && type !== '设备') parts.push(type)
  if (model && model !== type) parts.push(model)
  if (os) parts.push(os)
  if (app) parts.push(app)
  return parts.length ? parts.join(' · ') : '未知设备'
}

export function createSession(userId, meta = {}) {
  const token = randomBytes(32).toString('hex')
  const t = now()
  stInsertSession.run(token, userId, t, t + SESSION_TTL, t)
  // 记下设备，方便「登录设备管理」
  try {
    db.prepare('UPDATE sessions SET device = ?, ip = ? WHERE token = ?')
      .run(parseDevice(meta.device).slice(0, 120), String(meta.ip || '').slice(0, 60), token)
  } catch {}
  return token
}

/** 这个用户的所有登录设备 */
export function myDevices(userId, currentToken) {
  const rows = db.prepare(`
    SELECT token, created_at, last_seen, device, ip
    FROM sessions WHERE user_id = ? AND expires_at > ?
    ORDER BY last_seen DESC LIMIT 20
  `).all(userId, now())
  return rows.map((r) => {
    // 老的会话里存的是原始 UA，这里再解析一次
    let dev = r.device || ''
    if (dev && (dev.indexOf('Mozilla') === 0 || dev.indexOf('/') >= 0)) {
      dev = parseDevice(dev)
    }
    return {
      token: r.token.slice(0, 8) + '…',
      isCurrent: r.token === currentToken,
      createdAt: r.created_at,
      lastSeen: r.last_seen,
      device: dev || '未知设备',
      ip: r.ip || ''
    }
  })
}

/** 踢掉除当前以外的所有设备 */
export function kickOtherDevices(userId, currentToken) {
  const r = db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(userId, currentToken)
  return { kicked: r.changes || 0 }
}

/** 判断是不是新设备（同一 user 从没出现过的 device 串） */
export function isNewDevice(userId, device) {
  if (!device) return false
  const has = db.prepare(
    'SELECT 1 FROM sessions WHERE user_id = ? AND device = ? LIMIT 1'
  ).get(userId, device)
  return !has
}

export function userByToken(token) {
  if (!token) return null
  const s = stSession.get(token)
  if (!s) return null
  if (s.expires_at < now()) {
    stDeleteSession.run(token)
    return null
  }
  stTouchSession.run(now(), token)
  return publicUser(stUserById.get(s.user_id))
}

export function destroySession(token) {
  if (token) stDeleteSession.run(token)
}

/* ------------------------------------------------------------------ */
/*  会话                                                               */
/* ------------------------------------------------------------------ */

const stConvByKey = db.prepare('SELECT * FROM conversations WHERE uniq_key = ?')
const stInsertConv = db.prepare(
  'INSERT INTO conversations (id, type, uniq_key, title, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
)
const stInsertMember = db.prepare(
  'INSERT INTO conversation_members (conv_id, user_id, last_read_seq, joined_at) VALUES (?, ?, 0, ?)'
)
const stInsertCounter = db.prepare(
  'INSERT INTO conversation_counters (conv_id, last_seq) VALUES (?, ?)'
)
const stMembers = db.prepare(`
  SELECT m.user_id, m.last_read_seq, m.role, m.title, m.title_color,
         u.name, u.avatar, u.phone
  FROM conversation_members m JOIN users u ON u.id = m.user_id
  WHERE m.conv_id = ?
  ORDER BY m.joined_at
`)
const stIsMember = db.prepare(
  'SELECT 1 AS ok FROM conversation_members WHERE conv_id = ? AND user_id = ?'
)

/** 1v1 会话：两个人之间只有一条记录，谁先发起都一样 */
export function getOrCreateDirect(userA, userB) {
  if (userA === userB) throw statusError(400, '不能和自己建会话')
  if (!stUserById.get(userB)) throw statusError(404, '对方不存在')
  const key = [userA, userB].sort().join('|')
  const existing = stConvByKey.get(key)
  if (existing) return existing.id

  const id = uid('c_')
  const t = now()
  db.exec('BEGIN')
  try {
    stInsertConv.run(id, 'direct', key, '', null, t, t)
    stInsertMember.run(id, userA, t)
    stInsertMember.run(id, userB, t)
    stInsertCounter.run(id, 0)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    // 并发下可能被别人抢先建了，回头读一次
    const again = stConvByKey.get(key)
    if (again) return again.id
    throw e
  }
  return id
}

/** 密聊会话：同一对用户只有一条，uniq_key 用 secret: 前缀与普通会话区分 */
export function getOrCreateSecret(userA, userB) {
  if (userA === userB) throw statusError(400, '不能和自己建密聊')
  if (!stUserById.get(userB)) throw statusError(404, '对方不存在')
  const key = 'secret:' + [userA, userB].sort().join('|')
  const existing = stConvByKey.get(key)
  if (existing) {
    if (!existing.is_secret) db.prepare('UPDATE conversations SET is_secret = 1 WHERE id = ?').run(existing.id)
    return existing.id
  }

  const id = uid('c_')
  const t = now()
  db.exec('BEGIN')
  try {
    db.prepare(`INSERT INTO conversations (id, type, uniq_key, title, owner_id, created_at, updated_at, is_secret)
      VALUES (?, 'direct', ?, '', NULL, ?, ?, 1)`).run(id, key, t, t)
    stInsertMember.run(id, userA, t)
    stInsertMember.run(id, userB, t)
    stInsertCounter.run(id, 0)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    const again = stConvByKey.get(key)
    if (again) return again.id
    throw e
  }
  return id
}

/** 会话是不是密聊 */
export function isSecretConv(convId) {
  const c = stConvById.get(convId)
  return !!(c && c.is_secret && c.type === 'direct')
}

export function isMember(convId, userId) {
  return !!stIsMember.get(convId, userId)
}

/* ------------------------------------------------------------------ */
/*  群聊                                                               */
/* ------------------------------------------------------------------ */

const stConvById = db.prepare('SELECT * FROM conversations WHERE id = ?')
const stDeleteMember = db.prepare(
  'DELETE FROM conversation_members WHERE conv_id = ? AND user_id = ?'
)

export function getConversation(convId) {
  return stConvById.get(convId) || null
}

export function createGroup(ownerId, name, memberIds = [], type = 'group', isPublic = false) {
  const ids = [...new Set([ownerId, ...memberIds.map(String)])].filter((id) => stUserById.get(id))
  if (ids.length < 2) throw statusError(400, '群聊至少要有两个人')
  if (ids.length > 200) throw statusError(400, '群成员太多')

  const id = uid('c_')
  const t = now()
  db.exec('BEGIN IMMEDIATE')
  try {
    // 群没有"唯一键"概念，用 group:<id> 占住 UNIQUE 约束
    stInsertConv.run(id, type, type + ':' + id, String(name || '').slice(0, 40), ownerId, t, t)
    // 频道创建时就能选公开 / 私密
    if (type === 'channel' && isPublic) {
      try { db.prepare('UPDATE conversations SET is_public = 1 WHERE id = ?').run(id) } catch {}
    }
    for (const uidStr of ids) stInsertMember.run(id, uidStr, t)
    stInsertCounter.run(id, 0)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return id
}

export function addMember(convId, userId, byUserId) {
  const conv = stConvById.get(convId)
  if (!conv) throw statusError(404, '会话不存在')
  if (conv.type !== 'group') throw statusError(400, '只有群聊能加人')
  if (!isMember(convId, byUserId)) throw statusError(403, '你不在这个群里')
  if (!stUserById.get(userId)) throw statusError(404, '这个用户不存在')
  if (isMember(convId, userId)) return membersOf(convId)

  stInsertMember.run(convId, userId, now())
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now(), convId)
  return membersOf(convId)
}

/** 退群，或群主踢人 */
export function removeMember(convId, userId, byUserId) {
  const conv = stConvById.get(convId)
  if (!conv) throw statusError(404, '会话不存在')
  if (conv.type !== 'group') throw statusError(400, '一对一不能移除成员')
  // 等级：开发者 > 群主 > 群管理员 > 成员
  if (userId !== byUserId) {
    const byLvl = myLevel(convId, byUserId)
    const tLvl = myLevel(convId, userId)
    const allowed =
      byLvl === 'dev' ||
      (byLvl === 'owner' && tLvl !== 'dev') ||
      (byLvl === 'group_admin' && tLvl === 'member')
    if (!allowed) throw statusError(403, '权限不够，不能移除这个人')
  }
  // 群主不能直接退群 —— 必须先指定新群主（由前端弹窗选择并调用 /owner 转让）。
  // 这里做硬性拦截，避免「群主一退群就没群主了」这种坏状态。
  if (conv.owner_id === userId) {
    const restCount = db.prepare(
      'SELECT COUNT(*) n FROM conversation_members WHERE conv_id = ? AND user_id <> ?'
    ).get(convId, userId).n
    if (restCount > 0) {
      throw statusError(400, '群主退群前必须先指定新群主')
    }
  }

  stDeleteMember.run(convId, userId)

  // 群里一个人都不剩：把群删掉
  const left = db.prepare('SELECT COUNT(*) n FROM conversation_members WHERE conv_id = ?').get(convId).n
  if (left === 0) {
    db.prepare('DELETE FROM conversations WHERE id = ?').run(convId)
  }

  return membersOf(convId)
}

/** 群主转让 / 改群名 */
export function updateGroup(convId, userId, { title, announcement, avatar }) {
  const conv = stConvById.get(convId)
  if (!conv) throw statusError(404, '会话不存在')
  if (conv.type !== 'group') throw statusError(400, '不是群聊')
  // 开发者可以改任何群，其他人必须是自己参与的群
  if (!isAdmin(userId) && !isMember(convId, userId)) throw statusError(403, '你不在这个群里')
  if (title !== undefined) {
    db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(String(title).slice(0, 40), convId)
  }
  if (announcement !== undefined) {
    const text = String(announcement).slice(0, 500) || null
    db.prepare('UPDATE conversations SET announcement = ? WHERE id = ?').run(text, convId)
    // 发了新公告 → 往群里发一条系统提示，成员才看得到
    if (text) {
      try {
        const u = stUserById.get(userId)
        const who = u ? u.name : '管理员'
        // 用 pat 类型做系统消息（前端有专门的居中样式）
        sendMessage({
          convId,
          senderId: userId,
          body: JSON.stringify({ from: who, to: '全体成员', suffix: '更新了群公告 📢' }),
          kind: 'pat'
        })
      } catch {}
    }
  }
  if (avatar !== undefined) {
    db.prepare('UPDATE conversations SET avatar = ? WHERE id = ?')
      .run(String(avatar) || null, convId)
  }
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now(), convId)
  return stConvById.get(convId)
}

export function membersOf(convId) {
  const conv = stConvById.get(convId)
  const roleOf = db.prepare('SELECT role FROM conversation_members WHERE conv_id = ? AND user_id = ?')
  return stMembers.all(convId).map((r) => {
    let role = 'member'
    if (conv && conv.owner_id === r.user_id) role = 'owner'
    else {
      const x = roleOf.get(convId, r.user_id)
      if (x && x.role === 'group_admin') role = 'group_admin'
    }
    return {
      id: r.user_id, name: r.name, avatar: r.avatar, phone: r.phone,
      lastReadSeq: r.last_read_seq, role,
      title: r.title || '',
      titleColor: r.title_color || '',
      perms: permsOf(convId, r.user_id),
      online: false   // 由 server 层用 hub 补真实值
    }
  })
}

/** 会话列表：带对方信息、最后一条消息、未读数 */
const stConvsOfUser = db.prepare(`
  SELECT c.id, c.type, c.title, c.owner_id, c.created_at, c.updated_at,
         c.announcement, c.avatar, c.ttl, c.slow_mode, c.is_secret,
         m.last_read_seq, m.muted, m.pinned, m.starred, m.folder, m.quiet_hours
  FROM conversations c
  JOIN conversation_members m ON m.conv_id = c.id
  WHERE m.user_id = ? AND m.hidden = 0
  ORDER BY m.pinned DESC, c.updated_at DESC
`)
const stLastMessage = db.prepare(
  'SELECT * FROM messages WHERE conv_id = ? AND deleted = 0 ORDER BY seq DESC LIMIT 1'
)
const stUnread = db.prepare(`
  SELECT COUNT(*) AS n FROM messages
  WHERE conv_id = ? AND seq > ? AND sender_id <> ? AND deleted = 0
`)

/** 群的显示名：没设群名就用成员昵称拼一个 */
function groupTitle(title, members) {
  if (title) return title
  return members.map((m) => m.name).slice(0, 3).join('、') + (members.length > 3 ? '…' : '')
}

export function listConversations(userId) {
  return stConvsOfUser.all(userId).map((c) => {
    const members = membersOf(c.id)
    const isGroup = c.type === 'group'
    const peer = isGroup ? null : members.find((m) => m.id !== userId) || members[0]
    const last = stLastMessage.get(c.id)
    const unread = stUnread.get(c.id, c.last_read_seq, userId).n

    return {
      id: c.id,
      type: c.type,
      title: isGroup ? groupTitle(c.title, members) : null,
      announcement: c.announcement || '',
      pinnedMsgId: c.pinned_msg_id || null,
      ttl: c.ttl || 0,
      slowMode: c.slow_mode || 0,
      isPublic: !!c.is_public,
      isSecret: !!c.is_secret,
      avatar: c.avatar || '',
      ownerId: c.owner_id || null,
      peer,
      members: isGroup
        ? members.map((m) => ({
            id: m.id, name: m.name, avatar: m.avatar, online: m.online,
            role: m.role, title: m.title || '', titleColor: m.titleColor || ''
          }))
        : undefined,
      memberCount: members.length,
      // 群聊里要知道每个人读到哪了，用来显示「已读 3/5」
      readSeqs: members.map((m) => ({ userId: m.id, seq: m.last_read_seq })),
      lastMessage: last
        ? {
            id: last.id,
            seq: last.seq,
            body: last.deleted ? '' : decryptBody(last.body),
            kind: last.kind,
            senderId: last.sender_id,
            deleted: !!last.deleted,
            createdAt: last.created_at,
            mentions: last.mentions ? (() => { try { return JSON.parse(last.mentions) } catch { return [] } })() : []
          }
        : null,
      unread,
      muted: !!c.muted,
      pinned: !!c.pinned,
      starred: !!c.starred,
      folder: c.folder || '',
      quietHours: c.quiet_hours || '',
      myLastReadSeq: c.last_read_seq,
      updatedAt: c.updated_at
    }
  })
}

/* ------------------------------------------------------------------ */
/*  消息                                                               */
/* ------------------------------------------------------------------ */

const stBumpSeq = db.prepare(
  'UPDATE conversation_counters SET last_seq = last_seq + 1 WHERE conv_id = ? RETURNING last_seq'
)
const stInsertMessage = db.prepare(`
  INSERT INTO messages (id, conv_id, sender_id, seq, body, kind, client_id, reply_to, created_at, mentions, topic_id, burn_after, no_forward)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
const stMessageByClientId = db.prepare('SELECT * FROM messages WHERE conv_id = ? AND client_id = ?')
const stTouchConv = db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
const stMessageById = db.prepare('SELECT * FROM messages WHERE id = ?')

function shapeMessage(r, { withReply = true } = {}) {
  if (!r) return null
  const deleted = !!r.deleted
  const msg = {
    id: r.id,
    convId: r.conv_id,
    senderId: r.sender_id,
    seq: r.seq,
    // 撤回的消息不再下发内容，只留一个标记
    body: deleted ? '' : decryptBody(r.body),
    kind: r.kind,
    clientId: r.client_id,
    replyTo: r.reply_to || null,
    deleted,
    deletedAt: r.deleted_at || null,
    createdAt: r.created_at
  }
  // 引用一条消息时，带上被引用那条的摘要，前端直接渲染不用再查
  if (withReply && msg.replyTo) {
    const quoted = stMessageById.get(msg.replyTo)
    const replySender = quoted ? stUserById.get(quoted.sender_id) : null
    msg.reply = quoted
      ? {
          id: quoted.id,
          senderId: quoted.sender_id,
          senderName: replySender ? replySender.name : '',
          kind: quoted.kind,
          body: quoted.deleted ? '' : decryptBody(quoted.body).slice(0, 60),
          deleted: !!quoted.deleted
        }
      : null
  }
  msg.topicId = r.topic_id || null
  if (r.burn_after) msg.burnAfter = r.burn_after
  if (r.no_forward) msg.noForward = true

  // 表情回应：按 emoji 聚合，谁点的也带上
  try {
    const rs = db.prepare(
      'SELECT user_id, emoji FROM message_reactions WHERE message_id = ?'
    ).all(r.id)
    if (rs.length) {
      const byEmoji = {}
      for (const x of rs) {
        if (!byEmoji[x.emoji]) byEmoji[x.emoji] = []
        byEmoji[x.emoji].push(x.user_id)
      }
      msg.reactions = Object.keys(byEmoji).map((e) => ({ emoji: e, users: byEmoji[e], count: byEmoji[e].length }))
    }
  } catch { /* 表还没建好时忽略 */ }

  // 编辑过就带上时间，前端显示「已编辑」
  if (r.edited_at) msg.editedAt = r.edited_at

  // @提及
  if (r.mentions) {
    try { msg.mentions = JSON.parse(r.mentions) } catch { msg.mentions = [] }
  } else {
    msg.mentions = []
  }

  // 撤回者身份：自己撤的 / 管理员撤的 / 群主撤的
  if (deleted && r.deleted_by) {
    const who = stUserById.get(r.deleted_by)
    const conv = stConvById.get(r.conv_id)
    msg.deletedBy = r.deleted_by
    msg.deletedByName = who ? who.name : ''
    msg.deletedByIsSender = r.deleted_by === r.sender_id
    msg.deletedByIsAdmin = !!(who && who.role === 'admin')
    msg.deletedByIsOwner = !!(conv && conv.owner_id === r.deleted_by)
    const gm = db.prepare('SELECT role FROM conversation_members WHERE conv_id = ? AND user_id = ?')
      .get(r.conv_id, r.deleted_by)
    msg.deletedByIsGroupAdmin = !!(gm && gm.role === 'group_admin')
  }

  // 媒体消息：补上文件名、大小、时长，前端要用来渲染卡片
  if (!deleted && ['image', 'voice', 'file'].includes(msg.kind)) {
    const meta = imageMeta(msg.body)
    if (meta) {
      msg.fname = meta.name || ''
      msg.fsize = meta.size || 0
      msg.duration = meta.duration || 0
      msg.mime = meta.mime || ''
    }
  }
  return msg
}

/**
 * 发消息。
 * clientId 用于幂等：客户端重发不会产生两条（弱网下很常见）。
 * kind: text | image | voice | file
 * replyTo: 引用某条消息的 id（必须在同一个会话里）
 */
export function sendMessage({ convId, senderId, body, kind = 'text', clientId, replyTo = null, mentions = null, topicId = null, burnAfter = 0, noForward = false }) {
  if (!isMember(convId, senderId)) throw statusError(403, '不在这个会话里')

  // 频道：只有群主、管理员、开发者能发
  const convRowChk = stConvById.get(convId)
  if (convRowChk && convRowChk.type === 'channel') {
    const lvl = myLevel(convId, senderId)
    if (!['dev', 'owner', 'group_admin'].includes(lvl)) {
      throw statusError(403, '这是频道，只有管理员能发言')
    }
  }

  // 细粒度权限：被收回「发消息」就不能发
  if (convRowChk && convRowChk.type === 'group') {
    const ps = permsOf(convId, senderId)
    if (!ps.includes('send')) throw statusError(403, '你在本群被禁止发言')
    checkSlowMode(convId, senderId)
  }

  const text = String(body ?? '')

  // @提及：过滤成字符串数组，最多 50 个
  const mentionList = Array.isArray(mentions)
    ? mentions.filter((x) => typeof x === 'string' && x).slice(0, 50)
    : []
  const mentionsJson = mentionList.length ? JSON.stringify(mentionList) : null

  const MEDIA_KINDS = ['image', 'voice', 'file', 'video']
  if (MEDIA_KINDS.includes(kind)) {
    // 媒体消息的 body 是 media id，必须真实存在，否则前端拿到裂图/坏文件
    const meta = imageMeta(text)
    if (!meta) throw statusError(400, '附件不存在或已失效')
    if (kind === 'image' && meta.kind !== 'image') throw statusError(400, '这条附件不是图片')
  } else {
    if (!text.trim()) throw statusError(400, '消息不能为空')
    if (text.length > 4000) throw statusError(400, '消息太长')
  }

  // 引用校验：只能引用同一个会话里的消息
  let replyId = null
  if (replyTo) {
    const quoted = stMessageById.get(String(replyTo))
    if (quoted && quoted.conv_id === convId) replyId = quoted.id
  }

  // 一对一：被对方拉黑就拒收（对方看不到，但发送方会收到提示）
  const convRow = stConvById.get(convId)
  if (convRow && convRow.type === 'direct') {
    const peerRow = db
      .prepare('SELECT user_id FROM conversation_members WHERE conv_id = ? AND user_id <> ?')
      .get(convId, senderId)
    if (peerRow && isBlocked(peerRow.user_id, senderId)) {
      throw statusError(403, '消息已发出，但被对方拒收了')
    }
    // 陌生人消息限制：对方设了「只收好友」或「谁都不收」就拦下来
    if (peerRow) {
      const chk = canMessageMe(peerRow.user_id, senderId)
      if (!chk.ok) throw statusError(403, '消息已发出，但' + (chk.reason || '对方不接收'))
    }
  }

  if (clientId) {
    const dup = stMessageByClientId.get(convId, clientId)
    if (dup) return { message: shapeMessage(dup), duplicate: true }
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    const { last_seq: seq } = stBumpSeq.get(convId)
    const id = uid('m_')
    const t = now()
    // 字段顺序：id, conv_id, sender_id, seq, body, kind, client_id, reply_to, created_at, mentions
    stInsertMessage.run(
      id, convId, senderId, seq, encryptBody(text), kind,
      clientId || null, replyId, t, mentionsJson, topicId || null,
      Number(burnAfter) > 0 ? Number(burnAfter) : null,
      noForward ? 1 : 0
    )
    stTouchConv.run(t, convId)
    db.exec('COMMIT')
    return { message: shapeMessage(stMessageById.get(id)), duplicate: false }
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

const stHistory = db.prepare(`
  SELECT * FROM messages
  WHERE conv_id = ? AND seq < ?
  ORDER BY seq DESC LIMIT ?
`)
const stSince = db.prepare(`
  SELECT * FROM messages
  WHERE conv_id = ? AND seq > ?
  ORDER BY seq ASC LIMIT ?
`)

/** 向上翻历史：beforeSeq 传当前最早那条的 seq，首次传一个很大的数 */
export function history(convId, userId, { beforeSeq = Number.MAX_SAFE_INTEGER, fromSeq = null, limit = 50, topicId = null } = {}) {
  if (!isMember(convId, userId)) throw statusError(403, '不在这个会话里')
  const topicCond = topicId ? 'AND topic_id = ?' : 'AND topic_id IS NULL'
  const topicArgs = topicId ? [topicId] : []
  if (fromSeq != null) {
    const rows = db.prepare(
      `SELECT * FROM messages WHERE conv_id = ? AND seq >= ? ${topicCond} ORDER BY seq ASC LIMIT ?`
    ).all(convId, Number(fromSeq), ...topicArgs, Math.min(100, limit))
    return rows.map(shapeMessage)
  }
  if (!isMember(convId, userId)) throw statusError(403, '不在这个会话里')
  const rows = stHistory.all(convId, beforeSeq, Math.min(100, limit))
  return rows.map(shapeMessage).reverse()
}

/** 找到某个时间点之后的第一条消息所属的 seq（用于按日期跳转） */
export function seqAtTime(convId, userId, ts) {
  if (!isMember(convId, userId)) throw statusError(403, '不在这个会话里')
  const row = db.prepare(
    'SELECT seq FROM messages WHERE conv_id = ? AND created_at >= ? ORDER BY created_at ASC LIMIT 1'
  ).get(convId, Number(ts) || 0)
  if (row) return row.seq
  const max = db.prepare('SELECT MAX(seq) m FROM messages WHERE conv_id = ?').get(convId)
  return (max && max.m) || 0
}

/** 断线重连后拉增量：sinceSeq 之后所有消息 */
/** 会话最后一条消息（给公告之类的系统提示用） */
export function lastMessageOf(convId) {
  const r = stLastMessage.get(convId)
  return r ? shapeMessage(r) : null
}

export function messagesSince(convId, userId, sinceSeq) {
  if (!isMember(convId, userId)) throw statusError(403, '不在这个会话里')
  const rows = stSince.all(convId, sinceSeq, 500).map(shapeMessage)
  // 服务器上这个会话现在还剩多少条（客户端拿它判断本地缓存是否过期）
  const total = db.prepare('SELECT COUNT(*) n FROM messages WHERE conv_id = ? AND deleted = 0').get(convId).n
  return { messages: rows, serverCount: total }
}

const stSetRead = db.prepare(`
  UPDATE conversation_members SET last_read_seq = MAX(last_read_seq, ?)
  WHERE conv_id = ? AND user_id = ?
`)
const stReadSeq = db.prepare(
  'SELECT last_read_seq FROM conversation_members WHERE conv_id = ? AND user_id = ?'
)

export function markRead(convId, userId, seq) {
  if (!isMember(convId, userId)) throw statusError(403, '不在这个会话里')
  stSetRead.run(Number(seq) || 0, convId, userId)
  return stReadSeq.get(convId, userId).last_read_seq
}

const stSetDeleted = db.prepare(
  'UPDATE messages SET deleted = 1, deleted_at = ?, deleted_by = ? WHERE id = ?'
)

/**
 * 撤回消息。
 * 只有发送者本人能撤回；重写的是同一条记录（软删除），
 * 所以对方那边的历史也会变成「已撤回」，不会留底。
 */
/**
 * 如果一张图片/语音/文件已经没有任何地方引用，就把磁盘文件和记录一起删掉。
 * 引用来源：未撤回的消息、用户头像、群头像、朋友圈、系统设置。
 */
export function gcMedia(mediaId) {
  if (!mediaId) return false
  const id = String(mediaId)
  if (!/^[0-9a-f]{32}$/.test(id)) return false

  // messages.body 是加密存储的，必须解密后比较（之前直接比明文字符串，
  // 导致永远匹配不上、把所有在用的媒体都判成孤儿删掉了）
  let stillMsg = 0
  const rows = db.prepare(
    "SELECT body FROM messages WHERE deleted = 0 AND kind IN ('image','voice','file')"
  ).all()
  for (const r of rows) {
    let plain = ''
    try { plain = decryptBody(r.body) } catch { continue }
    if (plain === id) { stillMsg = 1; break }
  }
  const stillUser = db.prepare(
    "SELECT COUNT(*) n FROM users WHERE avatar LIKE '%' || ? || '%'"
  ).get(id).n
  const stillConv = db.prepare(
    "SELECT COUNT(*) n FROM conversations WHERE avatar LIKE '%' || ? || '%'"
  ).get(id).n
  let stillMoment = 0
  try {
    stillMoment = db.prepare(
      "SELECT COUNT(*) n FROM moment_images WHERE url LIKE '%' || ? || '%'"
    ).get(id).n
  } catch { /* 表可能还没建 */ }
  let stillSetting = 0
  try {
    stillSetting = db.prepare(
      "SELECT COUNT(*) n FROM app_settings WHERE value LIKE '%' || ? || '%'"
    ).get(id).n
  } catch { /* 忽略 */ }

  if (stillMsg + stillUser + stillConv + stillMoment + stillSetting > 0) return false
  return removeMediaRow(id)
}

/** 真正删除文件和记录 */
function removeMediaRow(id) {
  try {
    const row = db.prepare('SELECT path FROM images WHERE id = ?').get(id)
    if (!row) return false
    db.prepare('DELETE FROM images WHERE id = ?').run(id)
    // 删磁盘文件（加密后的 .enc）
    try {
      const f = row.path || path.join(IMAGE_DIR, id + '.enc')
      if (fs.existsSync(f)) fs.unlinkSync(f)
    } catch { /* 文件不在就算了 */ }
    return true
  } catch {
    return false
  }
}

export function deleteMessage(messageId, userId) {
  const row = stMessageById.get(messageId)
  if (!row) throw statusError(404, '消息不存在')
  const lvl = myLevel(row.conv_id, userId)
  const canManage = ['dev', 'owner', 'group_admin'].includes(lvl)
  if (row.sender_id !== userId && !canManage) throw statusError(403, '只能撤回自己的消息')
  // 媒体消息撤回后，如果没别处引用就顺手把文件删了（省磁盘）
  const mediaId = (row.kind && row.kind !== 'text' && row.kind !== 'sticker') ? row.body : null
  if (!row.deleted) stSetDeleted.run(now(), userId, messageId)
  if (mediaId) { try { gcMedia(mediaId) } catch { /* 清理失败不影响撤回 */ } }
  return {
    message: shapeMessage(stMessageById.get(messageId), { withReply: false }),
    members: membersOf(row.conv_id)
  }
}

/**
 * 搜索聊天记录。
 *
 * 注意：消息体是加密存的，所以**没法用 SQL LIKE**——必须全部解密后在内存里匹配。
 * 几个人自用的量级（几千条）这么干完全够快；真到几十万条就得另想办法
 * （比如单独维护一份密文哈希索引，或者改成客户端搜索）。
 */
export function searchMessages(userId, query, { convId = null, limit = 50 } = {}) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return []

  const myConvs = stConvsOfUser.all(userId).map((c) => c.id)
  const targets = convId ? (myConvs.includes(convId) ? [convId] : []) : myConvs
  if (!targets.length) return []

  const placeholders = targets.map(() => '?').join(',')
  // 密聊会话不参与搜索（内容本来也是密文，服务器解不出来）
  const rows = db
    .prepare(
      `SELECT m.* FROM messages m
       JOIN conversations c ON c.id = m.conv_id
       WHERE m.conv_id IN (${placeholders}) AND m.deleted = 0 AND m.kind = 'text'
         AND COALESCE(c.is_secret, 0) = 0
       ORDER BY m.created_at DESC LIMIT 3000`
    )
    .all(...targets)

  const out = []
  for (const r of rows) {
    const body = decryptBody(r.body)
    if (body.toLowerCase().includes(q)) {
      out.push(shapeMessage(r, { withReply: false }))
      if (out.length >= limit) break
    }
  }
  return out
}

/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  图片（和消息用同一个密钥加密，防的是同一件事：磁盘被拿走）         */
/* ------------------------------------------------------------------ */

const IMAGE_DIR = path.join(path.dirname(DB_FILE), 'images')
fs.mkdirSync(IMAGE_DIR, { recursive: true })

const ALLOWED_MIME = new Set([
  // 图片
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  // 语音
  'audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-m4a',
  // 文件
  'application/pdf', 'application/zip', 'application/json',
  'text/plain', 'text/csv', 'application/octet-stream'
])

export const MAX_MEDIA_BYTES = 20 * 1024 * 1024

const stInsertImage = db.prepare(
  `INSERT INTO images (id, owner_id, mime, size, kind, name, duration, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
)
const stImage = db.prepare('SELECT * FROM images WHERE id = ?')

/**
 * 保存媒体（图片 / 语音 / 文件），一律加密落盘。
 * kind: 'image' | 'voice' | 'file'
 */
export function saveMedia(ownerId, mime, buf, { kind = 'image', name = '', duration = 0 } = {}) {
  const type = String(mime || 'application/octet-stream').split(';')[0].trim().toLowerCase()
  if (!ALLOWED_MIME.has(type)) throw statusError(415, '不支持的文件类型: ' + type)
  if (!buf || !buf.length) throw statusError(400, '空文件')
  if (buf.length > MAX_MEDIA_BYTES) throw statusError(413, `文件不能超过 ${MAX_MEDIA_BYTES / 1024 / 1024}MB`)

  const id = randomBytes(16).toString('hex')
  const key = messageKey()
  let blob
  let ext
  if (key) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const ct = Buffer.concat([cipher.update(buf), cipher.final()])
    // 布局：[12字节 IV][16字节 tag][密文]
    blob = Buffer.concat([iv, cipher.getAuthTag(), ct])
    ext = '.enc'
  } else {
    blob = buf
    ext = '.raw'
  }
  fs.writeFileSync(path.join(IMAGE_DIR, id + ext), blob, { mode: 0o600 })
  stInsertImage.run(
    id, ownerId, type, buf.length,
    ['image', 'voice', 'file'].includes(kind) ? kind : 'image',
    String(name || '').slice(0, 200),
    Math.max(0, Math.round(Number(duration) || 0)),
    now()
  )
  return { id, size: buf.length, mime: type, kind, name: String(name || ''), duration: Math.round(Number(duration) || 0) }
}

export function readMedia(id) {
  if (!/^[0-9a-f]{32}$/.test(id)) return null // 挡住路径注入
  const meta = stImage.get(id)
  if (!meta) return null

  const encPath = path.join(IMAGE_DIR, id + '.enc')
  if (fs.existsSync(encPath)) {
    const blob = fs.readFileSync(encPath)
    const key = messageKey()
    if (!key) throw statusError(500, '密钥缺失，文件读不出来')
    const d = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12))
    d.setAuthTag(blob.subarray(12, 28))
    const data = Buffer.concat([d.update(blob.subarray(28)), d.final()])
    return { ...meta, data }
  }
  const rawPath = path.join(IMAGE_DIR, id + '.raw')
  if (fs.existsSync(rawPath)) return { ...meta, data: fs.readFileSync(rawPath) }
  return null
}

export function imageMeta(id) {
  if (!/^[0-9a-f]{32}$/.test(id)) return null
  return stImage.get(id) || null
}

// 兼容旧调用名
export const saveImage = (ownerId, mime, buf) => saveMedia(ownerId, mime, buf, { kind: 'image' })
export const readImage = readMedia
export const MAX_IMAGE_BYTES = MAX_MEDIA_BYTES

/* ------------------------------------------------------------------ */
/*  推送订阅                                                           */
/* ------------------------------------------------------------------ */

const stUpsertSub = db.prepare(`
  INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created_at, ua)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(endpoint) DO UPDATE SET
    user_id = excluded.user_id,
    p256dh  = excluded.p256dh,
    auth    = excluded.auth,
    ua      = excluded.ua
`)
const stSubsOfUser = db.prepare('SELECT * FROM push_subs WHERE user_id = ?')
const stDelSub = db.prepare('DELETE FROM push_subs WHERE endpoint = ?')
const stCountSubs = db.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?')

/**
 * 保存/更新订阅。
 * 同一个 endpoint 重复提交（浏览器可能多次 subscribe）要幂等，
 * 换了账号登录则要把 endpoint 挪到新用户名下。
 */
export function saveSubscription(userId, { endpoint, keys }, ua = '') {
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    throw statusError(400, '订阅数据不完整')
  }
  if (String(endpoint).length > 1024) throw statusError(400, 'endpoint 过长')
  stUpsertSub.run(String(endpoint), userId, String(keys.p256dh), String(keys.auth), now(), String(ua).slice(0, 200))
  return stCountSubs.get(userId).n
}

export function listSubscriptions(userId) {
  return stSubsOfUser.all(userId)
}

export function deleteSubscription(endpoint) {
  return stDelSub.run(String(endpoint)).changes
}

export function subscriptionCount(userId) {
  return stCountSubs.get(userId).n
}

/* ------------------------------------------------------------------ */
/*  会话个人设置：免打扰 / 置顶 / 从列表删除                            */
/* ------------------------------------------------------------------ */

const stSetMemberFlag = (col) =>
  db.prepare(`UPDATE conversation_members SET ${col} = ? WHERE conv_id = ? AND user_id = ?`)
const stSetMuted = stSetMemberFlag('muted')
const stSetPinned = stSetMemberFlag('pinned')
const stSetHidden = stSetMemberFlag('hidden')
const stSetStarred = db.prepare('UPDATE conversation_members SET starred = ? WHERE conv_id = ? AND user_id = ?')
const stMemberFlags = db.prepare(
  'SELECT muted, pinned, hidden, starred, folder FROM conversation_members WHERE conv_id = ? AND user_id = ?'
)

export function updateMemberSettings(convId, userId, { muted, pinned, hidden, starred, folder } = {}) {
  if (!isMember(convId, userId)) throw statusError(403, '不在这个会话里')
  if (muted !== undefined) stSetMuted.run(muted ? 1 : 0, convId, userId)
  if (pinned !== undefined) stSetPinned.run(pinned ? 1 : 0, convId, userId)
  if (hidden !== undefined) stSetHidden.run(hidden ? 1 : 0, convId, userId)
  if (starred !== undefined) stSetStarred.run(starred ? 1 : 0, convId, userId)
  if (folder !== undefined) {
    const f = String(folder || '').trim().slice(0, 12)
    db.prepare('UPDATE conversation_members SET folder = ? WHERE conv_id = ? AND user_id = ?')
      .run(f || null, convId, userId)
  }
  const r = stMemberFlags.get(convId, userId)
  return {
    muted: !!r.muted, pinned: !!r.pinned, hidden: !!r.hidden,
    starred: !!r.starred, folder: r.folder || ''
  }
}

/** 删除好友：私聊会话对「我」隐藏，对方那边不受影响 */
export function deleteFriend(convId, userId) {
  const conv = stConvById.get(convId)
  if (!conv) throw statusError(404, '会话不存在')
  if (conv.type !== 'direct') throw statusError(400, '群聊请用退群')
  if (!isMember(convId, userId)) throw statusError(403, '不在这个会话里')
  stSetHidden.run(1, convId, userId)
  return { ok: true }
}

/* ------------------------------------------------------------------ */
/*  黑名单                                                             */
/* ------------------------------------------------------------------ */

const stBlock = db.prepare(
  'INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)'
)
const stUnblock = db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?')
const stBlocksOf = db.prepare(`
  SELECT b.blocked_id AS id, u.name FROM blocks b
  JOIN users u ON u.id = b.blocked_id
  WHERE b.blocker_id = ? ORDER BY b.created_at DESC
`)
const stIsBlocked = db.prepare('SELECT 1 AS x FROM blocks WHERE blocker_id = ? AND blocked_id = ?')

export function blockUser(blockerId, blockedId) {
  if (blockerId === blockedId) throw statusError(400, '不能拉黑自己')
  if (!stUserById.get(blockedId)) throw statusError(404, '用户不存在')
  stBlock.run(blockerId, blockedId, now())
  return listBlocks(blockerId)
}

export function unblockUser(blockerId, blockedId) {
  stUnblock.run(blockerId, blockedId)
  return listBlocks(blockerId)
}

export function listBlocks(userId) {
  return stBlocksOf.all(userId).map((r) => ({ id: r.id, name: r.name }))
}

/** a 是否拉黑了 b */
export function isBlocked(blockerId, blockedId) {
  return !!stIsBlocked.get(blockerId, blockedId)
}

/* ------------------------------------------------------------------ */
/*  朋友圈                                                             */
/* ------------------------------------------------------------------ */

const stInsertMoment = db.prepare(
  'INSERT INTO moments (id, user_id, content, created_at, location) VALUES (?, ?, ?, ?, ?)'
)
const stMomentImages = db.prepare('INSERT OR IGNORE INTO moment_images (moment_id, url, sort) VALUES (?, ?, ?)')
const stImagesOfMoment = db.prepare('SELECT url FROM moment_images WHERE moment_id = ? ORDER BY sort')
const stMomentList = db.prepare(`
  SELECT m.*, u.name AS author_name, u.avatar AS author_avatar
  FROM moments m JOIN users u ON u.id = m.user_id
  WHERE m.created_at < ?
  ORDER BY m.created_at DESC LIMIT ?
`)
const stLikesOf = db.prepare(`
  SELECT l.user_id, u.name FROM moment_likes l JOIN users u ON u.id = l.user_id
  WHERE l.moment_id = ? ORDER BY l.created_at
`)
const stCommentsOf = db.prepare(`
  SELECT c.*, u.name AS author_name, u.avatar AS author_avatar,
         r.name AS reply_name
  FROM moment_comments c
  JOIN users u ON u.id = c.user_id
  LEFT JOIN moment_comments rc ON rc.id = c.reply_to
  LEFT JOIN users r ON r.id = rc.user_id
  WHERE c.moment_id = ? ORDER BY c.created_at
`)
const stMomentById = db.prepare('SELECT * FROM moments WHERE id = ?')
const stToggleLike = db.prepare('DELETE FROM moment_likes WHERE moment_id = ? AND user_id = ?')
const stAddLike = db.prepare('INSERT OR IGNORE INTO moment_likes (moment_id, user_id, created_at) VALUES (?, ?, ?)')
const stInsertMomentComment = db.prepare(
  'INSERT INTO moment_comments (id, moment_id, user_id, content, created_at, reply_to) VALUES (?, ?, ?, ?, ?, ?)'
)

function shapeMoment(row, viewerId, { withDetail = true } = {}) {
  if (!row) return null
  const likes = stLikesOf.all(row.id)
  const comments = stCommentsOf.all(row.id)
  return {
    id: row.id,
    userId: row.user_id,
    author: {
      id: row.user_id,
      name: row.author_name || '某人',
      avatar: row.author_avatar || ''
    },
    content: decryptBody(row.content),
    images: stImagesOfMoment.all(row.id).map((r) => r.url),
    createdAt: row.created_at,
    location: row.location || '',
    likes: likes.map((l) => ({ id: l.user_id, name: l.name })),
    likedByMe: likes.some((l) => l.user_id === viewerId),
    comments: withDetail
      ? comments.map((c) => ({
          id: c.id,
          userId: c.user_id,
          name: c.author_name || '某人',
          content: decryptBody(c.content),
          replyTo: c.reply_to || null,
          replyToName: c.reply_name || '',
          createdAt: c.created_at
        }))
      : comments.length
  }
}

export function listMoments(viewerId, { before = Date.now() + 1000, limit = 20 } = {}) {
  const rows = stMomentList.all(Number(before) || Date.now() + 1000, Math.min(50, Number(limit) || 20))
  return rows.map((r) => shapeMoment(r, viewerId))
}

export function createMoment(userId, { content, images = [], location }) {
  const text = String(content || '').trim()
  const imgs = (images || []).filter((u) => typeof u === 'string' && u).slice(0, 9)
  if (!text && !imgs.length) throw statusError(400, '写点什么或者配张图')
  if (text.length > 2000) throw statusError(400, '文字太长了')
  const id = uid('mo_')
  const t = now()
  db.exec('BEGIN')
  try {
    stInsertMoment.run(id, userId, encryptBody(text), t, String(location || '').slice(0, 40) || null)
    imgs.forEach((u, i) => stMomentImages.run(id, u, i))
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return getMoment(id, userId)
}

export function getMoment(id, viewerId) {
  const row = stMomentById.get(id)
  if (!row) return null
  const withAuthor = db.prepare(`
    SELECT m.*, u.name AS author_name, u.avatar AS author_avatar
    FROM moments m JOIN users u ON u.id = m.user_id WHERE m.id = ?
  `).get(id)
  return shapeMoment(withAuthor, viewerId)
}

export function toggleMomentLike(momentId, userId) {
  if (!stMomentById.get(momentId)) throw statusError(404, '动态不存在')
  const existing = db.prepare('SELECT 1 x FROM moment_likes WHERE moment_id = ? AND user_id = ?').get(momentId, userId)
  if (existing) stToggleLike.run(momentId, userId)
  else stAddLike.run(momentId, userId, now())
  return getMoment(momentId, userId)
}

export function addMomentComment(momentId, userId, content, replyTo) {
  if (!stMomentById.get(momentId)) throw statusError(404, '动态不存在')
  const text = String(content || '').trim()
  if (!text) throw statusError(400, '评论不能为空')
  let replyId = null
  if (replyTo) {
    const c = db.prepare('SELECT id FROM moment_comments WHERE id = ? AND moment_id = ?').get(String(replyTo), momentId)
    if (c) replyId = c.id
  }
  stInsertMomentComment.run(uid('mc_'), momentId, userId, encryptBody(text.slice(0, 500)), now(), replyId)
  return getMoment(momentId, userId)
}

export function deleteMoment(momentId, userId) {
  const row = stMomentById.get(momentId)
  if (!row) throw statusError(404, '动态不存在')
  if (row.user_id !== userId) throw statusError(403, '只能删除自己的动态')
  db.prepare('DELETE FROM moments WHERE id = ?').run(momentId)
  return { ok: true }
}

/* ------------------------------------------------------------------ */
/*  管理员                                                             */
/* ------------------------------------------------------------------ */

export function isAdmin(userId) {
  const u = stUserById.get(userId)
  return !!u && u.role === 'admin'
}

export function setRole(userId, role, byUserId) {
  if (!['admin', 'user'].includes(role)) throw statusError(400, '角色不合法')
  const target = stUserById.get(userId)
  if (!target) throw statusError(404, '用户不存在')

  // 开发者（is_super）的权限和头衔，谁都不能动
  if (target.is_super) {
    throw statusError(403, '不能修改开发者的权限或头衔')
  }

  // 操作者必须本身就是管理员
  if (byUserId) {
    const by = stUserById.get(byUserId)
    if (!by || by.role !== 'admin') {
      throw statusError(403, '权限不够')
    }
    // 不能改自己（防止自己把自己降级后失联）
    if (byUserId === userId) {
      throw statusError(403, '不能修改自己的权限')
    }
  }

  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId)
  return publicUser(stUserById.get(userId))
}

/** 设置某人的自定义头衔（空字符串表示恢复默认） */
export function setUserTitle(userId, title, color, byUserId) {
  const target = stUserById.get(userId)
  if (!target) throw statusError(404, '用户不存在')

  // 开发者（is_super）的头衔只有自己能改
  if (target.is_super && byUserId && byUserId !== userId) {
    throw statusError(403, '不能修改开发者的头衔')
  }
  // 非管理员不能改别人
  if (byUserId && byUserId !== userId) {
    const by = stUserById.get(byUserId)
    if (!by || by.role !== 'admin') throw statusError(403, '权限不够')
  }

  const t = String(title || '').trim().slice(0, 12)
  // 颜色可能是 linear-gradient(...)，32 个字符不够，放到 120
  const c = color ? String(color).slice(0, 120) : null
  db.prepare('UPDATE users SET title = ?, title_color = ? WHERE id = ?').run(t || null, c, userId)
  return publicUser(stUserById.get(userId))
}

/** 把第一个注册的用户设为超级管理员（一次性迁移） */
function backfillSuper() {
  const has = db.prepare('SELECT COUNT(*) n FROM users WHERE is_super = 1').get().n
  if (has > 0) return
  const first = db.prepare('SELECT id FROM users ORDER BY created_at ASC LIMIT 1').get()
  if (first) {
    db.prepare('UPDATE users SET is_super = 1, role = ? WHERE id = ?').run('admin', first.id)
    console.log('[db] 已将首个用户设为超级管理员')
  }
}
backfillSuper()

/** 管理员：所有用户 */
export function adminListUsers() {
  return db.prepare('SELECT id, phone, name, avatar, role, created_at, im_id, is_super, title, title_color FROM users ORDER BY created_at').all()
    .map((u) => ({ id: u.id, phone: u.phone, name: u.name, avatar: u.avatar, role: u.role, createdAt: u.created_at, imId: u.im_id || '', isSuper: !!u.is_super, title: u.title || '', titleColor: u.title_color || '' }))
}

/** 管理员：所有会话（不限于自己参与的） */
export function adminListConversations() {
  const rows = db.prepare(`
    SELECT c.id, c.type, c.title, c.created_at, c.updated_at
    FROM conversations c ORDER BY c.updated_at DESC
  `).all()
  return rows.map((c) => {
    const members = membersOf(c.id)
    const last = stLastMessage.get(c.id)
    return {
      id: c.id,
      type: c.type,
      title: c.title || (c.type === 'group' ? members.map((m) => m.name).join('、') : ''),
      members,
      messageCount: db.prepare('SELECT COUNT(*) n FROM messages WHERE conv_id = ?').get(c.id).n,
      lastAt: last ? last.created_at : c.updated_at
    }
  })
}

/** 管理员：读任意会话的消息（绕过成员校验） */
export function adminHistory(convId, { beforeSeq = Number.MAX_SAFE_INTEGER, limit = 100 } = {}) {
  const rows = db.prepare(`
    SELECT * FROM messages WHERE conv_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?
  `).all(convId, beforeSeq, Math.min(200, limit))
  const senderName = new Map(
    db.prepare('SELECT id, name FROM users').all().map((u) => [u.id, u.name])
  )
  return rows.map((r) => {
    const m = shapeMessage(r, { withReply: false })
    m.senderName = senderName.get(r.sender_id) || '未知'
    return m
  }).reverse()
}

/** 管理员：删任意消息 */
export function adminDeleteMessage(messageId, adminId) {
  const row = stMessageById.get(messageId)
  if (!row) throw statusError(404, '消息不存在')
  const mediaId = (row.kind && row.kind !== 'text' && row.kind !== 'sticker') ? row.body : null
  stSetDeleted.run(now(), adminId || row.sender_id, messageId)
  if (mediaId) { try { gcMedia(mediaId) } catch { /* 忽略 */ } }
  return { id: messageId, convId: row.conv_id }
}

/** 管理员：删任意朋友圈评论 */
export function adminDeleteComment(commentId) {
  const row = db.prepare('SELECT * FROM moment_comments WHERE id = ?').get(commentId)
  if (!row) throw statusError(404, '评论不存在')
  db.prepare('DELETE FROM moment_comments WHERE id = ?').run(commentId)
  return { id: commentId, momentId: row.moment_id }
}

/** 管理员：删任意朋友圈 */
export function adminDeleteMoment(momentId) {
  if (!stMomentById.get(momentId)) throw statusError(404, '动态不存在')
  db.prepare('DELETE FROM moments WHERE id = ?').run(momentId)
  return { id: momentId }
}

/** 管理员：全局统计 */
export function adminStats() {
  const one = (sql) => db.prepare(sql).get().n
  return {
    users: one('SELECT COUNT(*) n FROM users'),
    conversations: one('SELECT COUNT(*) n FROM conversations'),
    messages: one('SELECT COUNT(*) n FROM messages'),
    deletedMessages: one('SELECT COUNT(*) n FROM messages WHERE deleted = 1'),
    moments: one('SELECT COUNT(*) n FROM moments'),
    media: one('SELECT COUNT(*) n FROM images')
  }
}

/** 管理后台：所有媒体文件（图片/语音/文件） */
export function adminMedia() {
  const rows = db.prepare(`
    SELECT i.id, i.kind, i.mime, i.size, i.name, i.owner_id, u.name AS owner_name, i.created_at
    FROM images i LEFT JOIN users u ON u.id = i.owner_id
    ORDER BY i.created_at DESC LIMIT 200
  `).all()
  return rows.map((r) => ({
    id: r.id, kind: r.kind, mime: r.mime, size: r.size, name: r.name || '',
    ownerName: r.owner_name || '', createdAt: r.created_at
  }))
}

/** 管理后台：所有会话里最近的若干条消息（全局视图） */
export function adminRecentMessages(limit = 100) {
  const rows = db.prepare(`
    SELECT m.id, m.conv_id, m.kind, m.body, m.created_at, m.deleted,
           m.sender_id, u.name AS sender_name,
           c.type AS conv_type, c.title AS conv_title,
           COALESCE(c.is_secret, 0) AS conv_secret
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    LEFT JOIN conversations c ON c.id = m.conv_id
    ORDER BY m.created_at DESC LIMIT ?
  `).all(Math.min(300, limit))
  return rows.map((r) => ({
    id: r.id,
    convId: r.conv_id,
    convName: r.conv_title || (r.conv_type === 'group' ? '群聊' : r.conv_type === 'channel' ? '频道' : '私聊'),
    senderName: r.sender_name || '',
    kind: r.kind,
    // 密聊：开发者/管理后台也看不到内容
    body: r.deleted ? '' : (r.conv_secret ? '[密聊内容，无法查看]'
      : (() => { try { return decryptBody(r.body) } catch { return '' } })()),
    isSecret: !!r.conv_secret,
    deleted: !!r.deleted,
    createdAt: r.created_at
  }))
}

/** 转让群主。开发者可以转任何群，群主可以转自己的群 */
export function transferOwner(convId, newOwnerId, byUserId) {
  const conv = stConvById.get(convId)
  if (!conv) throw statusError(404, '会话不存在')
  if (conv.type !== 'group') throw statusError(400, '只有群聊有群主')
  const lvl = myLevel(convId, byUserId)
  if (!['dev', 'owner'].includes(lvl)) throw statusError(403, '只有群主或开发者能转让')
  if (!isMember(convId, newOwnerId)) throw statusError(400, '这个人不在群里')
  if (newOwnerId === conv.owner_id) return membersOf(convId)
  const oldOwner = conv.owner_id
  db.exec('BEGIN')
  try {
    db.prepare('UPDATE conversations SET owner_id = ?, updated_at = ? WHERE id = ?').run(newOwnerId, now(), convId)
    // 新群主不该同时挂 group_admin，原群主降为普通成员
    stSetMemberRole.run('member', convId, newOwnerId)
    if (oldOwner) stSetMemberRole.run('member', convId, oldOwner)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return membersOf(convId)
}

export function disbandGroup(convId, userId) {
  const conv = stConvById.get(convId)
  if (!conv) throw statusError(404, '会话不存在')
  if (conv.type !== 'group') throw statusError(400, '不是群聊')
  if (conv.owner_id !== userId && !isAdmin(userId)) {
    throw statusError(403, '只有群主或开发者能解散群')
  }
  db.prepare('DELETE FROM conversations WHERE id = ?').run(convId)
  return { ok: true, convId }
}

/** 当前用户对某个会话的权限等级：dev > owner > group_admin > member */
export function myLevel(convId, userId) {
  const conv = stConvById.get(convId)
  if (!conv) return 'none'
  if (isAdmin(userId)) return 'dev'
  if (conv.owner_id === userId) return 'owner'
  const row = db.prepare('SELECT role FROM conversation_members WHERE conv_id = ? AND user_id = ?').get(convId, userId)
  if (row && row.role === 'group_admin') return 'group_admin'
  if (row) return 'member'
  return 'none'
}

const stSetMemberRole = db.prepare('UPDATE conversation_members SET role = ? WHERE conv_id = ? AND user_id = ?')

/** 任命 / 撤销群管理员。只有群主和开发者能操作 */
export function setGroupAdmin(convId, targetId, on, byUserId) {
  const conv = stConvById.get(convId)
  if (!conv) throw statusError(404, '会话不存在')
  if (conv.type !== 'group') throw statusError(400, '只有群聊能设管理员')
  const lvl = myLevel(convId, byUserId)
  if (!['dev', 'owner'].includes(lvl)) throw statusError(403, '只有群主或开发者能设置管理员')
  if (!isMember(convId, targetId)) throw statusError(400, '这个人不在群里')
  if (targetId === conv.owner_id) throw statusError(400, '群主不需要设管理员')
  stSetMemberRole.run(on ? 'group_admin' : 'member', convId, targetId)
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now(), convId)
  return membersOf(convId)
}

/** 设置成员头衔。群主和开发者可以设，也可以给自己设 */
export function setMemberTitle(convId, targetId, title, byUserId, titleColor) {
  const conv = stConvById.get(convId)
  if (!conv) throw statusError(404, '会话不存在')
  if (conv.type !== 'group') throw statusError(400, '只有群聊有头衔')
  const lvl = myLevel(convId, byUserId)
  if (!['dev', 'owner'].includes(lvl)) throw statusError(403, '只有群主或开发者能设置头衔')
  if (!isMember(convId, targetId)) throw statusError(400, '这个人不在群里')
  const t = String(title || '').trim().slice(0, 12)
  // 颜色只接受 #rrggbb 形式，其他一律当作没设置
  const raw = String(titleColor || '').trim()
  const color = /^#[0-9a-fA-F]{6}$/.test(raw) ? raw.toLowerCase() : null
  db.prepare('UPDATE conversation_members SET title = ?, title_color = ? WHERE conv_id = ? AND user_id = ?')
    .run(t || null, t ? color : null, convId, targetId)
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now(), convId)
  return membersOf(convId)
}

/** 清空某个会话对某个人的记录（只隐藏自己这边的，不改对方数据） */
export function clearMessages(convId, userId) {
  if (!isMember(convId, userId)) throw statusError(403, '不在这个会话里')
  const maxSeq = db.prepare('SELECT MAX(seq) m FROM messages WHERE conv_id = ?').get(convId).m || 0
  // 把已读位置推到最新，这样历史消息不再算未读；配合前端清本地缓存，界面就空了
  db.prepare('UPDATE conversation_members SET last_read_seq = ? WHERE conv_id = ? AND user_id = ?')
    .run(maxSeq, convId, userId)
  return { ok: true, lastSeq: maxSeq }
}

/** 读一个系统设置 */
export function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(String(key))
  return row ? (row.value || '') : fallback
}

/** 写一个系统设置（只有开发者能调，权限在 server 层校验） */
export function setSetting(key, value) {
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(String(key), value == null ? '' : String(value))
  return getSetting(key)
}

/** 赞助页需要的数据 */
export function sponsorInfo() {
  return {
    enabled: getSetting('sponsor_enabled', '1') === '1',
    qr: getSetting('sponsor_qr', ''),
    note: getSetting('sponsor_note', '')
  }
}

/** 置顶/取消置顶某条消息（群主或管理员） */
export function pinMessage(convId, messageId, byUserId) {
  const conv = stConvById.get(convId)
  if (!conv) throw statusError(404, '会话不存在')
  const lvl = myLevel(convId, byUserId)
  if (!['dev', 'owner', 'group_admin'].includes(lvl)) throw statusError(403, '只有群主或管理员能置顶')
  if (messageId) {
    const m = stMessageById.get(String(messageId))
    if (!m || m.conv_id !== convId) throw statusError(404, '消息不存在')
    db.prepare('UPDATE conversations SET pinned_msg_id = ? WHERE id = ?').run(m.id, convId)
  } else {
    db.prepare('UPDATE conversations SET pinned_msg_id = NULL WHERE id = ?').run(convId)
  }
  return { pinnedMsgId: messageId || null }
}

/** 编辑自己的文字消息 */
export function editMessage(messageId, userId, newBody) {
  const row = stMessageById.get(String(messageId))
  if (!row) throw statusError(404, '消息不存在')
  if (row.sender_id !== userId) throw statusError(403, '只能编辑自己的消息')
  if (row.deleted) throw statusError(400, '已撤回的消息不能编辑')
  if (row.kind !== 'text') throw statusError(400, '只有文字消息能编辑')
  const text = String(newBody || '').trim()
  if (!text) throw statusError(400, '内容不能为空')
  if (text.length > 4000) throw statusError(400, '消息太长')
  // 先把旧内容存进历史
  try {
    db.prepare('INSERT INTO message_edits (message_id, old_body, edited_at) VALUES (?, ?, ?)')
      .run(row.id, row.body, now())
  } catch {}
  db.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?')
    .run(encryptBody(text), now(), row.id)
  return shapeMessage(stMessageById.get(row.id))
}

/* ------------------------------------------------------------------ */
/*  群话题                                                             */
/* ------------------------------------------------------------------ */

export function listTopics(convId, userId) {
  if (!isMember(convId, userId)) throw statusError(403, '不在这个会话里')
  return db.prepare('SELECT * FROM topics WHERE conv_id = ? ORDER BY created_at ASC').all(convId)
    .map((t) => ({ id: t.id, name: t.name, createdAt: t.created_at }))
}

export function createTopic(convId, userId, name) {
  const conv = stConvById.get(convId)
  if (!conv) throw statusError(404, '会话不存在')
  if (conv.type !== 'group') throw statusError(400, '只有群聊有话题')
  const lvl = myLevel(convId, userId)
  if (!['dev', 'owner', 'group_admin'].includes(lvl)) throw statusError(403, '只有群主或管理员能建话题')
  const n = String(name || '').trim().slice(0, 20)
  if (!n) throw statusError(400, '话题名不能为空')
  const id = uid('tp_')
  db.prepare('INSERT INTO topics (id, conv_id, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, convId, n, userId, now())
  return { id, name: n, createdAt: now() }
}

export function deleteTopic(topicId, userId) {
  const t = db.prepare('SELECT * FROM topics WHERE id = ?').get(String(topicId))
  if (!t) throw statusError(404, '话题不存在')
  const lvl = myLevel(t.conv_id, userId)
  if (!['dev', 'owner', 'group_admin'].includes(lvl)) throw statusError(403, '权限不够')
  db.prepare('DELETE FROM topics WHERE id = ?').run(t.id)
  // 该话题下的消息回到主聊天
  db.prepare('UPDATE messages SET topic_id = NULL WHERE topic_id = ?').run(t.id)
  return { ok: true, convId: t.conv_id }
}

/** 设置会话的消息保留时长（秒）。群主/开发者可设 */
export function setConversationTtl(convId, userId, seconds) {
  const conv = stConvById.get(convId)
  if (!conv) throw statusError(404, '会话不存在')
  const lvl = myLevel(convId, userId)
  if (!['dev', 'owner', 'group_admin'].includes(lvl)) throw statusError(403, '权限不够')
  const ttl = Math.max(0, Math.min(30 * 24 * 3600, Number(seconds) || 0))
  db.prepare('UPDATE conversations SET ttl = ? WHERE id = ?').run(ttl, convId)
  return { ttl }
}

/**
 * 清理过期消息：把超过会话 TTL 的消息标记为已删除。
 * 由 server 里的定时任务周期性调用。
 */
/** 扫一遍所有媒体，把没人引用的删掉（定时任务用） */
/** 收集所有正在被引用的媒体 id */
export function usedMediaIds() {
  const used = new Set()
  try {
    for (const r of db.prepare("SELECT body FROM messages WHERE deleted = 0 AND kind IN ('image','voice','file')").all()) {
      let plain = ''
      try { plain = decryptBody(r.body) } catch { continue }
      const real = plain.indexOf('E2EEFILE.') === 0 ? plain.slice(9) : plain
      if (/^[0-9a-f]{32}$/.test(real)) used.add(real)
    }
  } catch {}
  for (const r of db.prepare("SELECT avatar FROM users WHERE avatar IS NOT NULL AND avatar <> ''").all()) {
    const m = String(r.avatar).match(/[0-9a-f]{32}/); if (m) used.add(m[0])
  }
  for (const r of db.prepare("SELECT avatar FROM conversations WHERE avatar IS NOT NULL AND avatar <> ''").all()) {
    const m = String(r.avatar).match(/[0-9a-f]{32}/); if (m) used.add(m[0])
  }
  try {
    for (const r of db.prepare('SELECT url FROM moment_images').all()) {
      const m = String(r.url).match(/[0-9a-f]{32}/); if (m) used.add(m[0])
    }
  } catch {}
  return used
}

/** 预览：不清，只算能清多少 */
export function gcPreview() {
  const used = new Set()
  try {
    for (const r of db.prepare("SELECT body FROM messages WHERE deleted = 0 AND kind IN ('image','voice','file')").all()) {
      let plain = ''
      try { plain = decryptBody(r.body) } catch { continue }
      // 密聊文件 body 带 E2EEFILE. 前缀，也要把真实 id 算进去
      const real = plain.indexOf('E2EEFILE.') === 0 ? plain.slice(9) : plain
      if (/^[0-9a-f]{32}$/.test(real)) used.add(real)
    }
  } catch {}
  for (const r of db.prepare("SELECT avatar FROM users WHERE avatar IS NOT NULL AND avatar <> ''").all()) {
    const m = String(r.avatar).match(/[0-9a-f]{32}/); if (m) used.add(m[0])
  }
  for (const r of db.prepare("SELECT avatar FROM conversations WHERE avatar IS NOT NULL AND avatar <> ''").all()) {
    const m = String(r.avatar).match(/[0-9a-f]{32}/); if (m) used.add(m[0])
  }
  try {
    for (const r of db.prepare('SELECT url FROM moment_images').all()) {
      const m = String(r.url).match(/[0-9a-f]{32}/); if (m) used.add(m[0])
    }
  } catch {}

  const cutoff = now() - 7 * 86400000
  let canRemove = 0, tooNew = 0, freed = 0, total = 0, usedCount = 0
  for (const r of db.prepare('SELECT id, created_at, size FROM images').all()) {
    total++
    if (used.has(r.id)) { usedCount++; continue }
    if (r.created_at && r.created_at > cutoff) { tooNew++; continue }
    canRemove++
    freed += (r.size || 0)
  }
  return { canRemove, tooNew, usedCount, freedBytes: freed, totalFiles: total }
}

export function purgeOrphanMedia() {
  // 先一次性收集所有被引用的媒体 id（消息要解密，头像直接取）
  const used = new Set()
  try {
    for (const r of db.prepare(
      "SELECT body FROM messages WHERE deleted = 0 AND kind IN ('image','voice','file')"
    ).all()) {
      let plain = ''
      try { plain = decryptBody(r.body) } catch { continue }
      // 密聊文件 body 带 E2EEFILE. 前缀，剥掉再算
      const real = plain.indexOf('E2EEFILE.') === 0 ? plain.slice(9) : plain
      if (/^[0-9a-f]{32}$/.test(real)) used.add(real)
    }
  } catch { /* 忽略 */ }
  for (const r of db.prepare("SELECT avatar FROM users WHERE avatar IS NOT NULL AND avatar <> ''").all()) {
    const m = String(r.avatar).match(/[0-9a-f]{32}/); if (m) used.add(m[0])
  }
  for (const r of db.prepare("SELECT avatar FROM conversations WHERE avatar IS NOT NULL AND avatar <> ''").all()) {
    const m = String(r.avatar).match(/[0-9a-f]{32}/); if (m) used.add(m[0])
  }
  try {
    for (const r of db.prepare('SELECT url FROM moment_images').all()) {
      const m = String(r.url).match(/[0-9a-f]{32}/); if (m) used.add(m[0])
    }
  } catch { /* 忽略 */ }
  try {
    for (const r of db.prepare("SELECT value FROM app_settings WHERE value LIKE '%/api/images/%'").all()) {
      const m = String(r.value).match(/[0-9a-f]{32}/); if (m) used.add(m[0])
    }
  } catch { /* 忽略 */ }

  // 安全网：只删「超过 7 天」的孤儿文件。
  // 防止刚上传、消息还没落库的文件被误删（上次就是这么弄丢的）
  const cutoff = now() - 7 * 86400000
  let removed = 0
  let skippedNew = 0
  let freedBytes = 0
  let totalFiles = 0
  for (const r of db.prepare('SELECT id, created_at, size FROM images').all()) {
    totalFiles++
    if (used.has(r.id)) continue                    // 有引用，跳过
    if (r.created_at && r.created_at > cutoff) {    // 太新，先留着
      skippedNew++
      continue
    }
    if (removeMediaRow(r.id)) { removed++; freedBytes += (r.size || 0) }
  }
  return { removed, skippedNew, freedBytes, totalFiles }
}

/** 清理阅后即焚：被读过且超过 burn_after 秒的消息删掉 */
export function purgeBurned() {
  const rows = db.prepare(
    "SELECT id, conv_id, burn_after, created_at FROM messages WHERE burn_after > 0 AND deleted = 0"
  ).all()
  let n = 0
  const t = now()
  for (const r of rows) {
    if (t - r.created_at > r.burn_after * 1000) {
      try {
        db.prepare('DELETE FROM messages WHERE id = ?').run(r.id)
        n++
      } catch {}
    }
  }
  return n
}

export function purgeExpired() {
  const rows = db.prepare('SELECT id, ttl FROM conversations WHERE ttl > 0').all()
  let removed = 0
  const t = now()
  for (const c of rows) {
    const cutoff = t - c.ttl * 1000
    const del = db.prepare('DELETE FROM messages WHERE conv_id = ? AND created_at < ?')
      .run(c.id, cutoff)
    removed += del.changes || 0
  }
  return removed
}

/** 给消息加/取消一个表情回应 */
export function toggleReaction(messageId, userId, emoji) {
  const row = stMessageById.get(String(messageId))
  if (!row) throw statusError(404, '消息不存在')
  if (!isMember(row.conv_id, userId)) throw statusError(403, '不在这个会话里')
  const e = String(emoji || '').slice(0, 8)
  if (!e) throw statusError(400, '表情不能为空')

  const has = db.prepare(
    'SELECT 1 FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'
  ).get(row.id, userId, e)
  if (has) {
    db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
      .run(row.id, userId, e)
  } else {
    db.prepare('INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)')
      .run(row.id, userId, e, now())
  }
  return { message: shapeMessage(stMessageById.get(row.id), { withReply: false }) }
}

/* ------------------------------------------------------------------ */
/*  一起听                                                              */
/* ------------------------------------------------------------------ */

/** 读一个会话当前的播放状态（把「已经播了多久」算出来） */
export function getListenState(convId, userId) {
  if (!isMember(convId, userId)) throw statusError(403, '不在这个会话里')
  const r = db.prepare('SELECT * FROM listen_state WHERE conv_id = ?').get(convId)
  if (!r) return null
  const host = stUserById.get(r.host_id)
  let pos = r.position
  if (r.playing) {
    // 正在播：当前位置 = 记录位置 + 已经过去的时间
    pos = r.position + (now() - r.started_at) / 1000
  }
  return {
    convId: r.conv_id,
    audioId: r.audio_id,
    title: r.title,
    hostName: host ? host.name : '',
    hostId: r.host_id,
    playing: !!r.playing,
    position: Math.max(0, pos),
    updatedAt: r.updated_at
  }
}

/** 换歌 / 重新开始 */
export function setListenTrack(convId, userId, audioId, title) {
  if (!isMember(convId, userId)) throw statusError(403, '不在这个会话里')
  const id = String(audioId || '')
  if (!/^[0-9a-f]{32}$/.test(id)) throw statusError(400, '音频不对')
  db.prepare(`INSERT INTO listen_state (conv_id, audio_id, title, host_id, position, playing, started_at, updated_at)
              VALUES (?, ?, ?, ?, 0, 1, ?, ?)
              ON CONFLICT(conv_id) DO UPDATE SET
                audio_id = excluded.audio_id, title = excluded.title, host_id = excluded.host_id,
                position = 0, playing = 1, started_at = excluded.started_at, updated_at = excluded.updated_at`)
    .run(convId, id, String(title || '').slice(0, 40), userId, now(), now())
  return getListenState(convId, userId)
}

/** 播放/暂停/跳转 */
export function controlListen(convId, userId, action, position) {
  if (!isMember(convId, userId)) throw statusError(403, '不在这个会话里')
  const r = db.prepare('SELECT * FROM listen_state WHERE conv_id = ?').get(convId)
  if (!r) throw statusError(404, '还没有在听的歌')
  const t = now()

  if (action === 'pause') {
    const pos = r.playing ? r.position + (t - r.started_at) / 1000 : r.position
    db.prepare('UPDATE listen_state SET position = ?, playing = 0, updated_at = ? WHERE conv_id = ?')
      .run(pos, t, convId)
  } else if (action === 'play') {
    db.prepare('UPDATE listen_state SET playing = 1, started_at = ?, updated_at = ? WHERE conv_id = ?')
      .run(t, t, convId)
  } else if (action === 'seek') {
    const pos = Math.max(0, Number(position) || 0)
    db.prepare('UPDATE listen_state SET position = ?, started_at = ?, updated_at = ? WHERE conv_id = ?')
      .run(pos, t, t, convId)
  } else if (action === 'stop') {
    db.prepare('DELETE FROM listen_state WHERE conv_id = ?').run(convId)
    return null
  }
  return getListenState(convId, userId)
}

/** 批量撤回/删除自己的消息 */
export function deleteMessages(ids, userId) {
  const list = Array.isArray(ids) ? ids.slice(0, 100) : []
  let done = 0
  for (const id of list) {
    try {
      const row = stMessageById.get(String(id))
      if (!row) continue
      if (row.sender_id !== userId) continue
      if (row.deleted) continue
      stSetDeleted.run(now(), userId, row.id)
      done++
    } catch { /* 跳过 */ }
  }
  return { deleted: done }
}

/* ------------------------------------------------------------------ */
/*  管理后台：用户行为分析                                              */
/* ------------------------------------------------------------------ */

export function adminUserActivity(userId, days = 30) {
  const u = stUserById.get(String(userId))
  if (!u) throw statusError(404, '用户不存在')

  const since = now() - days * 86400000

  const total = db.prepare(
    'SELECT COUNT(*) n FROM messages WHERE sender_id = ? AND deleted = 0'
  ).get(u.id).n

  const recent = db.prepare(
    'SELECT COUNT(*) n FROM messages WHERE sender_id = ? AND deleted = 0 AND created_at >= ?'
  ).get(u.id, since).n

  // 按天统计（最近 14 天）
  const perDay = []
  for (let i = 13; i >= 0; i--) {
    const d0 = new Date(Date.now() - i * 86400000)
    d0.setHours(0, 0, 0, 0)
    const d1 = d0.getTime() + 86400000
    const c = db.prepare(
      'SELECT COUNT(*) n FROM messages WHERE sender_id = ? AND deleted = 0 AND created_at >= ? AND created_at < ?'
    ).get(u.id, d0.getTime(), d1).n
    perDay.push({ day: (d0.getMonth() + 1) + '/' + d0.getDate(), count: c })
  }

  // 活跃时段（0-23 点分布）
  const hours = new Array(24).fill(0)
  const rows = db.prepare(
    'SELECT created_at FROM messages WHERE sender_id = ? AND deleted = 0 AND created_at >= ?'
  ).all(u.id, since)
  for (const r of rows) {
    const h = new Date(r.created_at).getHours()
    if (h >= 0 && h < 24) hours[h]++
  }

  // 最活跃的几个会话
  const topConvs = db.prepare(`
    SELECT conv_id, COUNT(*) n FROM messages
    WHERE sender_id = ? AND deleted = 0
    GROUP BY conv_id ORDER BY n DESC LIMIT 5
  `).all(u.id).map((r) => {
    let name = '会话'
    try {
      const c = stConvById.get(r.conv_id)
      if (c) {
        if (c.type === 'group' || c.type === 'channel') name = c.title || '群聊'
        else {
          const p = db.prepare(`
            SELECT u2.name FROM conversation_members cm JOIN users u2 ON u2.id = cm.user_id
            WHERE cm.conv_id = ? AND cm.user_id <> ? LIMIT 1
          `).get(c.id, u.id)
          name = p ? p.name : '私聊'
        }
      }
    } catch {}
    return { convId: r.conv_id, name, count: r.n }
  })

  // 撤回、被删
  const recalled = db.prepare(
    'SELECT COUNT(*) n FROM messages WHERE sender_id = ? AND deleted = 1'
  ).get(u.id).n

  return {
    user: publicUser(u),
    total, recent, recalled,
    perDay,
    hours,
    topConvs
  }
}

/* ------------------------------------------------------------------ */
/*  好友关系                                                            */
/* ------------------------------------------------------------------ */

export function isFriend(a, b) {
  return !!db.prepare('SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?').get(String(a), String(b))
}

function makeFriends(a, b) {
  const t = now()
  const st = db.prepare('INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)')
  st.run(String(a), String(b), t)
  st.run(String(b), String(a), t)
}

/** 发好友申请 */
export function sendFriendRequest(fromId, toId, message) {
  if (String(fromId) === String(toId)) throw statusError(400, '不能加自己')
  const target = stUserById.get(String(toId))
  if (!target) throw statusError(404, '用户不存在')
  if (isFriend(fromId, toId)) return { status: 'already_friend' }
  if (isBlocked(toId, fromId)) throw statusError(403, '对方不接收你的申请')

  // 已经申请过就别重复
  const pending = db.prepare(
    "SELECT * FROM friend_requests WHERE from_id = ? AND to_id = ? AND status = 'pending'"
  ).get(String(fromId), String(toId))
  if (pending) return { status: 'pending', id: pending.id }

  // 如果对方也申请过我 → 直接互相成为好友
  const reverse = db.prepare(
    "SELECT * FROM friend_requests WHERE from_id = ? AND to_id = ? AND status = 'pending'"
  ).get(String(toId), String(fromId))
  if (reverse) {
    db.prepare("UPDATE friend_requests SET status = 'accepted', handled_at = ? WHERE id = ?").run(now(), reverse.id)
    makeFriends(fromId, toId)
    return { status: 'accepted' }
  }

  const id = 'fr_' + randomBytes(8).toString('hex')
  db.prepare(
    'INSERT INTO friend_requests (id, from_id, to_id, message, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, String(fromId), String(toId), String(message || '').slice(0, 200) || null, now())
  return { status: 'sent', id }
}

/** 同意 / 拒绝 */
export function respondFriendRequest(requestId, userId, accept) {
  const r = db.prepare('SELECT * FROM friend_requests WHERE id = ?').get(String(requestId))
  if (!r) throw statusError(404, '申请不存在')
  if (r.to_id !== userId) throw statusError(403, '这不是给你的申请')
  if (r.status !== 'pending') throw statusError(400, '已经处理过了')

  if (accept) {
    db.prepare("UPDATE friend_requests SET status = 'accepted', handled_at = ? WHERE id = ?").run(now(), r.id)
    makeFriends(r.from_id, r.to_id)
    return { status: 'accepted' }
  }
  db.prepare("UPDATE friend_requests SET status = 'rejected', handled_at = ? WHERE id = ?").run(now(), r.id)
  return { status: 'rejected' }
}

/** 我收到的好友申请 */
export function myFriendRequests(userId) {
  const rows = db.prepare(`
    SELECT r.*, u.name AS from_name, u.avatar AS from_avatar, u.im_id AS from_im_id
    FROM friend_requests r LEFT JOIN users u ON u.id = r.from_id
    WHERE r.to_id = ? AND r.status = 'pending'
    ORDER BY r.created_at DESC LIMIT 50
  `).all(userId)
  return rows.map((r) => ({
    id: r.id,
    fromId: r.from_id,
    fromName: r.from_name || '未知',
    fromAvatar: r.from_avatar || '',
    fromImId: r.from_im_id || '',
    message: r.message || '',
    createdAt: r.created_at
  }))
}

/** 我的好友列表 */
export function listFriends(userId) {
  const rows = db.prepare(`
    SELECT u.id, u.name, u.avatar, u.im_id, u.phone, u.title, u.title_color, f.created_at
    FROM friends f JOIN users u ON u.id = f.friend_id
    WHERE f.user_id = ?
    ORDER BY f.created_at DESC
  `).all(userId)
  return rows.map((u) => publicUser(u))
}

/** 我和某人之间的好友状态 */
export function friendStatus(a, b) {
  if (isFriend(a, b)) return { status: 'friend' }
  const out = db.prepare(
    "SELECT id FROM friend_requests WHERE from_id = ? AND to_id = ? AND status = 'pending'"
  ).get(String(a), String(b))
  if (out) return { status: 'requested', requestId: out.id }
  const inc = db.prepare(
    "SELECT id FROM friend_requests WHERE from_id = ? AND to_id = ? AND status = 'pending'"
  ).get(String(b), String(a))
  if (inc) return { status: 'incoming', requestId: inc.id }
  return { status: 'none' }
}

/* ------------------------------------------------------------------ */
/*  举报                                                                */
/* ------------------------------------------------------------------ */

export function submitReport(userId, { targetId, targetName, reason, detail, messageId } = {}) {
  const why = String(reason || '').trim()
  if (!why) throw statusError(400, '选个举报原因')
  const u = userId ? stUserById.get(userId) : null
  const id = 'rp_' + randomBytes(8).toString('hex')
  let tname = String(targetName || '')
  if (!tname && targetId) {
    const t = stUserById.get(String(targetId))
    tname = t ? t.name : ''
  }
  db.prepare(`
    INSERT INTO reports (id, reporter_id, reporter, target_id, target_name, reason, detail, message_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, userId || null, u ? u.name : '',
    String(targetId || '') || null, tname || null,
    why.slice(0, 50), String(detail || '').slice(0, 500) || null,
    String(messageId || '') || null, now()
  )
  return { id }
}

export function listReports(limit = 100) {
  const rows = db.prepare('SELECT * FROM reports ORDER BY created_at DESC LIMIT ?')
    .all(Math.min(300, Number(limit) || 100))
  return rows.map((r) => ({
    id: r.id,
    reporter: r.reporter || '匿名',
    targetName: r.target_name || '未知',
    targetId: r.target_id || '',
    reason: r.reason,
    detail: r.detail || '',
    messageId: r.message_id || '',
    status: r.status,
    createdAt: r.created_at,
    handledAt: r.handled_at || null
  }))
}

export function handleReport(id, action) {
  const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(String(id))
  if (!r) throw statusError(404, '举报不存在')
  db.prepare('UPDATE reports SET status = ?, handled_at = ? WHERE id = ?')
    .run(String(action || 'done').slice(0, 20), now(), r.id)
  return { ok: true }
}

/* ------------------------------------------------------------------ */
/*  问题反馈                                                            */
/* ------------------------------------------------------------------ */

export function submitFeedback(userId, { content, contact, device, version, image } = {}) {
  const text = String(content || '').trim()
  if (!text) throw statusError(400, '写点什么再提交')
  if (text.length > 2000) throw statusError(400, '太长了，精简一下')
  const u = userId ? stUserById.get(userId) : null
  const id = 'fb_' + randomBytes(8).toString('hex')
  db.prepare(`
    INSERT INTO feedback (id, user_id, user_name, content, contact, device, version, image, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, userId || null, u ? u.name : '未登录用户',
    text, String(contact || '').slice(0, 100) || null,
    String(device || '').slice(0, 200) || null,
    String(version || '').slice(0, 30) || null,
    String(image || '').slice(0, 100) || null,
    now()
  )
  return { id }
}

export function listFeedback(limit = 100) {
  const rows = db.prepare(
    'SELECT * FROM feedback ORDER BY created_at DESC LIMIT ?'
  ).all(Math.min(300, Number(limit) || 100))
  return rows.map((r) => ({
    id: r.id,
    userName: r.user_name || '匿名',
    content: r.content,
    contact: r.contact || '',
    device: r.device || '',
    version: r.version || '',
    image: r.image || '',
    status: r.status,
    reply: r.reply || '',
    createdAt: r.created_at,
    handledAt: r.handled_at || null
  }))
}

export function replyFeedback(id, replyText) {
  const r = db.prepare('SELECT * FROM feedback WHERE id = ?').get(String(id))
  if (!r) throw statusError(404, '反馈不存在')
  db.prepare('UPDATE feedback SET reply = ?, status = ?, handled_at = ? WHERE id = ?')
    .run(String(replyText || '').slice(0, 1000), 'done', now(), r.id)
  return { ok: true }
}

/* ------------------------------------------------------------------ */
/*  个人主页                                                            */
/* ------------------------------------------------------------------ */

export function userProfile(targetId, viewerId) {
  const u = stUserById.get(String(targetId))
  if (!u) throw statusError(404, '用户不存在')

  // 共同群聊
  const commonGroups = db.prepare(`
    SELECT c.id, c.title, c.avatar, c.type
    FROM conversations c
    JOIN conversation_members m1 ON m1.conv_id = c.id AND m1.user_id = ?
    JOIN conversation_members m2 ON m2.conv_id = c.id AND m2.user_id = ?
    WHERE c.type IN ('group','channel')
    LIMIT 20
  `).all(String(targetId), viewerId).map((c) => ({
    id: c.id, title: c.title || '群聊', avatar: c.avatar || '', type: c.type
  }))

  // 和我的消息数
  let msgCount = 0
  try {
    const conv = getOrCreateDirect(viewerId, String(targetId))
    msgCount = db.prepare('SELECT COUNT(*) n FROM messages WHERE conv_id = ? AND deleted = 0').get(conv).n
  } catch {}

  return {
    user: publicUser(u),
    commonGroups,
    messageCount: msgCount,
    isFriend: true
  }
}

/* ------------------------------------------------------------------ */
/*  撤回记录（管理后台用）                                              */
/* ------------------------------------------------------------------ */

export function adminRecallLog(limit = 200) {
  const rows = db.prepare(`
    SELECT m.*, u.name AS sender_name, COALESCE(c.is_secret, 0) AS conv_secret
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    LEFT JOIN conversations c ON c.id = m.conv_id
    WHERE m.deleted = 1
    ORDER BY m.deleted_at DESC, m.created_at DESC
    LIMIT ?
  `).all(Math.min(500, Number(limit) || 200))

  return rows.map((r) => {
    // 原内容：body 加密过，这里解出来
    let original = ''
    if (r.conv_secret) original = '[密聊内容，无法查看]'
    else { try { original = decryptBody(r.body) } catch { original = '' } }

    const sender = r.sender_name || '未知'
    let deleter = ''
    if (r.deleted_by) {
      const u = stUserById.get(r.deleted_by)
      deleter = u ? u.name : '未知'
    }

    // 会话名
    let convName = ''
    try {
      const c = stConvById.get(r.conv_id)
      if (c) {
        if (c.type === 'group' || c.type === 'channel') convName = c.title || '群聊'
        else {
          const names = db.prepare(`
            SELECT u.name FROM conversation_members cm JOIN users u ON u.id = cm.user_id
            WHERE cm.conv_id = ? LIMIT 2
          `).all(c.id).map((x) => x.name)
          convName = names.join(' ⇄ ') || '私聊'
        }
      }
    } catch {}

    return {
      id: r.id,
      convId: r.conv_id,
      convName,
      kind: r.kind,
      senderName: sender,
      deleterName: deleter,
      original,
      createdAt: r.created_at,
      deletedAt: r.deleted_at || null
    }
  })
}

/* ------------------------------------------------------------------ */
/*  双向撤回：一键清空整个会话（双方设备上的都会消失）                  */
/* ------------------------------------------------------------------ */

/** 清空会话里所有消息。返回被删的媒体 id，供调用方删文件 */
export function purgeConversation(convId, userId) {
  const conv = stConvById.get(convId)
  if (!conv) throw statusError(404, '会话不存在')
  if (!isMember(convId, userId)) throw statusError(403, '不在这个会话里')

  // 收集要删的媒体文件
  const mediaIds = []
  const rows = db.prepare(
    "SELECT body, kind FROM messages WHERE conv_id = ? AND kind IN ('image','voice','file','video')"
  ).all(convId)
  for (const r of rows) {
    try {
      const id = decryptBody(r.body)
      if (id) mediaIds.push(id)
    } catch {}
  }

  // 硬删（不是软删）：双方都拿不到，服务器也不留
  const info = db.prepare('DELETE FROM messages WHERE conv_id = ?').run(convId)
  try { db.prepare('DELETE FROM message_reactions WHERE message_id NOT IN (SELECT id FROM messages)').run() } catch {}
  try { db.prepare('DELETE FROM message_edits WHERE message_id NOT IN (SELECT id FROM messages)').run() } catch {}
  try { db.prepare('DELETE FROM message_stars WHERE message_id NOT IN (SELECT id FROM messages)').run() } catch {}
  try { db.prepare('UPDATE conversations SET pinned_msg_id = NULL WHERE id = ?').run(convId) } catch {}

  return { deleted: info.changes || 0, mediaIds }
}

/* ------------------------------------------------------------------ */
/*  群成员搜索                                                          */
/* ------------------------------------------------------------------ */

export function searchMembers(convId, userId, keyword) {
  if (!isMember(convId, userId)) throw statusError(403, '不在这个会话里')
  const q = String(keyword || '').trim().toLowerCase()
  const all = membersOf(convId)
  if (!q) return all
  return all.filter((m) =>
    String(m.name || '').toLowerCase().includes(q) ||
    String(m.imId || '').includes(q)
  )
}

/** 一条消息的编辑历史（解密后的旧内容） */
export function messageEditHistory(messageId, userId) {
  const row = stMessageById.get(String(messageId))
  if (!row) throw statusError(404, '消息不存在')
  if (!isMember(row.conv_id, userId)) throw statusError(403, '不在这个会话里')
  const rows = db.prepare(
    'SELECT old_body, edited_at FROM message_edits WHERE message_id = ? ORDER BY edited_at ASC'
  ).all(row.id)
  return rows.map((r) => {
    let body = ''
    try { body = decryptBody(r.old_body) } catch {}
    return { body, at: r.edited_at }
  })
}

/* ------------------------------------------------------------------ */
/*  两步验证（TOTP，标准 30 秒 / 6 位，兼容 Google Authenticator）       */
/* ------------------------------------------------------------------ */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function base32Encode(buf) {
  let bits = 0, value = 0, out = ''
  for (const b of buf) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = 0, value = 0
  const out = []
  for (const ch of clean) {
    const idx = B32.indexOf(ch)
    if (idx < 0) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

function hotp(secretBuf, counter) {
  const buf = Buffer.alloc(8)
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0)
  buf.writeUInt32BE(counter >>> 0, 4)
  const h = createHmac('sha1', secretBuf).update(buf).digest()
  const off = h[h.length - 1] & 0x0f
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]
  return String(code % 1000000).padStart(6, '0')
}

/** 生成新密钥 */
export function setupTotp(userId) {
  const secret = base32Encode(randomBytes(20))
  db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret, userId)
  const u = stUserById.get(userId)
  const label = encodeURIComponent('悄悄:' + (u.im_id || u.name || ''))
  const issuer = encodeURIComponent('悄悄')
  return {
    secret,
    uri: `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&period=30&digits=6`
  }
}

/** 用验证码开启 */
export function enableTotp(userId, code) {
  const u = stUserById.get(userId)
  if (!u || !u.totp_secret) throw statusError(400, '先生成密钥')
  if (!verifyTotp(userId, code)) throw statusError(400, '验证码不对')
  db.prepare('UPDATE users SET totp_on = 1 WHERE id = ?').run(userId)
  return { totpOn: true }
}

/** 关闭两步验证（要输密码） */
export function disableTotp(userId, password) {
  const u = stUserById.get(userId)
  if (!u) throw statusError(404, '用户不存在')
  const actual = hashPassword(String(password || ''), u.salt)
  const ok = u.pass_hash && u.pass_hash.length === actual.length &&
    timingSafeEqual(Buffer.from(u.pass_hash, 'hex'), Buffer.from(actual, 'hex'))
  if (!ok) throw statusError(403, '密码不对')
  db.prepare('UPDATE users SET totp_on = 0, totp_secret = NULL WHERE id = ?').run(userId)
  return { totpOn: false }
}

/** 验证一个 6 位码（允许前后 1 个时间窗） */
export function verifyTotp(userId, code) {
  const u = stUserById.get(userId)
  if (!u || !u.totp_secret) return false
  const secretBuf = base32Decode(u.totp_secret)
  const counter = Math.floor(Date.now() / 30000)
  const input = String(code || '').replace(/\D/g, '')
  for (let i = -1; i <= 1; i++) {
    if (hotp(secretBuf, counter + i) === input) return true
  }
  return false
}

export function isTotpOn(userId) {
  const u = stUserById.get(userId)
  return !!(u && u.totp_on)
}

/* ------------------------------------------------------------------ */
/*  账号注销                                                            */
/* ------------------------------------------------------------------ */

export function deleteAccount(userId, password) {
  const u = stUserById.get(userId)
  if (!u) throw statusError(404, '用户不存在')
  const actual = hashPassword(String(password || ''), u.salt)
  const ok = u.pass_hash && u.pass_hash.length === actual.length &&
    timingSafeEqual(Buffer.from(u.pass_hash, 'hex'), Buffer.from(actual, 'hex'))
  if (!ok) throw statusError(403, '密码不对')
  // 不允许注销最后一个开发者
  if (u.role === 'admin') {
    const admins = db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin'").get().n
    if (admins <= 1) throw statusError(400, '这是唯一的管理员，不能注销')
  }
  // 删除用户（级联删除会话成员、消息、会话等）
  db.prepare('DELETE FROM users WHERE id = ?').run(userId)
  return { ok: true }
}

/* ------------------------------------------------------------------ */
/*  发现公开频道                                                        */
/* ------------------------------------------------------------------ */

export function listPublicChannels(userId, keyword) {
  const q = String(keyword || '').trim()
  const like = '%' + q + '%'
  const rows = db.prepare(`
    SELECT c.id, c.title, c.avatar, c.created_at,
           (SELECT COUNT(*) FROM conversation_members m2 WHERE m2.conv_id = c.id) AS member_count,
           (SELECT COUNT(*) FROM messages mm WHERE mm.conv_id = c.id AND mm.deleted = 0) AS msg_count
    FROM conversations c
    WHERE c.type = 'channel' AND c.is_public = 1
      ${q ? 'AND c.title LIKE ?' : ''}
    ORDER BY member_count DESC, c.created_at DESC
    LIMIT 50
  `).all(...(q ? [like] : []))
  return rows.map((c) => ({
    id: c.id,
    title: c.title || '未命名频道',
    avatar: c.avatar || '',
    memberCount: c.member_count,
    messageCount: c.msg_count,
    joined: isMember(c.id, userId)
  }))
}

/** 加入公开频道（不需要邀请码） */
export function joinPublicChannel(convId, userId) {
  const conv = stConvById.get(String(convId))
  if (!conv) throw statusError(404, '频道不存在')
  if (conv.type !== 'channel') throw statusError(400, '不是频道')
  if (!conv.is_public) throw statusError(403, '这个频道不是公开的')
  if (isMember(conv.id, userId)) return { convId: conv.id, already: true }
  db.prepare('INSERT OR IGNORE INTO conversation_members (conv_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .run(conv.id, userId, 'member', now())
  return { convId: conv.id, already: false, title: conv.title || '频道' }
}

/** 切换频道公开状态（频道主/管理员） */
export function setChannelPublic(convId, userId, isPublic) {
  const conv = stConvById.get(convId)
  if (!conv) throw statusError(404, '会话不存在')
  if (conv.type !== 'channel') throw statusError(400, '只有频道能设为公开')
  const lvl = myLevel(convId, userId)
  if (!['dev', 'owner', 'group_admin'].includes(lvl)) throw statusError(403, '权限不够')
  db.prepare('UPDATE conversations SET is_public = ? WHERE id = ?').run(isPublic ? 1 : 0, convId)
  return { isPublic: !!isPublic }
}

/* ------------------------------------------------------------------ */
/*  导出聊天记录                                                        */
/* ------------------------------------------------------------------ */

export function exportConversation(convId, userId, format = 'txt') {
  if (!isMember(convId, userId)) throw statusError(403, '不在这个会话里')
  const conv = stConvById.get(convId)
  const rows = db.prepare(
    'SELECT * FROM messages WHERE conv_id = ? ORDER BY seq ASC'
  ).all(convId)

  const nameOf = (uid) => {
    const u = stUserById.get(uid)
    return u ? u.name : '未知'
  }

  const lines = []
  if (format === 'txt') {
    lines.push('【' + (conv.title || '聊天记录') + '】')
    lines.push('导出时间：' + new Date().toLocaleString('zh-CN'))
    lines.push('消息数：' + rows.length)
    lines.push('')
    for (const r of rows) {
      const t = new Date(r.created_at).toLocaleString('zh-CN')
      let body = ''
      try { body = decryptBody(r.body) } catch { body = '' }
      if (r.kind === 'image') body = '[图片]'
      else if (r.kind === 'voice') body = '[语音]'
      else if (r.kind === 'file') body = '[文件]'
      else if (r.kind === 'sticker') body = '[表情]'
      else if (r.kind === 'video') body = '[视频]'
      else if (r.kind === 'location') body = '[位置]'
      else if (r.kind === 'dice') body = '[骰子 ' + body + ']'
      else if (r.kind === 'rps') body = '[猜拳 ' + body + ']'
      else if (r.kind === 'pat') body = '[拍一拍]'
      else if (r.kind === 'poll') body = '[投票]'
      if (r.deleted) body = '[已撤回]'
      lines.push('[' + t + '] ' + nameOf(r.sender_id) + '：' + body)
    }
    return { text: lines.join('\n'), filename: (conv.title || 'chat') + '.txt' }
  }

  // JSON
  const data = rows.map((r) => {
    let body = ''
    try { body = decryptBody(r.body) } catch {}
    return {
      time: new Date(r.created_at).toISOString(),
      sender: nameOf(r.sender_id),
      kind: r.kind,
      body: r.deleted ? '' : body,
      deleted: !!r.deleted
    }
  })
  return { text: JSON.stringify({ title: conv.title, messages: data }, null, 2), filename: (conv.title || 'chat') + '.json' }
}

/* ------------------------------------------------------------------ */
/*  隐私开关                                                            */
/* ------------------------------------------------------------------ */

export function setPrivacy(userId, { showOnline, showRead } = {}) {
  if (showOnline !== undefined) {
    db.prepare('UPDATE users SET show_online = ? WHERE id = ?').run(showOnline ? 1 : 0, userId)
  }
  if (showRead !== undefined) {
    db.prepare('UPDATE users SET show_read = ? WHERE id = ?').run(showRead ? 1 : 0, userId)
  }
  return publicUser(stUserById.get(userId))
}

/** 界面偏好（字号、气泡样式） */
export function setPrefs(userId, { fontSize, bubbleStyle } = {}) {
  if (fontSize !== undefined) {
    const v = ['normal', 'large', 'xlarge'].includes(fontSize) ? fontSize : null
    db.prepare('UPDATE users SET font_size = ? WHERE id = ?').run(v, userId)
  }
  if (bubbleStyle !== undefined) {
    const v = ['round', 'square'].includes(bubbleStyle) ? bubbleStyle : null
    db.prepare('UPDATE users SET bubble_style = ? WHERE id = ?').run(v, userId)
  }
  return publicUser(stUserById.get(userId))
}

/** 会话的免打扰时间段 */
export function setQuietHours(convId, userId, range) {
  if (!isMember(convId, userId)) throw statusError(403, '不在这个会话里')
  const v = String(range || '').trim().slice(0, 20)
  if (v && !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(v)) throw statusError(400, '格式要像 22:00-08:00')
  db.prepare('UPDATE conversation_members SET quiet_hours = ? WHERE conv_id = ? AND user_id = ?')
    .run(v || null, convId, userId)
  return { quietHours: v }
}

/** 现在是不是这个会话的免打扰时段 */
/**
 * 免打扰白名单：免打扰/静音时，这几种情况仍然提醒
 *  - 被 @
 *  - 私聊
 *  - 关键词
 */
export function shouldStillNotify(convId, userId, message) {
  const conv = stConvById.get(convId)
  if (!conv) return false
  // 私聊默认提醒
  if (conv.type === 'direct') return true
  // 被 @ 就提醒
  try {
    const list = message && message.mentions ? JSON.parse(message.mentions) : []
    if (Array.isArray(list) && (list.includes('all') || list.includes(userId))) return true
  } catch {}
  return false
}

export function inQuietHours(convId, userId) {
  const r = db.prepare('SELECT quiet_hours FROM conversation_members WHERE conv_id = ? AND user_id = ?').get(convId, userId)
  if (!r || !r.quiet_hours) return false
  const m = r.quiet_hours.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/)
  if (!m) return false
  const nowD = new Date()
  const cur = nowD.getHours() * 60 + nowD.getMinutes()
  const from = Number(m[1]) * 60 + Number(m[2])
  const to = Number(m[3]) * 60 + Number(m[4])
  if (from === to) return false
  return from < to ? (cur >= from && cur < to) : (cur >= from || cur < to)
}

/** 设置谁能给我发私聊 */
export function setMsgPolicy(userId, policy) {
  const v = ['all', 'friend', 'none'].includes(policy) ? policy : 'all'
  db.prepare('UPDATE users SET msg_policy = ? WHERE id = ?').run(v, userId)
  return { msgPolicy: v }
}

/**
 * 我能不能给这个人发私聊。
 * friend 模式下：只有【已经有过对话】的人能发
 */
export function canMessageMe(targetId, fromId) {
  const t = stUserById.get(String(targetId))
  if (!t) return { ok: false, reason: '用户不存在' }
  const policy = t.msg_policy || 'all'
  if (policy === 'all') return { ok: true }
  if (policy === 'none') return { ok: false, reason: '对方不接收陌生消息' }
  // friend：检查有没有过私聊
  const has = db.prepare(`
    SELECT 1 FROM conversations c
    JOIN conversation_members m1 ON m1.conv_id = c.id AND m1.user_id = ?
    JOIN conversation_members m2 ON m2.conv_id = c.id AND m2.user_id = ?
    WHERE c.type = 'direct' LIMIT 1
  `).get(String(targetId), String(fromId))
  if (has) return { ok: true }
  return { ok: false, reason: '对方只接收好友消息' }
}

/** 水印开关 */
export function setWatermark(userId, on) {
  db.prepare('UPDATE users SET watermark = ? WHERE id = ?').run(on ? 1 : 0, userId)
  return { watermark: !!on }
}

/** 这个人愿不愿意公开在线状态 */
export function canSeeOnline(userId) {
  const u = stUserById.get(String(userId))
  if (!u) return false
  return u.show_online !== 0
}

/* ------------------------------------------------------------------ */
/*  群权限（细粒度）                                                    */
/* ------------------------------------------------------------------ */

const ALL_PERMS = ['send', 'add_member', 'delete_msg', 'pin', 'change_info', 'invite']

/** 读某个成员的权限集合 */
export function permsOf(convId, userId) {
  const conv = stConvById.get(convId)
  if (!conv) return []
  const lvl = myLevel(convId, userId)
  // 群主 / 管理员 / 开发者：全部权限
  if (['dev', 'owner', 'group_admin'].includes(lvl)) return ALL_PERMS.slice()
  const row = db.prepare('SELECT perms FROM conversation_members WHERE conv_id = ? AND user_id = ?').get(convId, userId)
  if (row && row.perms) {
    try {
      const arr = JSON.parse(row.perms)
      if (Array.isArray(arr)) return arr.filter((p) => ALL_PERMS.includes(p))
    } catch {}
  }
  return ['send']   // 默认只能发消息
}

/** 设置某个成员的权限（管理员操作） */
export function setMemberPerms(convId, targetId, perms, byUserId) {
  const conv = stConvById.get(convId)
  if (!conv) throw statusError(404, '会话不存在')
  const lvl = myLevel(convId, byUserId)
  if (!['dev', 'owner'].includes(lvl)) throw statusError(403, '只有群主能改权限')
  const target = stUserById.get(String(targetId))
  if (!target) throw statusError(404, '成员不存在')
  const list = (perms || []).filter((p) => ALL_PERMS.includes(p))
  db.prepare('UPDATE conversation_members SET perms = ? WHERE conv_id = ? AND user_id = ?')
    .run(JSON.stringify(list), convId, targetId)
  return { perms: list }
}

/** 设置慢速模式（秒） */
export function setSlowMode(convId, seconds, byUserId) {
  const conv = stConvById.get(convId)
  if (!conv) throw statusError(404, '会话不存在')
  const lvl = myLevel(convId, byUserId)
  if (!['dev', 'owner', 'group_admin'].includes(lvl)) throw statusError(403, '权限不够')
  const s = Math.max(0, Math.min(3600, Number(seconds) || 0))
  db.prepare('UPDATE conversations SET slow_mode = ? WHERE id = ?').run(s, convId)
  return { slowMode: s }
}

/** 检查慢速限制，超了就抛错 */
export function checkSlowMode(convId, userId) {
  const conv = stConvById.get(convId)
  if (!conv || !conv.slow_mode) return
  const lvl = myLevel(convId, userId)
  if (['dev', 'owner', 'group_admin'].includes(lvl)) return   // 管理员不受限
  const last = db.prepare(
    'SELECT created_at FROM messages WHERE conv_id = ? AND sender_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(convId, userId)
  if (!last) return
  const wait = conv.slow_mode * 1000 - (now() - last.created_at)
  if (wait > 0) {
    throw statusError(429, '慢速模式：还要等 ' + Math.ceil(wait / 1000) + ' 秒才能再发')
  }
}

/* ------------------------------------------------------------------ */
/*  邀请链接                                                            */
/* ------------------------------------------------------------------ */

export function getInviteCode(convId, userId) {
  const conv = stConvById.get(convId)
  if (!conv) throw statusError(404, '会话不存在')
  if (conv.type !== 'group' && conv.type !== 'channel') throw statusError(400, '只有群聊和频道有邀请链接')
  const lvl = myLevel(convId, userId)
  if (!['dev', 'owner', 'group_admin'].includes(lvl)) throw statusError(403, '只有管理员能生成邀请链接')

  if (!conv.invite_code) {
    // 生成一个 8 位的短码，避开易混字符
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
    let code = ''
    for (let i = 0; i < 8; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)]
    db.prepare('UPDATE conversations SET invite_code = ? WHERE id = ?').run(code, convId)
    return { code }
  }
  return { code: conv.invite_code }
}

/** 用邀请码加入群 */
export function joinByInvite(code, userId) {
  const c = db.prepare('SELECT * FROM conversations WHERE invite_code = ?').get(String(code || ''))
  if (!c) throw statusError(404, '邀请链接无效或已失效')
  if (isMember(c.id, userId)) return { convId: c.id, already: true }

  const t = now()
  db.prepare('INSERT OR IGNORE INTO conversation_members (conv_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .run(c.id, userId, 'member', t)
  return { convId: c.id, already: false, title: c.title || '群聊' }
}

/** 邀请码预览（不需要登录也能看群名，方便落地页） */
export function peekInvite(code) {
  const c = db.prepare('SELECT id, type, title, avatar FROM conversations WHERE invite_code = ?').get(String(code || ''))
  if (!c) return null
  const n = db.prepare('SELECT COUNT(*) n FROM conversation_members WHERE conv_id = ?').get(c.id).n
  return { convId: c.id, type: c.type, title: c.title || '群聊', avatar: c.avatar || '', memberCount: n }
}

/* ------------------------------------------------------------------ */
/*  全局搜索                                                            */
/* ------------------------------------------------------------------ */

export function globalSearch(userId, keyword, kinds = null) {
  const q = String(keyword || '').trim()
  if (!q) return { users: [], convs: [], messages: [] }
  // kinds: ['text','image','voice','file'] 之类；不传就只搜文本
  const kindFilter = Array.isArray(kinds) && kinds.length ? kinds : ['text']
  const like = '%' + q + '%'

  // ① 用户：按名字、数字 ID、手机号搜（排除自己）
  const users = db.prepare(`
    SELECT id, name, avatar, im_id, phone FROM users
    WHERE id <> ? AND (name LIKE ? OR im_id LIKE ? OR phone LIKE ?)
    LIMIT 20
  `).all(userId, like, like, like).map((u) => ({
    id: u.id, name: u.name, avatar: u.avatar, imId: u.im_id || '', phone: u.phone || ''
  }))

  // ② 群/频道：只搜我参与的
  const convs = db.prepare(`
    SELECT c.id, c.type, c.title, c.avatar FROM conversations c
    JOIN conversation_members m ON m.conv_id = c.id
    WHERE m.user_id = ? AND c.type IN ('group','channel') AND c.title LIKE ?
    LIMIT 20
  `).all(userId, like).map((c) => ({
    id: c.id, type: c.type, title: c.title, avatar: c.avatar
  }))

  // ③ 消息：只在我参与的会话里搜（解密后匹配，数量有限所以可接受）
  const myConvs = db.prepare('SELECT conv_id FROM conversation_members WHERE user_id = ?').all(userId).map((r) => r.conv_id)
  const messages = []
  if (myConvs.length) {
    const placeholders = myConvs.map(() => '?').join(',')
    const rows = db.prepare(`
      SELECT m.id, m.conv_id, m.sender_id, m.body, m.kind, m.created_at,
             u.name AS sender_name
      FROM messages m LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.conv_id IN (${placeholders}) AND m.deleted = 0
        ${kindFilter ? `AND m.kind IN (${kindFilter.map(() => '?').join(',')})` : ""}
      ORDER BY m.created_at DESC LIMIT 400
    `).all(...myConvs, ...(kindFilter || []))

    const lower = q.toLowerCase()
    for (const r of rows) {
      let plain = ''
      try { plain = decryptBody(r.body) } catch { continue }
      // 非文本消息按类型命中即可，不做内容匹配
      if (r.kind !== 'text') {
        // 落到这里说明 kindFilter 里有这个类型，直接收
      } else if (plain.toLowerCase().indexOf(lower) < 0) {
        continue
      }
      let convName = ''
      try {
        const c = stConvById.get(r.conv_id)
        if (c) {
          if (c.type === 'group' || c.type === 'channel') convName = c.title || '群聊'
          else {
            const peer = db.prepare(`
              SELECT u2.name FROM conversation_members cm JOIN users u2 ON u2.id = cm.user_id
              WHERE cm.conv_id = ? AND cm.user_id <> ? LIMIT 1
            `).get(c.id, userId)
            convName = peer ? peer.name : '私聊'
          }
        }
      } catch {}
      messages.push({
        id: r.id, convId: r.conv_id, convName, convTitle: convName,
        senderName: r.sender_name || '',
        body: plain,
        createdAt: r.created_at
      })
      if (messages.length >= 50) break
    }
  }

  return { users, convs, messages }
}

/* ------------------------------------------------------------------ */
/*  消息收藏                                                            */
/* ------------------------------------------------------------------ */

export function toggleStar(messageId, userId) {
  const row = stMessageById.get(String(messageId))
  if (!row) throw statusError(404, '消息不存在')
  if (!isMember(row.conv_id, userId)) throw statusError(403, '不在这个会话里')
  const has = db.prepare('SELECT 1 FROM message_stars WHERE user_id = ? AND message_id = ?').get(userId, row.id)
  if (has) {
    db.prepare('DELETE FROM message_stars WHERE user_id = ? AND message_id = ?').run(userId, row.id)
    return { starred: false }
  }
  db.prepare('INSERT INTO message_stars (user_id, message_id, created_at) VALUES (?, ?, ?)').run(userId, row.id, now())
  return { starred: true }
}

export function myStars(userId) {
  const rows = db.prepare(`
    SELECT m.*, s.created_at AS star_at
    FROM message_stars s JOIN messages m ON m.id = s.message_id
    WHERE s.user_id = ? AND m.deleted = 0
    ORDER BY s.created_at DESC LIMIT 200
  `).all(userId)
  return rows.map((r) => {
    const m = shapeMessage(r, { withReply: false })
    let convName = ''
    try {
      const c = stConvById.get(r.conv_id)
      if (c) {
        if (c.type === 'group' || c.type === 'channel') convName = c.title || '群聊'
        else {
          const peer = db.prepare(`
            SELECT u.name FROM conversation_members cm JOIN users u ON u.id = cm.user_id
            WHERE cm.conv_id = ? AND cm.user_id <> ? LIMIT 1
          `).get(c.id, userId)
          convName = peer ? peer.name : '私聊'
        }
      }
    } catch {}
    m.convName = convName
    m.starAt = r.star_at
    return m
  })
}

/* ------------------------------------------------------------------ */
/*  匿名提问                                                            */
/* ------------------------------------------------------------------ */

/** 提问者指纹：目标+盐，无法反推是谁 */
function askerHash(targetId, salt) {
  try {
    return createHash('sha256').update(String(targetId) + '|' + String(salt)).digest('hex').slice(0, 16)
  } catch {
    return 'anon'
  }
}

export function askAnonymously(targetId, question, salt) {
  const t = stUserById.get(String(targetId))
  if (!t) throw statusError(404, '没有这个人')
  const q = String(question || '').trim().slice(0, 200)
  if (!q) throw statusError(400, '问题不能为空')

  const h = askerHash(targetId, salt || '')
  // 同一个人对同一个人 10 分钟内只能问一次，防止刷屏
  const recent = db.prepare(
    'SELECT created_at FROM anon_questions WHERE target_id = ? AND asker_hash = ? ORDER BY created_at DESC LIMIT 1'
  ).get(t.id, h)
  if (recent && now() - recent.created_at < 10 * 60 * 1000) {
    throw statusError(429, '刚问过，等十分钟再问吧')
  }

  const id = uid('aq_')
  db.prepare('INSERT INTO anon_questions (id, target_id, asker_hash, question, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, t.id, h, q, now())
  return { id, question: q }
}

export function myAnonQuestions(userId) {
  const rows = db.prepare(
    'SELECT * FROM anon_questions WHERE target_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(userId)
  return rows.map((r) => ({
    id: r.id,
    question: r.question,
    answer: r.answer || '',
    createdAt: r.created_at,
    answeredAt: r.answered_at
  }))
}

export function answerAnon(questionId, userId, answer) {
  const row = db.prepare('SELECT * FROM anon_questions WHERE id = ?').get(String(questionId))
  if (!row) throw statusError(404, '问题不存在')
  if (row.target_id !== userId) throw statusError(403, '不是问你的')
  const a = String(answer || '').trim().slice(0, 500)
  if (!a) throw statusError(400, '回答不能为空')
  db.prepare('UPDATE anon_questions SET answer = ?, answered_at = ? WHERE id = ?').run(a, now(), row.id)
  return { id: row.id, answer: a }
}

/** 某人公开的问答（只返回已回答的） */
export function publicAnonOf(userId) {
  const rows = db.prepare(
    "SELECT id, question, answer, answered_at FROM anon_questions WHERE target_id = ? AND answer IS NOT NULL AND answer <> '' ORDER BY answered_at DESC LIMIT 20"
  ).all(userId)
  return rows.map((r) => ({ id: r.id, question: r.question, answer: r.answer, at: r.answered_at }))
}

/* ------------------------------------------------------------------ */
/*  签到与活跃榜                                                        */
/* ------------------------------------------------------------------ */

const dayStr = (ts = Date.now()) => {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return d.getFullYear() + '-' + m + '-' + dd
}

/** 今天签个到（重复调用不会重复记） */
export function checkin(userId) {
  const day = dayStr()
  const has = db.prepare('SELECT 1 FROM checkins WHERE user_id = ? AND day = ?').get(userId, day)
  if (!has) {
    db.prepare('INSERT INTO checkins (user_id, day, created_at) VALUES (?, ?, ?)').run(userId, day, now())
  }
  // 连续天数
  let streak = 0
  let cursor = new Date()
  for (let i = 0; i < 400; i++) {
    const k = dayStr(cursor.getTime())
    const got = db.prepare('SELECT 1 FROM checkins WHERE user_id = ? AND day = ?').get(userId, k)
    if (!got) break
    streak++
    cursor.setDate(cursor.getDate() - 1)
  }
  const firstToday = db.prepare(
    'SELECT user_id FROM checkins WHERE day = ? ORDER BY created_at ASC LIMIT 1'
  ).get(day)
  const firstUser = firstToday ? stUserById.get(firstToday.user_id) : null
  return {
    day,
    checked: true,
    streak,
    alreadyToday: !!has,
    firstToday: firstUser ? firstUser.name : '',
    firstIsMe: !!(firstUser && firstUser.id === userId)
  }
}

/** 今天的签到榜 + 最近 7 天活跃度 */
export function checkinBoard() {
  const day = dayStr()
  const people = stUserById ? null : null
  const rows = db.prepare(`
    SELECT c.user_id, c.created_at, u.name
    FROM checkins c JOIN users u ON u.id = c.user_id
    WHERE c.day = ? ORDER BY c.created_at ASC
  `).all(day)

  const list = rows.map((r) => ({ id: r.user_id, name: r.name, at: r.created_at }))

  // 最近 7 天每人发了几条消息，当作活跃度
  const since = Date.now() - 7 * 24 * 3600 * 1000
  const active = db.prepare(`
    SELECT m.sender_id AS id, u.name, COUNT(*) AS n
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE m.created_at >= ? AND m.deleted = 0
    GROUP BY m.sender_id ORDER BY n DESC LIMIT 10
  `).all(since)

  return { day, list, active }
}

/* ------------------------------------------------------------------ */
/*  群投票                                                             */
/* ------------------------------------------------------------------ */

export function createPoll(convId, userId, question, options, multi = false) {
  if (!isMember(convId, userId)) throw statusError(403, '不在这个会话里')
  const q = String(question || '').trim().slice(0, 60)
  if (!q) throw statusError(400, '问题不能为空')
  const opts = (options || []).map((x) => String(x || '').trim().slice(0, 30)).filter(Boolean).slice(0, 6)
  if (opts.length < 2) throw statusError(400, '至少要两个选项')

  const id = uid('pl_')
  db.prepare('INSERT INTO polls (id, conv_id, creator_id, question, options, multi, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, convId, userId, q, JSON.stringify(opts), multi ? 1 : 0, now())
  return getPoll(id, userId)
}

/** 读一个投票（带票数和自己的选择） */
export function getPoll(pollId, userId) {
  const p = db.prepare('SELECT * FROM polls WHERE id = ?').get(String(pollId))
  if (!p) throw statusError(404, '投票不存在')
  let options = []
  try { options = JSON.parse(p.options) } catch { options = [] }

  const votes = db.prepare('SELECT user_id, option_index FROM poll_votes WHERE poll_id = ?').all(p.id)
  const counts = options.map(() => 0)
  const mine = []
  const voters = options.map(() => [])
  for (const v of votes) {
    if (v.option_index >= 0 && v.option_index < counts.length) {
      counts[v.option_index]++
      voters[v.option_index].push(v.user_id)
      if (v.user_id === userId) mine.push(v.option_index)
    }
  }
  const creator = stUserById.get(p.creator_id)
  return {
    id: p.id,
    convId: p.conv_id,
    question: p.question,
    options: options.map((t, i) => ({ text: t, count: counts[i], users: voters[i] })),
    multi: !!p.multi,
    total: votes.length,
    mine,
    creatorName: creator ? creator.name : '',
    createdAt: p.created_at
  }
}

export function votePoll(pollId, userId, optionIndex) {
  const p = db.prepare('SELECT * FROM polls WHERE id = ?').get(String(pollId))
  if (!p) throw statusError(404, '投票不存在')
  if (!isMember(p.conv_id, userId)) throw statusError(403, '不在这个会话里')
  let options = []
  try { options = JSON.parse(p.options) } catch { options = [] }
  const idx = Number(optionIndex)
  if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) throw statusError(400, '选项不对')

  const has = db.prepare('SELECT 1 FROM poll_votes WHERE poll_id = ? AND user_id = ? AND option_index = ?')
    .get(p.id, userId, idx)

  if (has) {
    db.prepare('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ? AND option_index = ?').run(p.id, userId, idx)
  } else {
    if (!p.multi) {
      // 单选：先清掉自己的旧票
      db.prepare('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?').run(p.id, userId)
    }
    db.prepare('INSERT INTO poll_votes (poll_id, user_id, option_index, created_at) VALUES (?, ?, ?, ?)')
      .run(p.id, userId, idx, now())
  }
  return getPoll(p.id, userId)
}

export function statusError(status, message) {
  const e = new Error(message)
  e.status = status
  return e
}

export function dbFile() {
  return DB_FILE
}

export function stats() {
  const one = (sql) => db.prepare(sql).get().n
  return {
    users: one('SELECT COUNT(*) n FROM users'),
    conversations: one('SELECT COUNT(*) n FROM conversations'),
    messages: one('SELECT COUNT(*) n FROM messages')
  }
}

/* ---------------- 端到端加密公钥 ---------------- */
// 只存公钥包，服务器没有任何私钥；消息正文由客户端加解密
export function saveE2eeBundle(userId, bundle) {
  db.prepare(`INSERT INTO e2ee_bundles (user_id, bundle, updated_at) VALUES (?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET bundle=excluded.bundle, updated_at=excluded.updated_at`)
    .run(userId, JSON.stringify(bundle), Date.now())
  return true
}

export function getE2eeBundle(userId) {
  const r = db.prepare('SELECT bundle FROM e2ee_bundles WHERE user_id = ?').get(userId)
  if (!r) return null
  try { return JSON.parse(r.bundle) } catch { return null }
}

/** 哪些用户已经上传了 E2EE 公钥（能接收密聊） */
/** 所有用户（管理接口用） */
export function listAllUsers() {
  return db.prepare('SELECT * FROM users ORDER BY created_at').all().map(publicUser)
}

export function e2eeReadyUsers() {
  const rows = db.prepare('SELECT user_id FROM e2ee_bundles').all()
  const set = new Set()
  for (const r of rows) set.add(r.user_id)
  return set
}

export function e2eeEnabled(userId) {
  return !!db.prepare('SELECT 1 x FROM e2ee_bundles WHERE user_id = ?').get(userId)
}


/* ---------------- 群聊 SenderKey 分发包 ---------------- */
// payload 是客户端用一对一会话密钥加密过的密文，服务器解不开
export function saveGroupSenderKey({ convId, userId, targetId, epoch, payload }) {
  db.prepare(`INSERT INTO e2ee_group_state (conv_id, user_id, target_id, epoch, payload, created_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(conv_id, user_id, target_id, epoch)
    DO UPDATE SET payload=excluded.payload, created_at=excluded.created_at`)
    .run(convId, userId, targetId, Number(epoch) || 1, JSON.stringify(payload), Date.now())
  return true
}

// 取「某人发给我的」最新一代分发包
export function getGroupSenderKey(convId, fromUserId, targetId) {
  const r = db.prepare(`SELECT epoch, payload FROM e2ee_group_state
    WHERE conv_id = ? AND user_id = ? AND target_id = ?
    ORDER BY epoch DESC LIMIT 1`).get(convId, fromUserId, targetId)
  if (!r) return null
  try { return { epoch: r.epoch, payload: JSON.parse(r.payload) } } catch { return null }
}

// 某个群里我给别人分发过的最大 epoch
export function maxGroupEpoch(convId, userId) {
  const r = db.prepare('SELECT MAX(epoch) e FROM e2ee_group_state WHERE conv_id = ? AND user_id = ?')
    .get(convId, userId)
  return r && r.e ? r.e : 0
}
