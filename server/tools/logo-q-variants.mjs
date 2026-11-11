/** Q 字母标的三个改进版 */
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, '..', 'public', 'logo-test')
fs.mkdirSync(OUT, { recursive: true })

function crc32(b){let c,crc=0xffffffff;for(let i=0;i<b.length;i++){c=(crc^b[i])&0xff;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;crc=(crc>>>8)^c}return (crc^0xffffffff)>>>0}
function chunk(t,d){const l=Buffer.alloc(4);l.writeUInt32BE(d.length,0);const tb=Buffer.from(t,'ascii');const c=Buffer.alloc(4);c.writeUInt32BE(crc32(Buffer.concat([tb,d])),0);return Buffer.concat([l,tb,d,c])}
function png(w,h,fn){const raw=Buffer.alloc(h*(1+w*4));let o=0
  for(let y=0;y<h;y++){raw[o++]=0;for(let x=0;x<w;x++){const[r,g,b,a]=fn(x,y);raw[o++]=r;raw[o++]=g;raw[o++]=b;raw[o++]=a}}
  const ih=Buffer.alloc(13);ih.writeUInt32BE(w,0);ih.writeUInt32BE(h,4);ih[8]=8;ih[9]=6
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk('IHDR',ih),chunk('IDAT',zlib.deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))])}

const F=[0x5b,0x6e,0xf5], T=[0x8b,0x5c,0xf6], Wc=[255,255,255]
const L=(a,b,t)=>Math.round(a+(b-a)*t)
const S=512, cx=S/2, cy=S/2
const grad=(x,y)=>{const t=(x/S+y/S)/2;return[L(F[0],T[0],t),L(F[1],T[1],t),L(F[2],T[2],t)]}
const inRR=(x,y,hw,hh,r,ccx,ccy)=>{const dx=Math.abs(x-ccx)-(hw-r),dy=Math.abs(y-ccy)-(hh-r);if(dx<=0&&dy<=0)return true;const ax=Math.max(dx,0),ay=Math.max(dy,0);return ax*ax+ay*ay<=r*r}
const base=(x,y)=>inRR(x,y,S/2,S/2,S*0.225,cx,cy)

const R=S*0.28, RW=S*0.072
const inRing=(x,y,rr,w)=>{const d=Math.hypot(x-cx,y-cy);return d<=rr&&d>=rr-w}
function inTail(x,y){
  const ang=Math.PI/4, R0=R*0.82
  const ex=cx+Math.cos(ang)*R0, ey=cy+Math.sin(ang)*R0
  const px=x-ex, py=y-ey
  const along=px*Math.cos(ang)+py*Math.sin(ang)
  const perp=-px*Math.sin(ang)+py*Math.cos(ang)
  return Math.abs(perp)<=RW/2 && along>=0 && along<=S*0.10
}

// 变体 1：Q + 中心三个点（正在输入）
function q1(x,y){
  if(!base(x,y))return[0,0,0,0]
  const g=grad(x,y)
  if(inRing(x,y,R,RW)||inTail(x,y)) return [...Wc,255]
  const dotR=S*0.028, gap=S*0.062
  for(const dx of [-1,0,1]) if(Math.hypot(x-(cx+dx*gap),y-cy)<=dotR) return [...Wc,255]
  return [...g,255]
}

// 变体 2：白底 + 渐变 Q（反色）
function q2(x,y){
  if(!base(x,y))return[0,0,0,0]
  const g=grad(x,y)
  if(inRing(x,y,R,RW)||inTail(x,y)) return [...g,255]
  return [255,255,255,255]
}

// 变体 3：Q + 中心锁孔（呼应私密）
function q3(x,y){
  if(!base(x,y))return[0,0,0,0]
  const g=grad(x,y)
  if(inRing(x,y,R,RW)||inTail(x,y)) return [...Wc,255]
  // 锁孔：上方小圆 + 下方短锥
  if(Math.hypot(x-cx,y-(cy-S*0.028))<=S*0.030) return [...Wc,255]
  const kx=Math.abs(x-cx), ky=y-cy
  if(ky>=0 && ky<=S*0.055 && kx <= S*0.030*(1-ky/(S*0.055))) return [...Wc,255]
  return [...g,255]
}

// 变体 4：Q + 一圈渐变光晕（更有质感）
function q4(x,y){
  if(!base(x,y))return[0,0,0,0]
  const g=grad(x,y)
  const d=Math.hypot(x-cx,y-cy)
  // 外圈微光
  if(d>R+RW*0.6 && d<R+RW*1.25){
    const t=(d-(R+RW*0.6))/(RW*0.65)
    const a=Math.round(255*(1-t)*0.35)
    const bg=grad(x,y)
    return [L(bg[0],255,t*0.6),L(bg[1],255,t*0.6),L(bg[2],255,t*0.6),255]
  }
  if(inRing(x,y,R,RW)||inTail(x,y)) return [...Wc,255]
  return [...g,255]
}

const list=[['Q1','Q+三点',q1],['Q2','白底渐变Q',q2],['Q3','Q+锁孔',q3],['Q4','Q+光晕',q4]]
for(const [k,label,fn] of list){
  fs.writeFileSync(path.join(OUT,k+'.png'),png(S,S,fn))
  console.log(label,'→',k+'.png')
}

const html=`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Q 方案</title><style>
body{margin:0;background:#f4f5f8;font-family:-apple-system,"PingFang SC",sans-serif;padding:24px 16px}
h1{font-size:17px;text-align:center;margin:0 0 22px;color:#14161c;font-weight:600}
.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:22px;max-width:560px;margin:0 auto}
.c{text-align:center}
.c img{width:100%;max-width:140px;border-radius:30px;box-shadow:0 8px 24px rgba(16,20,32,.15);display:block;margin:0 auto}
.c p{font-size:13px;color:#14161c;margin:10px 0 0;font-weight:500}
.c .row{margin-top:9px;display:flex;align-items:center;justify-content:center;gap:8px}
.c .row img{width:30px;border-radius:8px;box-shadow:none;display:block}
.c .row img:nth-child(2){width:20px;border-radius:5px}
</style></head><body>
<h1>Q 的四个改进版</h1>
<div class="g">
${list.map(([k,label])=>`<div class="c"><img src="${k}.png" alt=""><p>${label}</p>
<div class="row"><img src="${k}.png" alt=""><img src="${k}.png" alt=""></div></div>`).join('')}
</div></body></html>`
fs.writeFileSync(path.join(OUT,'q.html'),html)
console.log('\n对比页: /logo-test/q.html')
