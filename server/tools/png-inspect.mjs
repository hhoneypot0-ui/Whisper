/** 正确解码 PNG（含反滤波），用来检查图标 */
import fs from 'node:fs'
import zlib from 'node:zlib'

export function decodePng(file) {
  const b = fs.readFileSync(file)
  let p = 8, idat = [], w = 0, h = 0, depth = 0, ctype = 0
  while (p < b.length) {
    const len = b.readUInt32BE(p)
    const t = b.toString('ascii', p + 4, p + 8)
    const d = b.slice(p + 8, p + 8 + len)
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ctype = d[9] }
    if (t === 'IDAT') idat.push(d)
    p += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const ch = ctype === 6 ? 4 : ctype === 2 ? 3 : ctype === 0 ? 1 : 4
  const stride = w * ch
  const out = Buffer.alloc(h * stride)

  const paeth = (a, b2, c) => {
    const p2 = a + b2 - c
    const pa = Math.abs(p2 - a), pb = Math.abs(p2 - b2), pc = Math.abs(p2 - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b2 : c
  }

  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)]
    const src = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const cur = out.slice(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : null
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0
      const bb = prev ? prev[i] : 0
      const c = prev && i >= ch ? prev[i - ch] : 0
      let v = src[i]
      switch (ft) {
        case 0: break
        case 1: v = (v + a) & 0xff; break
        case 2: v = (v + bb) & 0xff; break
        case 3: v = (v + ((a + bb) >> 1)) & 0xff; break
        case 4: v = (v + paeth(a, bb, c)) & 0xff; break
      }
      cur[i] = v
    }
  }
  return {
    width: w, height: h, channels: ch,
    pixel(x, y) {
      const i = y * stride + x * ch
      return ch === 4 ? [out[i], out[i + 1], out[i + 2], out[i + 3]] : [out[i], out[i + 1], out[i + 2], 255]
    }
  }
}

// 命令行：node tools/png-inspect.mjs <file> [采样点...]
if (process.argv[1] && process.argv[1].endsWith('png-inspect.mjs')) {
  const img = decodePng(process.argv[2])
  console.log(`${process.argv[2]}  ${img.width}x${img.height}  ${img.channels}通道`)
  const W = img.width, H = img.height
  const pts = [
    ['左上角', 4, 4], ['顶部中间', Math.floor(W/2), 20],
    ['正中', Math.floor(W/2), Math.floor(H/2)],
    ['左侧 1/4', Math.floor(W*0.25), Math.floor(H*0.5)],
    ['右侧 1/4', Math.floor(W*0.75), Math.floor(H*0.5)],
    ['下方中间', Math.floor(W/2), Math.floor(H*0.8)],
    ['底部角', W-6, H-6]
  ]
  for (const [label, x, y] of pts) {
    const [r, g, bb, a] = img.pixel(x, y)
    console.log(`  ${label.padEnd(10)} (${x},${y})  rgba(${r},${g},${bb},${a})`)
  }
  // 统计非背景色像素（判断图形有没有画上去）
  let colored = 0, total = 0
  for (let y = 0; y < H; y += 4) for (let x = 0; x < W; x += 4) {
    total++
    const [r, g, bb, a] = img.pixel(x, y)
    if (a > 20 && !(Math.abs(r - 0x5b) < 30 && Math.abs(g - 0x6e) < 30 && Math.abs(bb - 0xf5) < 30)) colored++
  }
  console.log(`  非渐变底色像素占比: ${(colored / total * 100).toFixed(1)}%`)
}
