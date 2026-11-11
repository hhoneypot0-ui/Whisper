/** 三种"更治愈"的笑脸方案 */
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

// 弧线画法：以 (ax,ay) 为圆心、半径 r、线宽 w，取上半(up=true)或下半
const arc=(x,y,ax,ay,r,w,down)=>{
  const d=Math.hypot(x-ax,y-ay)
  if(Math.abs(d-r)>w/2) return false
  return down ? y>ay : y<ay
}

function make(style){
  const ringR=S*0.265, ringW=S*0.085
  const inBase=(x,y)=>inRR(x,y,S/2,S/2,S*0.30,cx,cy)
  const inRing=(x,y)=>{const d=Math.hypot(x-cx,y-cy);return d<=ringR&&d>=ringR-ringW}
  const inTail=(x,y)=>{
    const ang=Math.PI/4, R0=ringR*0.82
    const ex=cx+Math.cos(ang)*R0, ey=cy+Math.sin(ang)*R0
    const px=x-ex, py=y-ey
    const along=px*Math.cos(ang)+py*Math.sin(ang)
    const perp=-px*Math.sin(ang)+py*Math.cos(ang)
    return Math.abs(perp)<=ringW/2 && along>=0 && along<=S*0.10
  }
  const eyeX=S*0.058, eyeY=cy-S*0.048
  const mouthY=cy+S*0.028

  // 腮红（淡淡的圆）
  const blush=(x,y)=>{
    if(!style.blush) return 0
    for(const sx of [-1,1]){
      const d=Math.hypot(x-(cx+sx*S*0.115),y-(cy+S*0.012))
      if(d<=S*0.062) return Math.max(0,1-d/(S*0.062))*0.55
    }
    return 0
  }

  return png(S,S,(x,y)=>{
    if(!inBase(x,y))return[0,0,0,0]
    let g=grad(x,y)

    // 腮红：往白色方向混
    const bl=blush(x,y)
    if(bl>0){
      const t=bl*0.75
      g=[L(g[0],255,t),L(g[1],210,t),L(g[2],225,t)]
    }

    if(inRing(x,y)||inTail(x,y)) return [255,255,255,255]

    // 眼睛
    if(style.eyes==='arc'){
      // 弯弯的笑眼 ⌒
      if(arc(x,y,cx-eyeX,eyeY+S*0.018,S*0.036,S*0.026,false)) return [255,255,255,255]
      if(arc(x,y,cx+eyeX,eyeY+S*0.018,S*0.036,S*0.026,false)) return [255,255,255,255]
    }else{
      const eyeR=S*0.030
      if(Math.hypot(x-(cx-eyeX),y-eyeY)<=eyeR) return [255,255,255,255]
      if(Math.hypot(x-(cx+eyeX),y-eyeY)<=eyeR) return [255,255,255,255]
    }

    // 嘴巴：大一点的微笑弧
    if(arc(x,y,cx,mouthY-S*0.030,S*style.mouthR,S*style.mouthW,true)) return [255,255,255,255]
    return [...g,255]
  })
}

const variants=[
  ['D1','圆眼 + 大方微笑', make({eyes:'dot', mouthR:0.085, mouthW:0.030, blush:false})],
  ['D2','弯弯笑眼 + 微笑', make({eyes:'arc', mouthR:0.080, mouthW:0.028, blush:false})],
  ['D3','弯弯笑眼 + 腮红', make({eyes:'arc', mouthR:0.080, mouthW:0.028, blush:true})]
]
for(const [k,label,buf] of variants){
  fs.writeFileSync(path.join(OUT,k+'.png'),buf)
  console.log(label,'→',k+'.png')
}

const html=`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>笑脸方案</title><style>
body{margin:0;background:#f7f7fa;font-family:-apple-system,"PingFang SC",sans-serif;padding:24px 16px}
h1{font-size:17px;text-align:center;margin:0 0 24px;color:#14161c;font-weight:600}
.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:24px;max-width:560px;margin:0 auto}
.c{text-align:center}
.c img{width:100%;max-width:150px;border-radius:36px;box-shadow:0 10px 26px rgba(16,20,32,.16);display:block;margin:0 auto}
.c p{font-size:13px;color:#14161c;margin:11px 0 0;font-weight:500;line-height:1.4}
.c .row{margin-top:10px;display:flex;align-items:center;justify-content:center;gap:9px}
.c .row img{width:32px;border-radius:9px;box-shadow:none;display:block}
.c .row img:nth-child(2){width:20px;border-radius:6px}
</style></head><body>
<h1>哪种笑让你心里舒服</h1>
<div class="g">
${variants.map(([k,label])=>`<div class="c"><img src="${k}.png" alt=""><p>${label}</p>
<div class="row"><img src="${k}.png" alt=""><img src="${k}.png" alt=""></div></div>`).join('')}
</div></body></html>`
fs.writeFileSync(path.join(OUT,'smile.html'),html)
console.log('\n对比页: /logo-test/smile.html')
