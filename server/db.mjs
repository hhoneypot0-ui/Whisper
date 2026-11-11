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
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
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
// 用户对外 ID（代替手机号给别人加好友用）
ensureColumn('users', 'im_id', 'TEXT')
// 元老：早期注册的用户，可以自定义靓号 ID
ensureColumn('users', 'is_veteran', 'INTEGER NOT NULL DEFAULT 0')
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

export function register({ phone, password, name, invite }) {
  // 只有几个朋友用 —— 开放注册等于把服务器地址泄露就等于被陌生人挤进来
  const required = (process.env.INVITE_CODE || '').trim()
  if (required && String(invite || '').trim() !== required) {
    throw statusError(403, '邀请码不对')
  }
  const p = normalizePhone(phone)
  const pass = String(password || '')
  if (pass.length < 8) throw statusError(400, '密码至少 8 位')
  const nick = String(name || '').trim() || '用户' + p.slice(-4)
  if (stUserByPhone.get(p)) throw statusError(409, '这个手机号已经注册过')

  const salt = randomBytes(16).toString('hex')
  const id = uid('u_')
  const userCount = db.prepare('SELECT COUNT(*) n FROM users').get().n
  const veteran = userCount < 10 ? 1 : 0   // 前 10 个注册的是元老
  stInsertUser.run(id, p, nick, '', salt, hashPassword(pass, salt), now(), genImId(), veteran)
  return publicUser(stUserById.get(id))
}

export function login({ phone, password, imId }) {
  // 支持用 ID 或手机号登录
  let row
  if (imId) {
    row = db.prepare('SELECT * FROM users WHERE im_id = ?').get(String(imId).trim())
  } else {
    const p = normalizePhone(phone)
    row = stUserByPhone.get(p)
  }
  // 账号不存在也走一遍哈希，避免用响应时间探测哪些号注册过
  const salt = row?.salt ?? 'x'.repeat(32)
  const expect = row?.pass_hash ?? 'x'.repeat(128)
  const actual = hashPassword(String(password || ''), salt)
  const okLen = expect.length === actual.length
  const ok = okLen && timingSafeEqual(Buffer.from(expect, 'hex'), Buffer.from(actual, 'hex'))
  if (!row || !ok) throw statusError(401, '账号或密码不对')
  return publicUser(row)
}

/** 对外输出的用户对象，永远不带 salt / pass_hash */
export function publicUser(row) {
  if (!row) return null
  return { id: row.id, phone: row.phone, name: row.name, avatar: row.avatar, role: row.role || 'user', imId: row.im_id || '', isVeteran: !!row.is_veteran }
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

export function createSession(userId) {
  const token = randomBytes(32).toString('hex')
  const t = now()
  stInsertSession.run(token, userId, t, t + SESSION_TTL, t)
  return token
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

export function createGroup(ownerId, name, memberIds = [], type = 'group') {
  const ids = [...new Set([ownerId, ...memberIds.map(String)])].filter((id) => stUserById.get(id))
  if (ids.length < 2) throw statusError(400, '群聊至少要有两个人')
  if (ids.length > 200) throw statusError(400, '群成员太多')

  const id = uid('c_')
  const t = now()
  db.exec('BEGIN IMMEDIATE')
  try {
    // 群没有"唯一键"概念，用 group:<id> 占住 UNIQUE 约束
    stInsertConv.run(id, type, type + ':' + id, String(name || '').slice(0, 40), ownerId, t, t)
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
    db.prepare('UPDATE conversations SET announcement = ? WHERE id = ?')
      .run(String(announcement).slice(0, 500) || null, convId)
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
      online: false   // 由 server 层用 hub 补真实值
    }
  })
}

/** 会话列表：带对方信息、最后一条消息、未读数 */
const stConvsOfUser = db.prepare(`
  SELECT c.id, c.type, c.title, c.owner_id, c.created_at, c.updated_at,
         c.announcement, c.avatar, c.ttl,
         m.last_read_seq, m.muted, m.pinned, m.starred, m.folder
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
  INSERT INTO messages (id, conv_id, sender_id, seq, body, kind, client_id, reply_to, created_at, mentions, topic_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
export function sendMessage({ convId, senderId, body, kind = 'text', clientId, replyTo = null, mentions = null, topicId = null }) {
  if (!isMember(convId, senderId)) throw statusError(403, '不在这个会话里')

  // 频道：只有群主、管理员、开发者能发
  const convRowChk = stConvById.get(convId)
  if (convRowChk && convRowChk.type === 'channel') {
    const lvl = myLevel(convId, senderId)
    if (!['dev', 'owner', 'group_admin'].includes(lvl)) {
      throw statusError(403, '这是频道，只有管理员能发言')
    }
  }

  const text = String(body ?? '')

  // @提及：过滤成字符串数组，最多 50 个
  const mentionList = Array.isArray(mentions)
    ? mentions.filter((x) => typeof x === 'string' && x).slice(0, 50)
    : []
  const mentionsJson = mentionList.length ? JSON.stringify(mentionList) : null

  const MEDIA_KINDS = ['image', 'voice', 'file']
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
      clientId || null, replyId, t, mentionsJson, topicId || null
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
export function messagesSince(convId, userId, sinceSeq) {
  if (!isMember(convId, userId)) throw statusError(403, '不在这个会话里')
  return stSince.all(convId, sinceSeq, 500).map(shapeMessage)
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
  const stillMsg = db.prepare(
    'SELECT COUNT(*) n FROM messages WHERE body = ? AND deleted = 0'
  ).get(id).n
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
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE conv_id IN (${placeholders}) AND deleted = 0 AND kind = 'text'
       ORDER BY created_at DESC LIMIT 3000`
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

export function setRole(userId, role) {
  if (!['admin', 'user'].includes(role)) throw statusError(400, '角色不合法')
  const u = stUserById.get(userId)
  if (!u) throw statusError(404, '用户不存在')
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId)
  return publicUser(stUserById.get(userId))
}

/** 管理员：所有用户 */
export function adminListUsers() {
  return db.prepare('SELECT id, phone, name, avatar, role, created_at, im_id FROM users ORDER BY created_at').all()
    .map((u) => ({ id: u.id, phone: u.phone, name: u.name, avatar: u.avatar, role: u.role, createdAt: u.created_at, imId: u.im_id || '' }))
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
export function purgeOrphanMedia() {
  const rows = db.prepare('SELECT id FROM images').all()
  let removed = 0
  for (const r of rows) {
    if (gcMedia(r.id)) removed++
  }
  return removed
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