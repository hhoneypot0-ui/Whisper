# 自研 IM 服务端

独立账号体系的即时通信系统：手机号注册、WebSocket 实时收发、离线补偿、已读回执、
群聊、语音、文件、搜索、撤回、引用、表情、@、置顶、免打扰、拉黑。
**服务端跑在 VPS 上，客户端是一个网页（可加到主屏当 App）。**

技术栈：Node 24 + `node:sqlite`（内置，无原生编译）+ `ws`（唯一的生产依赖）。

---

## 一、VPS 要求

| 项 | 最低 | 建议 |
| --- | --- | --- |
| CPU/内存 | 1 核 1G | 2 核 2G |
| 系统 | Ubuntu 22.04 / Debian 12 | Ubuntu 24.04 |
| 磁盘 | 10G | 20G |
| 带宽 | 1Mbps | 3Mbps+ |
| Node | **22.5+**（低于此版本没有 `node:sqlite`） | 24 LTS |

1 核 1G 撑几百个日活没问题——IM 的文字消息非常轻，一万条消息的库也就几 MB。

---

## 二、部署（五步）

### 1. 域名解析

在 DNS 里加一条 A 记录，指向 VPS 的 IP：

```
im.你的域名.com  →  A  →  你的VPS_IP
```

**这步必须在部署前做完**，因为 Caddy 要验证域名才能签发 HTTPS 证书。

### 2. 把代码传上去

在**你的电脑**上执行（不是 VPS）：

```bash
# 方式一：rsync（推荐，支持增量）
rsync -avz --exclude node_modules --exclude '*.db*' --exclude test \
  ./im-server/ root@你的VPS_IP:/root/im-server/

# 方式二：先打包再传
tar --exclude=node_modules --exclude='*.db*' -czf im-server.tar.gz im-server/
scp im-server.tar.gz root@你的VPS_IP:/root/
# VPS 上： tar xzf im-server.tar.gz
```

### 3. 一键部署

```bash
ssh root@你的VPS_IP
cd /root/im-server
bash deploy.sh im.你的域名.com
```

脚本会自动做完这些：

- 装 Node 24（**先验证 `node:sqlite` 真的能用**，不行就报错，不会装出一个跑不起来的服务）
- 建 `im` 系统用户，服务不以 root 运行
- 代码放 `/opt/im-server`，数据放 `/var/lib/im-server/data.db`
- systemd 托管 + 开机自启 + 崩溃自动重启
- Caddy 反代 + **自动申请续期 HTTPS 证书**，WebSocket 走同一个域名
- 防火墙放行 80/443
- 每天 3:17 用 `VACUUM INTO` 做一致性备份，保留 14 天

### 3.5 端口冲突（重要）

如果你的 VPS 上已经跑了别的服务占用 80/443（比如 xray/v2ray/nginx），部署时会冲突。两种解法：

**A. 换端口**（简单，但要带端口访问）
```bash
HTTPS_PORT=8443 bash deploy.sh im.你的域名.com
```
访问地址变成 `https://im.你的域名.com:8443`。

**B. 让已有服务让位**（推荐，用标准 443）
把代理的监听端口挪走，再正常部署：
```bash
# 以 3x-ui 为例：把 443 的入站改到 8443
node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/etc/x-ui/x-ui.db');db.prepare('UPDATE inbounds SET port=8443 WHERE port=443').run();db.close();"
systemctl restart x-ui
# 然后再部署，Caddy 就能占 443
bash deploy.sh im.你的域名.com
```
好处是用户访问不用带端口，且标准端口在国内网络更稳（非标端口常被 QoS 干扰）。

### 4. 云厂商安全组

⚠ **系统防火墙之外还要开安全组**：阿里云/腾讯云的入方向规则里放行 80 和 443。这步漏了，前面全白做。

### 5. 验证

```bash
curl https://im.你的域名.com/api/health
# {"ok":true,"users":0,"conversations":0,"messages":0,"online":0}
```

---

## 三、接口

