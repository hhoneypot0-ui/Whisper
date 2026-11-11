# 悄悄 · Whisper

几个人的私密聊天。自建服务器，数据在自己手里。

> 没有广告，没有算法，没有第三个人在听。

---

## 这是什么

一个**只给少数几个人用**的自托管聊天工具。整个项目由两部分组成：

| 部分 | 说明 |
| --- | --- |
| `server/` | Node.js 服务端，同时提供网页版和 API |
| `android/` | Android 外壳，把网页包成 App |

网页版本身就能用（加到主屏幕即可），Android 外壳只是补上浏览器拿不到的能力：麦克风、原生通知、文件选择器、返回键。

---

## 功能

- **聊天**：文字、图片、语音、文件、表情、贴纸
- **群聊**：群主 / 群管理员 / 成员三级权限，自定义头衔（可设颜色）
- **话题**：群里按主题拆成多个子频道
- **朋友圈**：发动态、配图、地点、点赞、评论、回复某人
- **消息**：撤回、编辑、引用、转发、置顶、搜索、按日期跳转
- **会话**：置顶、免打扰、特别关心、分组、删除
- **其他**：赞助开发者、外观主题（玻璃 / iOS）、PWA、Web Push

---

## 技术栈

```
服务端    Node.js 24 + node:sqlite（内置，无外部数据库）
通信      WebSocket（自研协议）+ HTTP REST
加密      消息与图片 AES-256-GCM 落盘加密
前端      单文件 HTML + 原生 JS，无框架、无构建步骤
外壳      Android WebView + JS Bridge
```

**零第三方运行时依赖**（除了 `ws` 和 `web-push`）。

---

## 快速开始

### 服务端

```bash
cd server
npm install
```

准备密钥（第一次运行会生成，或手动写 `/etc/im-server/secrets.env`）：

```env
MSG_KEY=<32 字节随机 hex>
INVITE_CODE=<邀请码>
VAPID_PUBLIC=<web push 公钥>
VAPID_PRIVATE=<web push 私钥>
```

启动：

```bash
node server.mjs
```

默认监听 `127.0.0.1:3001`，建议前面挂 Caddy 或 Nginx 做 HTTPS。

一键部署脚本见 `server/deploy.sh`（Ubuntu，含 systemd + Caddy + 每日备份）。

### Android

```bash
cd android
./gradlew assembleDebug
```

产物：`app/build/outputs/apk/debug/app-debug.apk`

**改接口地址**：`app/src/main/java/.../MainActivity.java` 里的 `START_URL`。

---

## 架构要点

**为什么用 WebView 而不是原生重写？**

因为改一次网页，所有端立刻生效，不用重新打包发版。对几个人用的小工具来说，"改完就好"比"启动快 0.3 秒"重要得多。

代价是启动比原生慢零点几秒，用本地缓存 + 骨架屏把它压到了几乎无感。

**消息加密**

落盘加密，**不是端到端加密**。服务端持有密钥，所以服务器管理员理论上能解密任何消息。这是刻意的设计——为了支持多设备、搜索、备份。

---

## 隐私说明

- 消息内容用 AES-256-GCM 加密后写入 SQLite
- 图片加密后存磁盘，文件名是随机串
- 所有数据在你自己的服务器上，不经过任何第三方

**但请明确**：管理员（部署这个服务的人）能查看所有消息。这不是漏洞，是设计。

---

## License

MIT
