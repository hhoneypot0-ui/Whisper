/** 生成 3 个 LOGO 方案供挑选 */
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, '..', 'public', 'logo-test')
fs.mkdirSync(OUT, { recursive: true })

function crc32(b){let c,crc=0xffffffff;for(let i=0;i<b.length;i++){c=(crc^b[i])&0xff;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;crc=(crc>>>8)^c}return (crc^0xffffffff)>>>0}
function chunk(t,d){const l=Buffer.alloc(4);l.writeUInt32BE(d.length,0);const tb=Buffer.from(t,'ascii');const c=Buffer.alloc(4);c.writeUInt32BE(crc32(Buffer.concat([tb,d])),0);return Buffer.concat([l,tb,d,c])}
function png(w,h,fn){
  const raw=Buffer.alloc(h*(1+w*4));let o=0
  for(let y=0;y<h;y++){raw[o++]=0;for(let x=0;x<w;x++){const[r,g,b,a]=fn(x,y);raw[o++]=r;raw[o++]=g;raw[o++]=b;raw[o++]=a}}
  const ih=Buffer.alloc(13);ih.writeUInt32BE(w,0);ih.writeUInt32BE(h,4);ih[8]=8;ih[9]=6
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk('IHDR',ih),chunk('IDAT',zlib.deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))])
}
const F=[0x5b,0x6e,0xf5], T=[0x8b,0x5c,0xf6]
const L=(a,b,t)=>Math.round(a+(b-a)*t)
const S=512, cx=S/2, cy=S/2
const grad=(x,y)=>{const t=(x/S+y/S)/2;return[L(F[0],T[0],t),L(F[1],T[1],t),L(F[2],T[2],t)]}
const inRR=(x,y,hw,hh,r,ccx,ccy)=>{const dx=Math.abs(x-ccx)-(hw-r),dy=Math.abs(y-ccy)-(hh-r);if(dx<=0&&dy<=0)return true;const ax=Math.max(dx,0),ay=Math.max(dy,0);return ax*ax+ay*ay<=r*r}
const base=(x,y)=>inRR(x,y,S/2,S/2,S*0.225,cx,cy)

// A：字母 Q（白色圆环 + 尾巴）
function logoA(x,y){
  if(!base(x,y))return[0,0,0,0]
  const g=grad(x,y)
  const d=Math.hypot(x-cx,y-cy)
  const R=S*0.28, W=S*0.072
  if(d<=R && d>=R-W) return [255,255,255,255]
  // 尾巴：右下 45° 的圆头短条
  const ang=Math.PI/4
  const ex=cx+Math.cos(ang)*R*0.82, ey=cy+Math.sin(ang)*R*0.82
  const px=x-ex, py=y-ey
  const along=px*Math.cos(ang)+py*Math.sin(ang)
  const perp=-px*Math.sin(ang)+py*Math.cos(ang)
  if(Math.abs(perp)<=W/2 && along>=0 && along<=S*0.10) return [255,255,255,255]
  return [...g,255]
}

// B：两个重叠气泡
function logoB(x,y){
  if(!base(x,y))return[0,0,0,0]
  const g=grad(x,y)
  // 大的在左下
  const b1=inRR(x,y,S*0.20,S*0.145,S*0.062,cx-S*0.055,cy+S*0.06)
  // 小的在右上（带渐变描边感：先画渐变边再画白）
  const b2o=inRR(x,y,S*0.155,S*0.115,S*0.05,cx+S*0.075,cy-S*0.085)
  const b2i=inRR(x,y,S*0.155-S*0.028,S*0.115-S*0.028,S*0.04,cx+S*0.075,cy-S*0.085)
  if(b1) return [255,255,255,255]
  if(b2o) return b2i ? [...g,255] : [255,255,255,255]
  return [...g,255]
}

// C：极简气泡 + 三个点
function logoC(x,y){
  if(!base(x,y))return[0,0,0,0]
  const g=grad(x,y)
  const bw=S*0.30,bh=S*0.225,br=S*0.075
  const by=cy-S*0.02
  const tail=Math.hypot(x-(cx+bw*0.55),y-(by+bh*0.95))<=S*0.058
  if(inRR(x,y,bw,bh,br,cx,by)||tail){
    // 三个点
    const dotR=S*0.033
    for(const dx of [-1,0,1]){
      if(Math.hypot(x-(cx+dx*S*0.085),y-by)<=dotR) return [...g,255]
    }
    return [255,255,255,255]
  }
  return [...g,255]
}

const variants=[['A-字母Q',logoA],['B-双气泡',logoB],['C-极简气泡',logoC]]
for(const [name,fn] of variants){
  const file=path.join(OUT,name.split('-')[0]+'.png')
  fs.writeFileSync(file,png(S,S,fn))
  console.log(name, '→', path.basename(file), (fs.statSync(file).size/1024).toFixed(1)+'KB')
}

// 对比页
const html=`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LOGO 方案</title><style>
body{margin:0;background:#f4f5f8;font-family:-apple-system,"PingFang SC",sans-serif;padding:24px 16px}
h1{font-size:18px;text-align:center;margin:0 0 20px;color:#14161c}
.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:20px;max-width:520px;margin:0 auto}
.c{text-align:center}
.c img{width:100%;max-width:130px;border-radius:26px;box-shadow:0 6px 20px rgba(16,20,32,.14);display:block;margin:0 auto}
.c p{font-size:13px;color:#5a6072;margin:9px 0 0}
.c .s{margin-top:8px}
.c .s img{width:34px;border-radius:9px;box-shadow:none;display:inline-block;vertical-align:middle}
.c .s img+img{margin-left:6px}
</style></head><body>
<h1>选一个你喜欢的</h1>
<div class="g">
${variants.map(([n])=>`<div class="c"><img src="${n.split('-')[0]}.png" alt=""><p>${n.split('-')[1]}</p>
<div class="s"><img src="${n.split('-')[0]}.png" alt=""><img src="${n.split('-')[0]}.png" alt=""><img src="${n.split('-')[0]}.png" alt=""></div></div>`).join('')}
</div></body></html>`
fs.writeFileSync(path.join(OUT,'index.html'),html)
console.log('\n对比页: /logo-test/')
