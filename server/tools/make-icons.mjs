#!/usr/bin/env node
/**
 * 生成 PWA 图标（纯 Node，手写 PNG 编码，无第三方依赖）
 * 用法: node tools/make-icons.mjs
 * 输出到 public/icons/
 *
 * 图形：圆角方形渐变底 + 白色对话气泡 + 三个挖空圆点
 * 颜色和网页里的 --grad 保持一致（#5b6ef5 → #8b5cf6）
 */
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, '..', 'public', 'icons')
fs.mkdirSync(OUT, { recursive: true })

/* ---------- PNG 编码 ---------- */
function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    let c = (crc ^ buf[i]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const c = Buffer.alloc(4)
  c.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, c])
}
/** pixelFn(x,y) -> [r,g,b,a] */
function makePng(w, h, pixelFn) {
  const raw = Buffer.alloc(h * (1 + w * 4))
  let o = 0
  for (let y = 0; y < h; y++) {
    raw[o++] = 0
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = pixelFn(x, y)
      raw[o++] = r
      raw[o++] = g
      raw[o++] = b
      raw[o++] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ---------- 图形 ---------- */
const FROM = [0x5b, 0x6e, 0xf5]
const TO = [0x8b, 0x5c, 0xf6]
const lerp = (a, b, t) => Math.round(a + (b - a) * t)

/**
 * @param size 画布尺寸
 * @param opts.maskable true 时背景铺满（安卓自适应图标需要），内容留出安全边距
 */
function drawIcon(size, { maskable = false } = {}) {
  const S = size
  const radius = maskable ? 0 : S * 0.22 // maskable 由系统裁切，自己不要圆角
  const contentScale = maskable ? 0.78 : 1
  const cx = S / 2
  const cy = S / 2
  const bubbleR = (S * 0.3) * contentScale
  const dotR = S * 0.028 * contentScale
  const dotGap = S * 0.088 * contentScale

  // 圆角方形内部判定
  const inShape = (x, y) => {
    if (maskable) return true
    const rx = Math.min(Math.max(x, radius), S - radius)
    const ry = Math.min(Math.max(y, radius), S - radius)
    const dx = x - rx
    const dy = y - ry
    if (dx * dx + dy * dy <= radius * radius) return true
    return x >= radius && x <= S - radius && y >= 0 && y <= S
      ? true
      : y >= radius && y <= S - radius && x >= 0 && x <= S
  }

  return makePng(S, S, (x, y) => {
    if (!inShape(x, y)) return [0, 0, 0, 0]

    // 渐变底（135deg）
    const t = (x / S + y / S) / 2
    let color = [lerp(FROM[0], TO[0], t), lerp(FROM[1], TO[1], t), lerp(FROM[2], TO[2], t)]

    // 气泡主体：白色圆，稍微上移一点，下方留出"尾巴"感
    const bx = cx
    const by = cy - S * 0.02 * contentScale
    const dB = Math.hypot(x - bx, y - by)
    if (dB <= bubbleR) color = [255, 255, 255]

    // 气泡尾巴：右下方一个小圆角三角，用另一个圆近似
    const tailD = Math.hypot(x - (bx + bubbleR * 0.62), y - (by + bubbleR * 0.72))
    if (tailD <= bubbleR * 0.26) color = [255, 255, 255]

    // 三个点：挖空（填回渐变色）
    for (let i = -1; i <= 1; i++) {
      const dx2 = x - (cx + i * dotGap)
      const dy2 = y - by
      if (Math.hypot(dx2, dy2) <= dotR) {
        color = [lerp(FROM[0], TO[0], t), lerp(FROM[1], TO[1], t), lerp(FROM[2], TO[2], t)]
      }
    }

    return [color[0], color[1], color[2], 255]
  })
}

/* ---------- 输出 ---------- */
const targets = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-512-maskable.png', size: 512, maskable: true },
  { file: 'apple-touch-icon.png', size: 180, maskable: false }
]

for (const t of targets) {
  const png = drawIcon(t.size, { maskable: t.maskable })
  fs.writeFileSync(path.join(OUT, t.file), png)
  console.log(`生成 ${t.file}  ${t.size}x${t.size}  ${(png.length / 1024).toFixed(1)}KB`)
}
console.log('\n输出目录:', OUT)