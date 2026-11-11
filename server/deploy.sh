#!/usr/bin/env bash
# ============================================================
# IM 服务端 VPS 一键部署
#
# 用法（在 VPS 上，root）：
#   bash deploy.sh im.example.com
#
# 前提：
#   - 域名的 A 记录已指向这台机器（HTTPS 证书要验证）
#   - 代码已经传到这台机器（在当前目录，有 server.mjs）
#   - Ubuntu 22.04+ / Debian 12+
#
# 做的事：装 Node 24 → 建系统用户 → 部署代码 → systemd →
#        Caddy 自动 HTTPS → 防火墙 → 每日备份
# ============================================================
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR="/opt/im-server"
DATA_DIR="/var/lib/im-server"
BACKUP_DIR="/var/backups/im-server"
SVC_USER="im"
NODE_VER="${NODE_VER:-v24.10.0}"
PORT="${PORT:-3001}"
# 对外 HTTPS 端口。443 被别的服务占用时改这里（例如 8443）
HTTPS_PORT="${HTTPS_PORT:-443}"

log()  { printf '\033[36m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[deploy] %s\033[0m\n' "$*"; }
die()  { printf '\033[31m[deploy] %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 运行"
[[ -n "$DOMAIN" ]] || die "用法: bash deploy.sh 你的域名（例: bash deploy.sh im.example.com）"
[[ -f server.mjs ]] || die "当前目录没有 server.mjs，先把代码传上来"

# ---------- 0. 域名解析检查 ----------
MYIP=$(curl -fsSL --max-time 5 https://api.ipify.org 2>/dev/null || echo "")
DOMAIN_IP=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)
if [[ -z "$DOMAIN_IP" ]]; then
  warn "域名 $DOMAIN 还没解析，Caddy 签证书会失败。先去 DNS 加 A 记录再继续。"
  warn "继续执行会把服务装好，但 HTTPS 要等你解析后重启 caddy。"
elif [[ -n "$MYIP" && "$DOMAIN_IP" != "$MYIP" ]]; then
  warn "域名解析到 $DOMAIN_IP，但本机出口 IP 是 $MYIP —— 不一致，证书会失败"
else
  log "域名解析正常: $DOMAIN -> $DOMAIN_IP"
fi

# ---------- 1. 系统依赖 ----------
log "安装系统依赖"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates xz-utils gnupg apt-transport-https \
  debian-keyring debian-archive-keyring >/dev/null

# ---------- 2. Node.js（必须 22.5+，node:sqlite 才存在）----------
need_node=1
if command -v node >/dev/null 2>&1; then
  CUR=$(node -p "process.versions.node" 2>/dev/null || echo "0")
  MAJOR=${CUR%%.*}
  if [[ "$MAJOR" -ge 22 ]]; then
    # 再确认 node:sqlite 真的可用（有的发行版裁掉了）
    if node -e "require('node:sqlite')" 2>/dev/null; then
      log "已有 Node $CUR 且 node:sqlite 可用，跳过安装"
      need_node=0
    else
      warn "Node $CUR 存在但不带 node:sqlite，重装官方版"
    fi
  else
    warn "当前 Node $CUR 太旧（需要 >=22.5），安装 $NODE_VER"
  fi
fi

if [[ $need_node -eq 1 ]]; then
  case "$(uname -m)" in
    x86_64)  NARCH="x64" ;;
    aarch64) NARCH="arm64" ;;
    *) die "不支持的架构: $(uname -m)" ;;
  esac
  TARBALL="node-$NODE_VER-linux-$NARCH.tar.xz"
  log "下载 $TARBALL"
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/$TARBALL" -o "/tmp/$TARBALL" \
    || die "下载失败，检查 $NODE_VER 是不是有效版本号"
  tar -xJf "/tmp/$TARBALL" -C /opt
  ln -sf "/opt/node-$NODE_VER-linux-$NARCH/bin/node" /usr/local/bin/node
  ln -sf "/opt/node-$NODE_VER-linux-$NARCH/bin/npm"  /usr/local/bin/npm
  ln -sf "/opt/node-$NODE_VER-linux-$NARCH/bin/npx"  /usr/local/bin/npx
  rm -f "/tmp/$TARBALL"
  node -e "require('node:sqlite')" 2>/dev/null \
    || die "Node 装好了但 node:sqlite 仍不可用，检查版本是否 >= 22.5"
  log "Node 安装完成: $(node -v)"
