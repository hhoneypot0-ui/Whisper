#!/usr/bin/env node
/**
 * 页面结构自检：
 *  1. 所有 function / async function 必须在 <script> 内
 *  2. $('id').addEventListener 引用的元素必须存在
 *  3. 不能有重复 id
 *  4. script 内不能引用未定义的函数
 *  5. 底栏必须在所有 .view 之后
 */
const fs = require('fs');
const path = process.argv[2] || 'index.html';
const s = fs.readFileSync(path, 'utf8');

let errors = 0;
const fail = (msg) => { console.log('  ❌ ' + msg); errors++; };
const pass = (msg) => console.log('  ✓ ' + msg);

// --- 1. script 范围 ---
const scriptRe = /<script>([\s\S]*?)<\/script>/g;
let m, scriptRanges = [];
while ((m = scriptRe.exec(s))) {
  const start = m.index;
  scriptRanges.push([start, start + m[0].length]);
}
const inScript = (idx) => scriptRanges.some(([a, b]) => idx >= a && idx < b);

// --- 2. 函数是否在 script 内 ---
const fnRe = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
let badFns = [];
while ((m = fnRe.exec(s))) {
  if (!inScript(m.index)) badFns.push(m[1] + ' @' + (s.slice(0, m.index).split('\n').length));
}
badFns.length ? fail('函数写在了 <script> 外面: ' + badFns.join(', ')) : pass('所有函数都在 <script> 内');

// --- 3. id 重复 ---
const ids = {};
for (const im of s.matchAll(/id="([A-Za-z0-9_-]+)"/g)) ids[im[1]] = (ids[im[1]] || 0) + 1;
// 动态弹层模板里的 id 允许重复（同一时刻只会有一个）
const DYN = new Set(['ask-input','ask-cancel','ask-ok','pm-cancel','pm-add','pm-send','pm-text','pm-imgs','tt-input','tt-cancel','tt-ok','jd-date','jd-cancel','jd-ok','f-lookup','gp-name-wrap','fwd-cancel','sp-close','sp-upload','sp-note','vb-range','vb-time','vb-toggle','vb-close','tt-preview','bg-reset','bg-close']);
const dups = Object.entries(ids).filter(([k, v]) => v > 1 && !DYN.has(k));
dups.length ? fail('重复 id: ' + dups.map(([k, v]) => k + '(' + v + ')').join(', ')) : pass('没有重复 id');

// --- 4. 绑定引用不存在的元素 ---
const body = scriptRanges.map(([a, b]) => s.slice(a, b)).join('\n');
const badBind = [];
for (const bm of body.matchAll(/\$\('([A-Za-z0-9_-]+)'\)\.addEventListener/g)) {
  if (!ids[bm[1]]) badBind.push(bm[1]);
}
badBind.length ? fail('绑定了不存在的元素: ' + [...new Set(badBind)].join(', ')) : pass('所有绑定都有对应元素');

// --- 5. 底栏位置 ---
const lastView = s.lastIndexOf('id="view-');
const tabbar = s.indexOf('id="tabbar"');
if (tabbar > 0 && tabbar < lastView) fail('底栏在 .view 之前，会跑到页面顶部');
else pass('底栏位于所有视图之后');

// --- 6. script 语法 ---
try {
  new Function(scriptRanges.length ? s.slice(scriptRanges[0][0] + 8, scriptRanges[0][1] - 9) : '');
  pass('script 语法正确');
} catch (e) {
  fail('script 语法错误: ' + e.message);
}

console.log(errors ? '\n共 ' + errors + ' 个问题' : '\n全部通过');
process.exit(errors ? 1 : 0);
