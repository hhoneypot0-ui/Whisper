/**
 * 「悄悄」的正式 LOGO —— 字母 Q + 三个点
 * 纯 Node 手写 PNG，无第三方依赖
 */
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, '..', 'public', 'icons')
fs.mkdirSync(OUT, { recursive: true })

function crc32(b){let c,crc=0xffffffff;for(let i=0;i<b.length;i++){c=(crc^b[i])&0xff;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;crc=(crc>>>8)^c}return (crc^0xffffffff)>>>0}
function chunk(t,d){const l=Buffer.alloc(4);l.writeUInt32BE(d.length,0);const tb=Buffer.from(t,'ascii');const c=Buffer.alloc(4);c.writeUInt32BE(crc32(Buffer.concat([tb,d])),0);return Buffer.concat([l,tb,d,c])}
function png(w,h,fn){
  const raw=Buffer.alloc(h*(1+w*4));let o=0
  for(let y=0;y<h;y++){raw[o++]=0;for(let x=0;x<w;x++){const[r,g,b,a]=fn(x,y);raw[o++]=r;raw[o++]=g;raw[o++]=b;raw[o++]=a}}
  const ih=Buffer.alloc(13);ih.writeUInt32BE(w,0);ih.writeUInt32BE(h,4);ih[8]=8;ih[9]=6
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk('IHDR',ih),chunk('IDAT',zlib.deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))])
}

const F=[0x5b,0x6e,0xf5], T=[0x8b,0x5c,0xf6], Wc=[255,255,255]
const L=(a,b,t)=>Math.round(a+(b-a)*t)

function draw(S,{maskable=false}={}){
  const cx=S/2, cy=S/2
  const rd = maskable ? 0 : S*0.225
  const k  = maskable ? 0.78 : 1
  const grad=(x,y)=>{const t=(x/S+y/S)/2;return[L(F[0],T[0],t),L(F[1],T[1],t),L(F[2],T[2],t)]}
  const inRR=(x,y,hw,hh,r,ccx,ccy)=>{const dx=Math.abs(x-ccx)-(hw-r),dy=Math.abs(y-ccy)-(hh-r);if(dx<=0&&dy<=0)return true;const ax=Math.max(dx,0),ay=Math.max(dy,0);return ax*ax+ay*ay<=r*r}
  const base=(x,y)=> maskable ? true : inRR(x,y,S/2,S/2,rd,cx,cy)

  const R = S*0.28*k, RW = S*0.072*k
  const inRing=(x,y)=>{const d=Math.hypot(x-cx,y-cy);return d<=R&&d>=R-RW}
  const inTail=(x,y)=>{
    const ang=Math.PI/4, R0=R*0.82
    const ex=cx+Math.cos(ang)*R0, ey=cy+Math.sin(ang)*R0
    const px=x-ex, py=y-ey
    const along=px*Math.cos(ang)+py*Math.sin(ang)
    const perp=-px*Math.sin(ang)+py*Math.cos(ang)
    return Math.abs(perp)<=RW/2 && along>=0 && along<=S*0.10*k
  }
  const dotR = S*0.028*k, gap = S*0.062*k

  return png(S,S,(x,y)=>{
    if(!base(x,y)) return [0,0,0,0]
    const g=grad(x,y)
    if(inRing(x,y)||inTail(x,y)) return [...Wc,255]
    for(const dx of [-1,0,1]) if(Math.hypot(x-(cx+dx*gap),y-cy)<=dotR) return [...Wc,255]
    return [...g,255]
  })
}

for(const t of [
  {file:'icon-192.png',size:192,maskable:false},
  {file:'icon-512.png',size:512,maskable:false},
  {file:'icon-512-maskable.png',size:512,maskable:true},
  {file:'apple-touch-icon.png',size:180,maskable:false}
]){
  const buf=draw(t.size,{maskable:t.maskable})
  fs.writeFileSync(path.join(OUT,t.file),buf)
  console.log(t.file.padEnd(24), t.size+'x'+t.size, (buf.length/1024).toFixed(1)+'KB')
}
