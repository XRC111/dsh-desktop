// 验证 hot-shell.ts 与 updater.ts 两份编译后的 compareVersions 都具备 w7 归一化，
// 并模拟新老客户端对 feed 的 pickHot 决策（老客户端 = w7 安装包内的旧逻辑）。
import fs from 'node:fs';

function grab(src, start) {
  const i = src.indexOf(start);
  if (i < 0) throw new Error('找不到 ' + start);
  let depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return src.slice(i, j);
}

let pass = 0, fail = 0;
function check(label, actual, expect) {
  const ok = actual === expect;
  ok ? pass++ : fail++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + label + ' → ' + actual + (ok ? '' : '（期望 ' + expect + '）'));
}

// ── 1) 编译产物里的 compareVersions ──
const cmp = {};
for (const f of ['out/main/hot-shell.js', 'out/main/updater.js']) {
  const src = fs.readFileSync(f, 'utf8');
  const code = grab(src, 'function parseVersion') + '\n' + grab(src, 'function compareVersions');
  cmp[f] = new Function(code + '; return {compareVersions};')().compareVersions;
  console.log('=== ' + f + ' ===');
  const c = cmp[f];
  check("('1.1.14','1.1.14-w7')", c('1.1.14', '1.1.14-w7'), 0);
  check("('1.1.14-w7','1.1.14')", c('1.1.14-w7', '1.1.14'), 0);
  check("('1.1.16','1.1.14-w7')", c('1.1.16', '1.1.14-w7'), 1);
  check("('1.1.14-w7','1.1.1')", c('1.1.14-w7', '1.1.1'), 1);
  check("('1.1.15-rc.1','1.1.14')", c('1.1.15-rc.1', '1.1.14'), 1);
  check("('1.1.14','1.1.15-rc.1')", c('1.1.14', '1.1.15-rc.1'), -1);
}

// ── 2) 老客户端（w7 安装包里的旧代码）pickHot 决策模拟 ──
// 逐字对照 build/old-w7-asar/out/main/updater.js 反编译出的旧逻辑：
// 旧 parseVersion 无 w7 归一化；pickHot = floor 筛选 + 仅按 version 降序（稳定排序）。
function oldParseVersion(v) {
  const [core, ...rest] = String(v).trim().replace(/^v/i, '').split('-');
  const nums = core.split('.').map((s) => {
    const n = parseInt(s.replace(/[^0-9]/g, ''), 10);
    return Number.isFinite(n) ? n : 0;
  });
  const pre = rest.join('-').split('.').filter(Boolean);
  return { nums, pre };
}
function oldCompare(a, b) {
  const va = oldParseVersion(a), vb = oldParseVersion(b);
  const len = Math.max(va.nums.length, vb.nums.length);
  for (let i = 0; i < len; i++) {
    const x = va.nums[i] ?? 0, y = vb.nums[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  if (va.pre.length === 0 && vb.pre.length > 0) return 1;
  if (va.pre.length > 0 && vb.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(va.pre.length, vb.pre.length); i++) {
    const x = va.pre[i], y = vb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}
const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);
function oldPickHot(feed, installed) {
  const all = asArray(feed.hot).filter((h) => h?.url && h?.version);
  const usable = all.filter((h) => !h.baseVersion || oldCompare(installed, h.baseVersion) >= 0);
  usable.sort((a, b) => oldCompare(b.version, a.version));
  return usable[0] ?? null;
}
// 新客户端（1.1.15+）pickHot：同结构，但 compareVersions 带 w7 归一化
function newPickHot(feed, installed) {
  const c = cmp['out/main/updater.js'];
  const all = asArray(feed.hot).filter((h) => h?.url && h?.version);
  const usable = all.filter((h) => !h.baseVersion || c(installed, h.baseVersion) >= 0);
  usable.sort((a, b) => c(b.version, a.version));
  return usable[0] ?? null;
}

const feed = JSON.parse(fs.readFileSync('dist/update/latest.json', 'utf8'));
const hotArr = asArray(feed.hot);
console.log('\n=== feed.hot 通道（' + hotArr.length + ' 档） ===');
for (const h of hotArr) console.log('  ' + h.version + '（基线 ' + h.baseVersion + '）← ' + (h.url.split('/').pop()));

console.log('\n=== 老客户端 pickHot 决策（各安装版） ===');
const cases = [
  ['1.1.14-w7', '1.1.14-w7'],  // w7 特供包 → 必须选中基线 1.1.14-w7 的桥接包
  ['1.1.13', '1.1.13'],        // 1.1.13 安装包 → 必须选中基线 1.1.13 的桥接包
  ['1.1.1', '1.1.1'],          // 热更链老机器 → 选中主线包
];
for (const [installed, wantBase] of cases) {
  const pick = oldPickHot(feed, installed);
  const ok = pick && pick.baseVersion === wantBase;
  ok ? pass++ : fail++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + '安装版 ' + installed + ' → 选中 ' +
    (pick ? pick.version + '（基线 ' + pick.baseVersion + '）' : '无') +
    (ok ? '' : '（期望基线 ' + wantBase + '）'));
  // 老客户端 installHotShell / resolveHotShell 的严格相等校验
  const strictOk = pick && pick.baseVersion === installed;
  strictOk ? pass++ : fail++;
  console.log((strictOk ? '  ✓ ' : '  ✗ ') + '  老客户端严等校验：包基线 ' + (pick && pick.baseVersion) +
    (strictOk ? ' === ' : ' !== ') + '安装版 ' + installed);
}

console.log('\n=== 新客户端（1.1.15/1.1.16 外壳）pickHot 决策 ===');
{
  const pick = newPickHot(feed, '1.1.1');
  const ok = pick && pick.baseVersion === '1.1.1';
  ok ? pass++ : fail++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + "安装版 '1.1.1' → " + (pick ? '基线 ' + pick.baseVersion : '无') + '（期望主线 1.1.1）');
  const pick2 = newPickHot(feed, '1.1.14-w7');
  const ok2 = pick2 && pick2.baseVersion === '1.1.14-w7';
  ok2 ? pass++ : fail++;
  console.log((ok2 ? '  ✓ ' : '  ✗ ') + "安装版 '1.1.14-w7' → " + (pick2 ? '基线 ' + pick2.baseVersion : '无') + '（floor 语义下选基线最高的可用档）');
}

// ── 3) 新 installHotShell 的 floor 语义（用编译后的 compareVersions 驱动） ──
console.log('\n=== 新基线校验语义（安装版 vs 包基线 → 放行/拒绝） ===');
const cHS = cmp['out/main/hot-shell.js'];
const floorCases = [
  ['1.1.14-w7', '1.1.1', true],   // w7 安装版 ≥ 主线基线 → 放行
  ['1.1.16', '1.1.1', true],      // 未来全新安装 → 放行
  ['1.1.0', '1.1.1', false],      // 低于基线 → 拒绝（走安装包）
];
for (const [builtin, base, allow] of floorCases) {
  const would = cHS(builtin, base) < 0 ? '拒绝' : '放行';
  const ok = (would === '放行') === allow;
  ok ? pass++ : fail++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + '安装版 ' + builtin + ' vs 基线 ' + base + ' → ' + would);
}

console.log('\n结果：' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