fi

# ---------- 3. 系统用户与目录 ----------
if ! id "$SVC_USER" >/dev/null 2>&1; then
  log "创建系统用户 $SVC_USER"
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SVC_USER" || true
fi

mkdir -p "$APP_DIR" "$DATA_DIR" "$BACKUP_DIR"

# ---------- 4. 部署代码 ----------
log "同步代码到 $APP_DIR"
# 排除本地数据库、测试文件和依赖，避免把开发数据带上生产
tar -cf - \
  --exclude=node_modules \
  --exclude='*.db' \
  --exclude='*.db-wal' \
  --exclude='*.db-shm' \
  --exclude=test \
  --exclude=.git \
  . | tar -xf - -C "$APP_DIR"

cd "$APP_DIR"
log "安装生产依赖"
npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --omit=dev

chown -R "$SVC_USER:$SVC_USER" "$APP_DIR" "$DATA_DIR" "$BACKUP_DIR"
chmod 750 "$DATA_DIR"

# ---------- 5. 密钥与邀请码 ----------
# ⚠ MSG_KEY 一旦生成就不能换，否则历史消息全部解不开。
#   所以这里只在文件不存在时生成，重复部署不会覆盖。
SECRETS_FILE="/etc/im-server/secrets.env"
mkdir -p /etc/im-server
if [[ ! -f "$SECRETS_FILE" ]]; then
  log "生成消息加密密钥与邀请码"
  MSGKEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  # 邀请码取 8 位好念的字符（去掉容易混淆的 0O1lI）
  INVITE=$(node -e "
    const a='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const b=require('crypto').randomBytes(8);
    console.log([...b].map(x=>a[x%a.length]).join(''));
  ")

  # VAPID：Web Push 的身份凭证。生成失败就关掉推送，不影响聊天
  VAPID_PUB=""
  VAPID_PRIV=""
  if [[ -d "$APP_DIR/node_modules/web-push" ]]; then
    log "生成 VAPID 密钥（Web Push）"
    read -r VAPID_PUB VAPID_PRIV < <(node -e "
      const wp = require('$APP_DIR/node_modules/web-push');
      const k = wp.generateVAPIDKeys();
      console.log(k.publicKey + ' ' + k.privateKey);
    " 2>/dev/null || echo ' ')
    if [[ -z "$VAPID_PUB" || -z "$VAPID_PRIV" ]]; then
      warn "VAPID 生成失败，推送功能将关闭"
    fi
  else
    warn "没找到 web-push，推送功能将关闭（可以先 npm install 再重跑）"
  fi

  cat > "$SECRETS_FILE" <<EOF
MSG_KEY=$MSGKEY
INVITE_CODE=$INVITE
VAPID_PUBLIC=$VAPID_PUB
VAPID_PRIVATE=$VAPID_PRIV
VAPID_SUBJECT=mailto:admin@$DOMAIN
EOF
  chmod 600 "$SECRETS_FILE"
else
  log "复用已有密钥（$SECRETS_FILE）"
fi
INVITE_CODE=$(grep '^INVITE_CODE=' "$SECRETS_FILE" | cut -d= -f2)
PUSH_STATE="已关闭（没有 VAPID 密钥）"
if grep -q '^VAPID_PUBLIC=.\+' "$SECRETS_FILE"; then
  PUSH_STATE="已启用"
fi

# ---------- 6. systemd ----------
log "写入 systemd 服务"
cat > /etc/systemd/system/im-server.service <<EOF
[Unit]
Description=Self-hosted IM server (HTTP + WebSocket)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$SECRETS_FILE
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=HOST=127.0.0.1
Environment=DB_FILE=$DATA_DIR/data.db
Environment=CORS_ORIGIN=https://$DOMAIN
ExecStart=/usr/local/bin/node $APP_DIR/server.mjs
Restart=always
RestartSec=3
LimitNOFILE=65535

# 硬性保护：服务只能写自己的数据目录
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF

# 密钥文件给服务用户读，但不能被别人读
chown root:"$SVC_USER" "$SECRETS_FILE"
chmod 640 "$SECRETS_FILE"

systemctl daemon-reload
systemctl enable im-server >/dev/null 2>&1
systemctl restart im-server
sleep 2

if systemctl is-active --quiet im-server; then
  log "服务已启动"
else
  die "服务启动失败: journalctl -u im-server -n 50 --no-pager"
fi

# 本地健康检查
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    log "健康检查通过: $(curl -fsS http://127.0.0.1:$PORT/api/health)"
    break
  fi
  [[ $i -eq 20 ]] && die "健康检查超时，看日志: journalctl -u im-server -n 50"
  sleep 0.5
done

# ---------- 6. Caddy（自动 HTTPS + WSS 反代）----------
if ! command -v caddy >/dev/null 2>&1; then
  log "安装 Caddy"
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

log "配置 Caddy 反代"
cat > /etc/caddy/Caddyfile <<EOF
# 由 deploy.sh 生成
$DOMAIN:$HTTPS_PORT {
    encode zstd gzip

    # WebSocket 与 REST 都走同一个后端，Caddy 会自动处理 Upgrade
    reverse_proxy 127.0.0.1:$PORT {
        # 长连接不要被过早掐断
        transport http {
            read_timeout 0
            write_timeout 0
        }
    }

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "no-referrer"
    }

    log {
        output file /var/log/caddy/im-access.log {
            roll_size 10mb
            roll_keep 5
        }
    }
}
EOF

systemctl enable caddy >/dev/null 2>&1 || true
systemctl restart caddy
sleep 3

if systemctl is-active --quiet caddy; then
  log "Caddy 已启动（证书签发作需要几分钟，失败看 journalctl -u caddy）"
else
  warn "Caddy 启动失败，常见原因：域名没解析 / 80 端口被占用"
fi

# ---------- 7. 防火墙 ----------
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow $HTTPS_PORT/tcp >/dev/null 2>&1 || true
  log "已放行 ufw 80/$HTTPS_PORT"
fi

# ---------- 8. 每日备份 ----------
log "配置每日备份（保留 14 天）"
cat > /usr/local/bin/im-backup.sh <<EOF
#!/usr/bin/env bash
set -euo pipefail
STAMP=\$(date +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/data-\$STAMP.db"
# 用 sqlite 的在线备份，保证一致性（直接 cp 一个正在写的库会拿到坏文件）
node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('$DATA_DIR/data.db', { readOnly: true });
db.exec(\"VACUUM INTO '\$OUT'\");
db.close();
" 2>/dev/null || cp "$DATA_DIR/data.db" "\$OUT"
gzip -f "\$OUT"
find "$BACKUP_DIR" -name 'data-*.db.gz' -mtime +14 -delete
EOF
chmod +x /usr/local/bin/im-backup.sh

cat > /etc/cron.d/im-server-backup <<EOF
# 每天凌晨 3:17 备份 IM 数据库
17 3 * * * root /usr/local/bin/im-backup.sh >> /var/log/im-backup.log 2>&1
EOF

# 首次立即备份一次
/usr/local/bin/im-backup.sh || warn "首次备份失败（不影响服务）"

# ---------- 9. 完成 ----------
if [[ "$HTTPS_PORT" == "443" ]]; then URL_HOST="$DOMAIN"; else URL_HOST="$DOMAIN:$HTTPS_PORT"; fi

cat <<EOF

============================================================
部署完成

  站点      https://$URL_HOST/
  API       https://$URL_HOST/api/health
  WebSocket wss://$URL_HOST/ws?token=<你的token>
  数据      $DATA_DIR/data.db（消息内容是 AES-256-GCM 密文）
  密钥      /etc/im-server/secrets.env（600，备份时一起备）

  ┌──────────────────────────────────────────────┐
  │  邀请码：$INVITE_CODE                          │
  └──────────────────────────────────────────────┘
  注册时不带这个码会被拒（403）。只发给你的朋友。
  想换邀请码：改 /etc/im-server/secrets.env 里的 INVITE_CODE，然后重启服务。

常用命令：
  systemctl status im-server      # 看状态
  journalctl -u im-server -f      # 看日志
  systemctl restart im-server     # 重启
  systemctl restart caddy         # 改完域名解析后重载证书

更新代码：
  # 本地把新代码传上来后，在代码目录重跑
  bash deploy.sh $DOMAIN

自测（在另一台机器上）：
  curl https://$URL_HOST/api/health

⚠ 三条容易忘的事：
  1. 云厂商安全组要放行 80/443（ufw 只管系统内部）
  2. secrets.env 里的 MSG_KEY 千万别丢，丢了历史消息永久解不开
  3. 备份要连 secrets.env 一起备，只有 data.db 是恢复不出来的
============================================================
EOF