所有 `/api/*` 需要 `Authorization: Bearer <token>`（注册/登录除外）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/register` | `{phone, password, name, invite}` → `{user, token}`（**invite 必填**） |
| POST | `/api/auth/login` | `{phone, password}` → `{user, token}` |
| POST | `/api/auth/logout` | 注销当前 token |
| GET | `/api/me` | 我的资料 |
| PATCH | `/api/me` | 改昵称/头像 |
| GET | `/api/users/lookup?phone=` | 按手机号找人 |
| GET | `/api/conversations` | 会话列表（含最后消息、未读数） |
| POST | `/api/conversations` | `{peerId}` 或 `{phone}` → 建/取会话 |
| GET | `/api/conversations/:id/messages?before=&limit=` | 历史（向上翻页） |
| GET | `/api/conversations/:id/sync?since=` | 断线后拉增量 |
| POST | `/api/conversations/:id/read` | `{seq}` 标记已读 |
| GET | `/api/conversations/:id/members` | 会话成员 |
| GET | `/api/push/vapid` | 推送公钥（未配置时 enabled=false） |
| POST | `/api/push/subscribe` | 提交浏览器 PushSubscription |
| POST | `/api/push/unsubscribe` | `{endpoint}` 取消订阅 |

### WebSocket：`wss://域名/ws?token=<token>`

小程序端不能自定义 header，所以 token 走 query 参数。

客户端 → 服务端：

```json
{"t":"send","convId":"c_xxx","clientId":"uuid-1","body":"你好"}
{"t":"read","convId":"c_xxx","seq":12}
{"t":"typing","convId":"c_xxx"}
{"t":"ping"}
```

服务端 → 客户端：

```json
{"t":"hello","user":{...},"serverTime":1730000000000}
{"t":"ack","clientId":"uuid-1","message":{...},"duplicate":false}
{"t":"message","message":{...}}
{"t":"read","convId":"c_xxx","userId":"u_xxx","seq":12}
{"t":"presence","userId":"u_xxx","online":true}
{"t":"pong"}
```

---

## 四、隐私是怎么保证的（几个人自用的场景）

「别人不知道我们在聊什么」这句话对应三个不同的投入，这套方案选的是**前两层**：

| 层次 | 防范对象 | 本方案 | 说明 |
| --- | --- | --- | --- |
| 传输加密 | 运营商、公共 WiFi、中间人 | ✅ TLS（Caddy 自动签） | WebSocket 走 wss，抓包只能看到密文 |
| 静态加密 | 云厂商、磁盘快照泄露、机器被回收 | ✅ AES-256-GCM | 库里存的是 `enc:v1:...`，**磁盘上看不到一句明文** |
| 端到端加密 | 服务器本身 / 服务管理员 | ❌ 没做 | 见下方「为什么不做 E2EE」 |

另外加了一道**邀请码**：没有码注册直接 403，避免域名泄露后被陌生人挤进来。

### 为什么不做 E2EE

端到端加密意味着**服务器也解不开**，代价是：

- 换手机 = 聊天记录全丢（密钥不在服务器，没法帮你恢复）
- 没法搜索历史消息（服务端只有密文）
- 多设备同步要自己做密钥分发
- 一个人丢了密钥，那段对话就永久读不了

而你的威胁模型里，服务器是你自己的。真正要防的是**云厂商拿到你的磁盘**——这一条静态加密已经解决了。为了防"我自己"去上 E2EE，在朋友几个人自用的场景里性价比很低。

如果确实要 E2EE，`messages.body` 字段改成存客户端密文即可，接口形状不用动。

### 密钥管理（最容易出事的地方）

```bash
/etc/im-server/secrets.env      # 600 权限，存 MSG_KEY 和 INVITE_CODE
```

- **`MSG_KEY` 丢了，历史消息永久解不开**，没有任何补救办法
- **备份时必须连 `secrets.env` 一起备**，只备 `data.db` 恢复出来是一片乱码
- 部署脚本重复执行**不会**重新生成密钥（有文件就复用），所以可以放心重跑
- 想换密钥：改 `MSG_KEY` 后需要跑 `reencryptAll(old, new)` 重加密，不能直接换

