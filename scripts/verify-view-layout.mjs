// 静态检查 window-manager.ts 的视图布局约定：
// **每一次 addChildView 之后，都必须有一次布局调用（layoutViews / layout()）**。
//
// 为什么需要它：Electron 新建 View 的默认 bounds 是 {0,0,0,0}，只有 layoutViews()
// 里那两行 setBounds 会真正给视图尺寸。漏掉布局 = 视图零尺寸 = 页面照常加载完成、
// 日志一切正常，但一个像素都不画，表现为**纯白板**。而唯一会兜住它的是窗口 resize
// 事件，所以症状是「拖一下窗口大小，内容才突然出现」—— 很容易被当成偶发问题。
//
// 实测过的实例：loadRecoveryPage() 重建 contentView 后没补布局，恢复工具整页白板。
//
// 用法：node scripts/verify-view-layout.mjs
// 退出码 0 = 通过；1 = 有违反项。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const target = path.join(root, 'src', 'main', 'window-manager.ts');
const src = fs.readFileSync(target, 'utf8');
const lines = src.split(/\r?\n/);

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  ok ? pass++ : fail++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok || !detail ? '' : '\n        ' + detail));
};

// 布局调用：layoutViews() 是唯一的实现，create() 里的 `layout()` 是它的别名。
const LAYOUT = /\b(?:this\.)?(?:layoutViews\(\)|layout\(\))/;
// 一个方法体内的「addChildView → 布局」必须成对。这里按方法切段扫描：
// 以两空格缩进的成员方法为界（`  name(...) {`），足够覆盖本文件的写法。
const methodStarts = [];
for (let i = 0; i < lines.length; i++) {
  if (/^ {2}(?:private |public |protected )?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/.test(lines[i])) {
    methodStarts.push(i);
  }
}

/** 返回覆盖第 line 行的方法名与范围。 */
function methodAt(line) {
  let current = null;
  for (const start of methodStarts) {
    if (start > line) break;
    const m = /^ {2}(?:private |public |protected )?([A-Za-z_$][\w$]*)/.exec(lines[start]);
    current = { name: m ? m[1] : '?', start };
  }
  return current;
}

console.log('检查 ' + path.relative(root, target) + '\n');

// ── 1) 每个含 addChildView 的方法，之后都要有布局调用 ──
const offenders = [];
for (let i = 0; i < lines.length; i++) {
  if (!/addChildView\(/.test(lines[i])) continue;
  const owner = methodAt(i);
  const end = methodStarts.find((s) => s > (owner ? owner.start : 0)) ?? lines.length;
  const body = lines.slice(i + 1, end);
  const laid = body.some((l) => LAYOUT.test(l));
  check(
    `L${i + 1} addChildView 之后有布局（${owner ? owner.name + '()' : '?'}）`,
    laid,
    laid ? '' : '该方法在 addChildView 之后再没有 layoutViews()/layout()，视图会停在 {0,0,0,0}',
  );
  if (!laid) offenders.push(i + 1);
}

// ── 2) 布局实现本身仍要给两个视图都设 bounds ──
const layoutBody = (() => {
  const start = lines.findIndex((l) => /private layoutViews\(\)/.test(l));
  if (start < 0) return '';
  const end = methodStarts.find((s) => s > start) ?? lines.length;
  return lines.slice(start, end).join('\n');
})();
check('layoutViews() 存在', layoutBody !== '');
check('layoutViews() 给 titleBarView 设 bounds', /titleBarView\?\.setBounds\(/.test(layoutBody));
check('layoutViews() 给 contentView 设 bounds', /this\.contentView\?\.setBounds\(/.test(layoutBody));

// ── 3) 恢复页：重建 contentView 后必须布局（本次回归的正主）──
const recovery = (() => {
  const start = lines.findIndex((l) => /loadRecoveryPage\(\): void/.test(l));
  if (start < 0) return '';
  const end = methodStarts.find((s) => s > start) ?? lines.length;
  return lines.slice(start, end).join('\n');
})();
check('loadRecoveryPage() 存在', recovery !== '');
check('loadRecoveryPage() 重建视图后调用了布局', LAYOUT.test(recovery));
check(
  'loadRecoveryPage() 在 loadFile 之前布局',
  (() => {
    const li = recovery.indexOf('loadFile');
    const mi = recovery.search(LAYOUT);
    return li > 0 && mi > 0 && mi < li;
  })(),
);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
