/**
 * 生成「悄悄」的正式 LOGO
 * 底：渐变圆角方形；内容：Noto Emoji 的 🤫（Apache 2.0）
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'public', 'icons')
const TMP = '/tmp/logo-shh'
fs.mkdirSync(OUT, { recursive: true })
fs.mkdirSync(TMP, { recursive: true })

// 1) 读官方 emoji SVG，只取里面的内容
const emojiSvg = fs.readFileSync('/tmp/shh.svg', 'utf8')
const inner = emojiSvg
  .replace(/<\?xml[^>]*\?>/g, '')
  .replace(/<svg[^>]*>/, '')
  .replace(/<\/svg>\s*$/, '')

function buildSvg(size, { maskable = false } = {}) {
  const pad = maskable ? 0.20 : 0.13      // 内容占比周边留白
  const innerSize = size * (1 - pad * 2)
  const offset = size * pad
  const scale = innerSize / 128            // emoji viewBox 是 128
  const rx = maskable ? 0 : size * 0.225
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5b6ef5"/>
      <stop offset="1" stop-color="#8b5cf6"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${size}" height="${size}" rx="${rx}" ry="${rx}" fill="url(#bg)"/>
  <g transform="translate(${offset},${offset}) scale(${scale})">
    ${inner}
  </g>
</svg>`
}

const targets = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-512-maskable.png', size: 512, maskable: true },
  { file: 'apple-touch-icon.png', size: 180, maskable: false }
]

for (const t of targets) {
  const svgPath = path.join(TMP, t.file.replace('.png', '.svg'))
  fs.writeFileSync(svgPath, buildSvg(t.size, { maskable: t.maskable }))
  const pngPath = path.join(OUT, t.file)
  execFileSync('rsvg-convert', ['-w', String(t.size), '-h', String(t.size), '-o', pngPath, svgPath], { stdio: 'inherit' })
  const sz = fs.statSync(pngPath).size
  console.log(`${t.file.padEnd(24)} ${t.size}x${t.size}  ${(sz / 1024).toFixed(1)}KB`)
}

// 顺便生成一张预览大图
const preview = path.join(TMP, 'preview.svg')
fs.writeFileSync(preview, buildSvg(512, {}))
execFileSync('rsvg-convert', ['-w', '512', '-h', '512', '-o', path.join(ROOT, 'public', 'logo-test', 'G1.png'), preview])
console.log('\n预览: /logo-test/G1.png')
