#!/usr/bin/env node
/**
 * 自动把误写在 <script> 外面的函数搬回 <script> 里。
 * 用法：node tools/fix-functions.cjs public/index.html
 */
const fs = require('fs');
const path = process.argv[2] || 'public/index.html';
let s = fs.readFileSync(path, 'utf8');

// script 范围
const ranges = [];
for (const m of s.matchAll(/<script>[\s\S]*?<\/script>/g)) {
  ranges.push([m.index, m.index + m[0].length]);
}
const inScript = (i) => ranges.some(([a, b]) => i >= a && i < b);

// 找出 script 外的函数块（从 function 开头，到下一个顶层 } 结束）
const lines = s.split('\n');
let moveBlocks = [];
let i = 0;
while (i < lines.length) {
  const line = lines[i];
  if (/^(?:async\s+)?function\s+[A-Za-z_$]/.test(line)) {
    // 计算该行在文件里的位置
    const pos = lines.slice(0, i).join('\n').length;
    if (!inScript(pos)) {
      // 找到匹配的结束 }
      let depth = 0, j = i, started = false, endJ = -1;
      for (; j < lines.length; j++) {
        for (const ch of lines[j]) {
          if (ch === '{') { depth++; started = true; }
          else if (ch === '}') { depth--; }
        }
        if (started && depth === 0) { endJ = j; break; }
      }
      if (endJ > 0) {
        moveBlocks.push({ from: i, to: endJ, code: lines.slice(i, endJ + 1).join('\n') });
        i = endJ + 1;
        continue;
      }
    }
  }
  i++;
}

if (!moveBlocks.length) {
  console.log('✓ 没有需要搬动的函数');
  process.exit(0);
}

console.log('发现 ' + moveBlocks.length + ' 个写错位置的函数：');
for (const b of moveBlocks) console.log('  - ' + b.code.split('\n')[0].trim());

// 删除原位置（从后往前删，避免行号错乱）
const delLines = s.split('\n');
for (const b of [...moveBlocks].sort((x, y) => y.from - x.from)) {
  delLines.splice(b.from, b.to - b.from + 1);
}
s = delLines.join('\n');

// 插入到 script 内（找一个已存在的锚点函数）
const anchor = 'function renderChatHeader(){';
const anchorIdx = s.indexOf(anchor);
if (anchorIdx < 0) {
  console.log('✗ 找不到插入锚点 function renderChatHeader');
  process.exit(1);
}
const insert = moveBlocks.map((b) => b.code).join('\n\n') + '\n\n';
s = s.slice(0, anchorIdx) + insert + s.slice(anchorIdx);

fs.writeFileSync(path, s);
console.log('\n✓ 已搬回 <script> 内');
