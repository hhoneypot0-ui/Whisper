/** 「嘘」的手势 LOGO */
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

/**
 * @param invert false: 白脸+挖空五官   true: 渐变脸+白色五官
 */
function make({invert}){
  const faceR=S*0.315
  const bg=(x,y)=>inRR(x,y,S/2,S/2,S*0.30,cx,cy)

  // 眯眼（弯弯的 ⌒）
  const eyeDX=S*0.115, eyeY=cy-S*0.085, eyeR=S*0.052, eyeW=S*0.030
  // 手指：竖直圆角条，从鼻子下方一直伸到下巴下面
  const fw=S*0.052          // 半宽
  const fTop=cy+S*0.015     // 指尖（鼻子位置）
  const fBot=cy+S*0.265     // 手指下端
  const fr=S*0.052
  const inFinger=(x,y)=>{
    // 指身
    if(inRR(x,y,fw,(fBot-fTop)/2,fr,cx,(fTop+fBot)/2)) return true
    // 指尖圆头
    if(Math.hypot(x-cx,y-fTop)<=fw) return true
    return false
  }
  // 嘴（被手指挡住，只露一点点两侧）
  const mouthY=cy+S*0.115

  return png(S,S,(x,y)=>{
    if(!bg(x,y))return[0,0,0,0]
    const g=grad(x,y)
    const white=[255,255,255,255]
    const insideFace=Math.hypot(x-cx,y-cy)<=faceR

    if(!invert){
      // 白脸，五官用渐变「挖」出来
      if(!insideFace) return [...g,255]
      if(arc(x,y,cx-eyeDX,eyeY+eyeR*0.55,eyeR,eyeW,false)) return [...g,255]
      if(arc(x,y,cx+eyeDX,eyeY+eyeR*0.55,eyeR,eyeW,false)) return [...g,255]
      if(inFinger(x,y)) return [...g,255]
      // 嘴角两侧露一点
      if(arc(x,y,cx,mouthY-mouthY*0+S*0.055,S*0.062,S*0.024,true) && Math.abs(x-cx)>S*0.075) return [...g,255]
      return white
    }else{
      // 渐变脸，五官是白的
      if(!insideFace) return [...g,255]
      const face=grad(x,y)
      if(arc(x,y,cx-eyeDX,eyeY+eyeR*0.55,eyeR,eyeW,false)) return white
      if(arc(x,y,cx+eyeDX,eyeY+eyeR*0.55,eyeR,eyeW,false)) return white
      if(inFinger(x,y)) return white
      return [...face,255]
    }
  })
}

const variants=[
  ['E1','白脸 · 手指挖空', make({invert:false})],
  ['E2','渐变脸 · 白色手指', make({invert:true})]
]
for(const [k,label,buf] of variants){
  fs.writeFileSync(path.join(OUT,k+'.png'),buf)
  console.log(label,'→',k+'.png')
}

const html=`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>嘘</title><style>
body{margin:0;background:#f7f7fa;font-family:-apple-system,"PingFang SC",sans-serif;padding:24px 16px}
h1{font-size:17px;text-align:center;margin:0 0 24px;color:#14161c;font-weight:600}
.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:26px;max-width:480px;margin:0 auto}
.c{text-align:center}
.c img{width:100%;max-width:150px;border-radius:36px;box-shadow:0 10px 26px rgba(16,20,32,.16);display:block;margin:0 auto}
.c p{font-size:13px;color:#14161c;margin:11px 0 0;font-weight:500;line-height:1.4}
.c .row{margin-top:10px;display:flex;align-items:center;justify-content:center;gap:9px}
.c .row img{width:34px;border-radius:9px;box-shadow:none;display:block}
.c .row img:nth-child(2){width:22px;border-radius:6px}
</style></head><body>
<h1>嘘 🤫</h1>
<div class="g">
${variants.map(([k,label])=>`<div class="c"><img src="${k}.png" alt=""><p>${label}</p>
<div class="row"><img src="${k}.png" alt=""><img src="${k}.png" alt=""></div></div>`).join('')}
</div></body></html>`
fs.writeFileSync(path.join(OUT,'shh.html'),html)
console.log('\n对比页: /logo-test/shh.html')
