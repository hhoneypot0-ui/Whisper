/** 可爱风格 LOGO 三个方案 */
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

// 三套配色
const PALETTES={
  A:[[0x5b,0x6e,0xf5],[0x8b,0x5c,0xf6]],   // 原紫蓝
  B:[[0xff,0x7e,0xb3],[0xa7,0x8b,0xfa]],   // 粉紫
  C:[[0xff,0x9a,0x8b],[0xff,0x6b,0x9d]]    // 暖橙粉
}

function make({from,to,withFace,rounder}){
  const grad=(x,y)=>{const t=(x/S+y/S)/2;return[L(from[0],to[0],t),L(from[1],to[1],t),L(from[2],to[2],t)]}
  const base=(x,y)=>inRR(x,y,S/2,S/2,S*(rounder?0.30:0.225),cx,cy)

  const ringR=withFace?S*0.265:S*0.28
  const ringW=withFace?S*0.085:S*0.072
  const inRing=(x,y)=>{const d=Math.hypot(x-cx,y-cy);return d<=ringR&&d>=ringR-ringW}
  const inTail=(x,y)=>{
    const ang=Math.PI/4, R0=ringR*0.82
    const ex=cx+Math.cos(ang)*R0, ey=cy+Math.sin(ang)*R0
    const px=x-ex, py=y-ey
    const along=px*Math.cos(ang)+py*Math.sin(ang)
    const perp=-px*Math.sin(ang)+py*Math.cos(ang)
    return Math.abs(perp)<=ringW/2 && along>=0 && along<=S*0.10
  }
  // 眼睛与微笑
  const eyeY=cy-S*0.035, eyeX=S*0.052, eyeR=S*0.026
  const mouthCy=cy+S*0.005, mouthR=S*0.062, mouthW=S*0.018
  const inEye=(x,y)=>Math.hypot(x-(cx-eyeX),y-eyeY)<=eyeR || Math.hypot(x-(cx+eyeX),y-eyeY)<=eyeR
  const inMouth=(x,y)=>{
    const d=Math.hypot(x-cx,y-mouthCy)
    return y>mouthCy && Math.abs(d-mouthR)<=mouthW/2 && Math.abs(x-cx)<=S*0.055
  }

  return png(S,S,(x,y)=>{
    if(!base(x,y))return[0,0,0,0]
    const g=grad(x,y)
    if(inRing(x,y)||inTail(x,y)) return [255,255,255,255]
    if(withFace && (inEye(x,y)||inMouth(x,y))) return [255,255,255,255]
    return [...g,255]
  })
}

const variants=[
  ['C1','紫蓝·笑脸',make({from:PALETTES.A[0],to:PALETTES.A[1],withFace:true,rounder:true})],
  ['C2','粉紫·笑脸',make({from:PALETTES.B[0],to:PALETTES.B[1],withFace:true,rounder:true})],
  ['C3','橙粉·笑脸',make({from:PALETTES.C[0],to:PALETTES.C[1],withFace:true,rounder:true})]
]
for(const [k,label,buf] of variants){
  fs.writeFileSync(path.join(OUT,k+'.png'),buf)
  console.log(label,'→',k+'.png')
}

const html=`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>可爱版</title><style>
body{margin:0;background:#f7f7fa;font-family:-apple-system,"PingFang SC",sans-serif;padding:24px 16px}
h1{font-size:17px;text-align:center;margin:0 0 24px;color:#14161c;font-weight:600}
.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:24px;max-width:560px;margin:0 auto}
.c{text-align:center}
.c img{width:100%;max-width:150px;border-radius:36px;box-shadow:0 10px 26px rgba(16,20,32,.16);display:block;margin:0 auto}
.c p{font-size:13px;color:#14161c;margin:11px 0 0;font-weight:500}
.c .row{margin-top:10px;display:flex;align-items:center;justify-content:center;gap:9px}
.c .row img{width:32px;border-radius:9px;box-shadow:none;display:block}
.c .row img:nth-child(2){width:20px;border-radius:6px}
</style></head><body>
<h1>可爱版</h1>
<div class="g">
${variants.map(([k,label])=>`<div class="c"><img src="${k}.png" alt=""><p>${label}</p>
<div class="row"><img src="${k}.png" alt=""><img src="${k}.png" alt=""></div></div>`).join('')}
</div></body></html>`
fs.writeFileSync(path.join(OUT,'cute.html'),html)
console.log('\n对比页: /logo-test/cute.html')
