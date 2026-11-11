/** Q 里一张「嘘」的脸 */
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

const S=512, cx=S/2, cy=S/2
const L=(a,b,t)=>Math.round(a+(b-a)*t)
const inRR=(x,y,hw,hh,r,ccx,ccy)=>{const dx=Math.abs(x-ccx)-(hw-r),dy=Math.abs(y-ccy)-(hh-r);if(dx<=0&&dy<=0)return true;const ax=Math.max(dx,0),ay=Math.max(dy,0);return ax*ax+ay*ay<=r*r}
const FROM=[0x5b,0x6e,0xf5], TO=[0x8b,0x5c,0xf6]
const grad=(x,y)=>{const t=(x/S+y/S)/2;return[L(FROM[0],TO[0],t),L(FROM[1],TO[1],t),L(FROM[2],TO[2],t)]}
const arc=(x,y,ax,ay,r,w,down)=>{const d=Math.hypot(x-ax,y-ay);if(Math.abs(d-r)>w/2)return false;return down?y>ay:y<ay}

function make(){
  const bg=(x,y)=>inRR(x,y,S/2,S/2,S*0.30,cx,cy)
  // Q 环
  const R=S*0.305, RW=S*0.080
  const inRing=(x,y)=>{const d=Math.hypot(x-cx,y-cy);return d<=R&&d>=R-RW}
  const inTail=(x,y)=>{
    const ang=Math.PI/4, R0=R*0.84
    const ex=cx+Math.cos(ang)*R0, ey=cy+Math.sin(ang)*R0
    const px=x-ex, py=y-ey
    const along=px*Math.cos(ang)+py*Math.sin(ang)
    const perp=-px*Math.sin(ang)+py*Math.cos(ang)
    return Math.abs(perp)<=RW/2 && along>=0 && along<=S*0.105
  }
  const innerR = R - RW        // 圈内可画区域半径

  // 眯眼：两道向上的小弧
  const eyeDX=S*0.082, eyeY=cy-S*0.062, eyeR=S*0.045, eyeW=S*0.026

  // 手指：竖直圆角条，在圈内偏下
  const fw=S*0.034, fTop=cy-S*0.010, fBot=cy+S*0.150, fr=S*0.034
  const inFinger=(x,y)=>{
    if(inRR(x,y,fw,(fBot-fTop)/2,fr,cx,(fTop+fBot)/2)) return true
    if(Math.hypot(x-cx,y-fTop)<=fw) return true
    return false
  }
  // 嘴：被手指挡着，两侧露一点小弧
  const mouthY=cy+S*0.072

  return png(S,S,(x,y)=>{
    if(!bg(x,y))return[0,0,0,0]
    const g=grad(x,y)
    const d=Math.hypot(x-cx,y-cy)

    // Q 环 + 尾巴（白色）
    if(inRing(x,y)||inTail(x,y)) return [255,255,255,255]

    // 圈外
    if(d>innerR) return [...g,255]

    // 圈内 = 脸：用白色画五官
    if(arc(x,y,cx-eyeDX,eyeY+eyeR*0.5,eyeR,eyeW,false)) return [255,255,255,255]
    if(arc(x,y,cx+eyeDX,eyeY+eyeR*0.5,eyeR,eyeW,false)) return [255,255,255,255]
    if(inFinger(x,y)) return [255,255,255,255]
    // 嘴角两侧
    if(arc(x,y,cx,mouthY-S*0.048,S*0.058,S*0.020,true) && Math.abs(x-cx)>S*0.062) return [255,255,255,255]

    return [...g,255]
  })
}

const buf=make()
fs.writeFileSync(path.join(OUT,'F1.png'),buf)
console.log('Q + 嘘 → F1.png', (buf.length/1024).toFixed(1)+'KB')

const html=`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Q + 嘘</title><style>
body{margin:0;background:#f7f7fa;font-family:-apple-system,"PingFang SC",sans-serif;padding:28px 16px}
h1{font-size:17px;text-align:center;margin:0 0 26px;color:#14161c;font-weight:600}
.wrap{max-width:340px;margin:0 auto;text-align:center}
.wrap img{width:200px;border-radius:48px;box-shadow:0 12px 32px rgba(16,20,32,.18);display:block;margin:0 auto}
.row{margin-top:22px;display:flex;align-items:center;justify-content:center;gap:12px}
.row img{width:48px;border-radius:12px;box-shadow:0 3px 10px rgba(16,20,32,.12);display:block}
.row img:nth-child(2){width:34px;border-radius:9px}
.row img:nth-child(3){width:24px;border-radius:7px}
p{font-size:13px;color:#5a6072;margin:18px 0 0;line-height:1.7}
</style></head><body>
<h1>Q 里的悄悄话</h1>
<div class="wrap">
  <img src="F1.png" alt="">
  <div class="row"><img src="F1.png" alt=""><img src="F1.png" alt=""><img src="F1.png" alt=""></div>
  <p>外面是 Q 的圈，圈里一张脸<br>眯着眼、竖着手指</p>
</div>
</body></html>`
fs.writeFileSync(path.join(OUT,'q-shh.html'),html)
console.log('对比页: /logo-test/q-shh.html')