---

## 五、客户端（极简版已内置）

服务端自带一个单文件网页客户端 `public/index.html`，部署完直接打开域名就能用：

```
https://im.你的域名.com/
```

它内含：注册（含邀请码校验）、登录（token 存 localStorage，刷新不掉线）、会话列表（未读数、最后一条消息）、聊天窗口（实时收发、乐观发送、断线指数退避重连）、发起新对话（输对方手机号）。

**没有构建步骤**，改完 `index.html` 刷新浏览器就生效。

### 已实现的功能

| 功能 | 说明 |
| --- | --- |
| 账号 | 手机号注册，邀请码才能进；scrypt 密码哈希 |
| 一对一 / 群聊 | 群里显示发送者名、成员数、已读人数 |
| 文字 / 图片 / 语音 / 文件 | 全部加密存在服务器磁盘 |
| 引用回复 | 引用块显示是谁说的、缩略图或摘要 |
| 撤回 | 长按自己的消息，双方都变成「已撤回」 |
| 已读回执 | 一对一 ✓/✓✓，群聊「已读 2/3」 |
| 正在输入 | 对方打字时顶栏显示，3.5 秒无动作消失 |
| 表情 | 140 个常用 emoji |
| @ 提醒 | 群聊里长按消息 → @ 某人 |
| 置顶 / 免打扰 | 长按会话列表 |
| 删除对话 | 只是从自己列表隐藏，对方再发会重现 |
| 拉黑 | 被拉黑方发消息返回「消息已发出，但被对方拒收了」 |
| 搜索 | 跨会话搜，关键词高亮 |
| 消息推送 | 对方离线时 Web Push |
| PWA | 可添加到主屏，全屏无地址栏 |

**没做**：语音/视频通话（需要 WebRTC + TURN 中转，工作量相当于上面全部加起来）。

### 为什么用网页而不是 App

几个人自用的场景下，网页版省掉了：打包、签名、上架、iOS 分发。手机浏览器打开后「添加到主屏幕」，体验接近原生 App。唯一短板是 iOS 的 Web 推送要 16.4+ 且必须已添加到主屏——但聊天窗口打开时会自动拉取，不影响使用。

### PWA：加到主屏像原生 App

已经配好了，不需要额外操作：

| 文件 | 作用 |
| --- | --- |
| `public/manifest.webmanifest` | 应用名、图标、启动方式（standalone = 全屏无地址栏） |
| `public/sw.js` | Service Worker：缓存界面骨架，让安装按钮出现 |
| `public/icons/*.png` | 192 / 512 / maskable / apple-touch-icon |

**安装方法**：
- Android Chrome：地址栏右侧出现「安装」图标，或菜单 →「添加到主屏幕」
- iOS Safari：分享按钮 →「添加到主屏幕」（必须用 Safari，Chrome 不行）

**注意**：PWA 安装在 `https` 下才能触发（`localhost` 除外）。所以部署完有域名才能装。

**改图标**：`node tools/make-icons.mjs`（纯 Node 手绘 PNG，不依赖任何图形库），改完记得同步 `manifest.webmanifest` 里的 `theme_color`。

**Service Worker 的取舍**：只缓存 HTML 骨架和图标，**`/api/*` 和 `/ws` 一律不缓存**。聊天记录和图片要是进了 cache，等于在设备上留了一份副本——这跟"私密"的目标是冲突的。页面导航用 network-first，所以你改了 `index.html` 用户刷新就能看到新版，不会被旧缓存卡住。

### 消息推送（Web Push）

已内建。部署脚本会自动生成 VAPID 密钥并写进 `secrets.env`，无需手动配置。

**工作方式**：只给**不在线**的人推。对方挂着 WebSocket 时直接走实时通道，不重复弹通知——不然你在电脑上聊着，手机上还会震一下。

**开启方法**：登录后顶栏会出现一个铃铛图标，点一下授权即可。授权过就会静默续订，不会每次问。

**几个必须知道的限制**：

