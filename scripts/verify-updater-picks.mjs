// 验证 updater.ts 的两条判定：
//   1) pickPlugins —— 本地插件版本比 feed 新时**不得**被降级回去
//   2) available    —— 热更包算作可用通道（不依赖云端 version 是否更高）
//
// 两个都是实测踩到的 bug：
//   · computer-use：内置源 1.0.2 被 plugin-installer 按「版本高的赢」落位，而 feed
//     还是上次发版的 1.0.1 → pickPlugins 只判全等 → 每次检查都排队装 1.0.1 →
//     装完下次启动又被内置源顶回 1.0.2 → 无限拉锯，表现是「外壳一直弹 1.0.1 更新」。
//   · 热更：当前安装版 10.3.13 > dev feed 10.3.11（shellOutdated=false）、dev feed
//     无 runtime 块、无新插件 → available=false → 直接返回「已是最新」，而同一份
//     日志里 pickHot 明明已经打出「可用热更新」。热更包发了却永远不下载。
//
// 做法：从编译产物里抽出这两个判定的**纯逻辑**来跑（它们都嵌在 class 里，
// 依赖 electron / 网络，直接实例化跑不起来）。
//
// 用法：node scripts/verify-updater-picks.mjs
// 前置：先 npm run build
// 退出码 0 = 全部通过；1 = 有失败项。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const built = path.join(root, 'out', 'main', 'updater.js');

if (!fs.existsSync(built)) {
  console.log('  FAIL  找不到 out/main/updater.js —— 先跑 npm run build');
  process.exit(1);
}
const src = fs.readFileSync(built, 'utf8');

let pass = 0;
let fail = 0;
function check(label, actual, expect) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  const ok = a === e;
  ok ? pass++ : fail++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok ? '' : `\n        期望 ${e}\n        实际 ${a}`));
}
const section = (t) => console.log(`\n── ${t}`);

// ── 抽出 compareVersions（pickPlugins 的新判定要用它）────────────────────────
function grab(startMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error('找不到 ' + startMarker);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  throw new Error('括号不平衡：' + startMarker);
}

const cmpCode = grab('function compareVersions');
// compareVersions 依赖 parseVersion（比较前先归一化版本串），两个都要抽出来。
const parseCode = grab('function parseVersion');
const compareVersions = new Function(`${parseCode}\n${cmpCode}; return compareVersions;`)();

// ── 1) compareVersions 本身（插件版本比较依赖它）────────────────────────────
section('1) compareVersions 基本语义');
check("('1.0.2','1.0.1')", compareVersions('1.0.2', '1.0.1'), 1);
check("('1.0.1','1.0.2')", compareVersions('1.0.1', '1.0.2'), -1);
check("('1.0.1','1.0.1')", compareVersions('1.0.1', '1.0.1'), 0);
check("('10.3.13','10.3.11')", compareVersions('10.3.13', '10.3.11'), 1);

// ── 2) pickPlugins 的判定：把源码里的分支逻辑原样复刻出来跑 ──────────────────
// 直接镜像 out/main/updater.js 里那段（读 landed → 比较 → 决定是否排队）。
section('2) pickPlugins：本地 vs feed 的版本判定');
{
  // 断言源码里确实用的是「大于才跳过」而不是「全等才跳过」
  check(
    '源码含 compareVersions(have, ...) > 0 的保留分支',
    /compareVersions\(have,\s*String\(expectedVersion\)\)\s*>\s*0/.test(src),
    true,
  );
  check('源码不再用全等判定决定跳过', /if \(String\(pkg\.version\) === String\(expectedVersion\)\)/.test(src), false);
  check(
    '保留分支带日志（本地更新时说明原因，便于排查拉锯）',
    /比 feed 的 \$\{expectedVersion\} 新，保留本地/.test(src),
    true,
  );
}

// 复刻判定（与源码同构），跑真实场景
function decide(have, expected) {
  if (have === expected) return 'skip-equal';
  if (compareVersions(have, expected) > 0) return 'skip-newer';
  return 'install';
}
section('3) 真实场景');
check('computer-use: 本地 1.0.2 / feed 1.0.1 → 保留本地', decide('1.0.2', '1.0.1'), 'skip-newer');
check('常规升级: 本地 1.0.1 / feed 1.0.2 → 安装', decide('1.0.1', '1.0.2'), 'install');
check('版本一致: 1.0.1 / 1.0.1 → 跳过', decide('1.0.1', '1.0.1'), 'skip-equal');
check('directory-picker: 本地 1.0.2 / feed 1.0.2 → 跳过', decide('1.0.2', '1.0.2'), 'skip-equal');

// ── 4) available：热更必须是独立通道 ────────────────────────────────────────
section('4) available 判定含 hot');
check(
  '源码 available 含 !!hot',
  /const available = shellOutdated \|\| !!hot \|\| !!rt \|\| hasPlugins/.test(src),
  true,
);
{
  // 复刻 available，跑用户的实际情形
  const available = ({ shellOutdated, hot, rt, hasPlugins }) =>
    shellOutdated || !!hot || !!rt || hasPlugins;

  check(
    '实测场景: 当前 10.3.13 > dev feed 10.3.11，无 rt/插件，但有热更包 → 可用',
    available({ shellOutdated: false, hot: { version: '10.3.11' }, rt: null, hasPlugins: false }),
    true,
  );
  check(
    '对照组（修复前）: 同样条件但漏掉 hot → 判为不可用',
    available({ shellOutdated: false, hot: null, rt: null, hasPlugins: false }),
    false,
  );
  check(
    '正常前向更新: 云端更高 → 可用',
    available({ shellOutdated: true, hot: null, rt: null, hasPlugins: false }),
    true,
  );
  check(
    '仅运行时补丁 → 可用',
    available({ shellOutdated: false, hot: null, rt: { version: '0.1.7-rc.2' }, hasPlugins: false }),
    true,
  );
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
