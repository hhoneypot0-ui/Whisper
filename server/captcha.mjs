/**
 * 图形验证码（纯 SVG 生成，无第三方依赖）
 *
 * 为什么不用短信验证码：需要运营商通道、企业实名、模板审核、按条计费，
 * 几个人自用不值得。图形验证码能挡住脚本批量注册，成本为零。
 *
 * 验证码存在内存里（重启失效），5 分钟过期，一次性使用。
 */
import { randomBytes } from 'node:crypto'

const store = new Map() // id -> { code, expires }
const TTL = 5 * 60 * 1000
const CHARS = '2345678abcdefghjkmnpqrstuvwxyz' // 去掉容易看错的 0o1il

function rand(n) {
  return Math.floor(Math.random() * n)
}
function pick(str) {
  return str[rand(str.length)]
}

function svgFor(code) {
  const W = 120
  const H = 44
  const parts = []
  // 背景
  parts.push(`<rect width="${W}" height="${H}" rx="8" fill="#f2f4f8"/>`)
  // 干扰线
  for (let i = 0; i < 4; i++) {
    const c = `hsl(${rand(360)} 60% 78%)`
    parts.push(
      `<path d="M${rand(W)} ${rand(H)} Q${rand(W)} ${rand(H)} ${rand(W)} ${rand(H)}" stroke="${c}" stroke-width="1.4" fill="none"/>`
    )
  }
  // 字符
  const step = W / (code.length + 1)
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]
    const x = step * (i + 1)
    const y = H / 2 + 8 + rand(5) - 2
    const rot = rand(36) - 18
    const hue = rand(360)
    parts.push(
      `<text x="${x}" y="${y}" font-family="Georgia,serif" font-size="24" font-weight="700" ` +
        `fill="hsl(${hue} 62% 42%)" text-anchor="middle" ` +
        `transform="rotate(${rot} ${x} ${y})">${ch}</text>`
    )
  }
  // 噪点
  for (let i = 0; i < 18; i++) {
    parts.push(`<circle cx="${rand(W)}" cy="${rand(H)}" r="1" fill="hsl(${rand(360)} 50% 70%)"/>`)
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`
}

export function createCaptcha() {
  const code = Array.from({ length: 4 }, () => pick(CHARS)).join('')
  const id = randomBytes(9).toString('hex')
  store.set(id, { code, expires: Date.now() + TTL })
  // 顺便清理过期的
  if (store.size > 500) {
    const now = Date.now()
    for (const [k, v] of store) if (v.expires < now) store.delete(k)
  }
  return { id, svg: svgFor(code) }
}

/** 校验并作废（一次性） */
export function verifyCaptcha(id, input) {
  if (!id || !input) return false
  const rec = store.get(id)
  if (!rec) return false
  store.delete(id)
  if (rec.expires < Date.now()) return false
  return rec.code.toLowerCase() === String(input).trim().toLowerCase()
}