| 平台 | 要求 |
| --- | --- |
| Android Chrome | 直接可用，需 https |
| iOS | **16.4+**，且必须「添加到主屏幕」后**从主屏图标启动**，在 Safari 标签页里收不到 |
| 桌面浏览器 | 可用 |

iOS 那条是苹果的限制，不是代码问题。所以页面里的铃铛按钮在 iOS 非独立模式下会提示你先把应用加到主屏。

**技术上用了个依赖**：`web-push`。因为推送 payload 必须按 RFC 8291 加密（ECDH → HKDF → AES-128-GCM → aes128gcm 分包），手写任何一步错了，推送服务只回一个没有细节的 400，调试成本远超引一个包。

**失效订阅会自动清理**：推送服务返回 `410 Gone` / `404` 时（用户清了站点数据、卸载了 PWA），订阅记录就地删除，避免一直发一直失败。

**VAPID 密钥丢了会怎样**：所有已订阅的设备都会失效，用户需要重新点一次铃铛。不会丢消息，只是推送断掉。它存在 `secrets.env` 里，跟 `MSG_KEY` 一起备份就行。

### 这个页面该改哪

| 需求 | 位置 |
| --- | --- |
| 改主题色 | CSS 顶部的 `:root` 变量 |
| 加消息已读标记 | `handleWs` 里 `case 'read'` 目前是空的 |
| 加载更多历史 | `openConv()` 里用 `before` 参数翻页 |
| 图片消息 | 服务端 `kind` 字段已预留，客户端加 `<input type=file>` |
| 桌面通知 | `case 'message'` 里调 `new Notification()` |

---

## 六、几条设计上的硬约定（别改坏）

1. **`seq` 是会话内单调递增的整数**，由服务端在事务里分配。消息排序、未读数、已读位置、断线补偿全靠它，**不要用时间戳替代**——多设备时钟不一致会导致消息乱序。

2. **`clientId` 是幂等键**。客户端每条消息生成一个 UUID，失败重发时沿用同一个，服务端 `UNIQUE(conv_id, client_id)` 保证不会重复入库。弱网下这是必需的。

3. **1v1 会话用 `uniq_key = min(idA,idB)|max(idA,idB)`**，两边谁先发起都是同一条记录，不会出现"你那边一个会话、我这边一个会话"。

4. **密码用 scrypt + 每用户独立 salt**，校验走 `timingSafeEqual`；登录时手机号不存在也会算一遍假哈希，避免通过响应时间探测哪些号注册过。

---

## 七、运维

```bash
systemctl status im-server        # 状态
journalctl -u im-server -f        # 实时日志
systemctl restart im-server       # 重启
ls -lh /var/backups/im-server/    # 备份
```

**更新代码**：本地改完重新 `rsync`，然后在 VPS 上重跑 `bash deploy.sh 域名`。脚本是幂等的，不会覆盖数据库。

**恢复备份**：

```bash
systemctl stop im-server
gunzip -c /var/backups/im-server/data-20261110-031700.db.gz > /var/lib/im-server/data.db
chown im:im /var/lib/im-server/data.db
systemctl start im-server
```

---

## 八、还没做的（按优先级）

1. **客户端**：目前只有服务端，界面还没写（uni-app 一套出 App 和小程序）
2. **推送**：App 切后台收不到消息，需要接厂商推送（uni-push / 个推 / APNs）
3. **图片消息**：`kind` 字段已预留，需要接对象存储
4. **端到端加密**：现在传输层是 TLS，消息在库里是明文。要做 E2EE 得改 `body` 为密文并加密钥协商
5. **限流**：注册和发消息都该加频率限制，否则被人刷
6. **群聊**：目前只有 1v1，`conversations.type` 字段已经预留

---

## 九、本地开发

```bash
npm install
node server.mjs          # 默认 127.0.0.1:4000
npm test                 # 跑端到端测试（会起临时服务 + 临时库）
```

测试覆盖 32 项：注册登录、会话去重、实时收发、幂等重发、已读回执、离线补偿、历史分页、未读数、越权防护、参数校验。