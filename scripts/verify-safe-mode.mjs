// 验证 safe-mode.ts 的 prepareBundles()：安全模式该剥离的剥离、该还原的还原，
// 而**正常启动永远不许拿备份去覆盖 profile**。
//
// 为什么需要它：备份曾经是「第一次见到就写死、之后永不更新」，正常启动却无条件
// 拿它覆盖 dsh.profile.bundles —— 于是插件市场（dshmarket）启用插件后，重启一次
// 就被抹掉一次（市场启用的方式正是往 bundles 里追加包名，而备份里没有它）。
// 实测日志：13:30:51 备份 2 项 → 13:33:07 已恢复原始 bundles（6 → 2 项）。
//
// 用法：node scripts/verify-safe-mode.mjs
// 前置：先 npm run build（读的是 out/main/safe-mode.js）
// 退出码 0 = 全部通过；1 = 有失败项。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const built = path.join(projectRoot, 'out', 'main');

if (!fs.existsSync(path.join(built, 'safe-mode.js'))) {
  console.log('  FAIL  找不到 out/main/safe-mode.js —— 先跑 npm run build');
  process.exit(1);
}

// 在临时目录里造一份隔离环境，把 safe-mode.js 的 ./paths 换成桩
// （原版 require('electron')，脱离 Electron 跑不起来）。
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-safemode-'));
const appData = path.join(root, 'appdata');
const dshHome = path.join(root, 'dsh-home');
fs.mkdirSync(path.join(dshHome, 'profiles', 'web'), { recursive: true });

process.env.DSH_SAFEMODE_TEST_APPDATA = appData;
process.env.DSH_SAFEMODE_TEST_HOME = dshHome;
process.env.DSH_DESKTOP_QUIET = '1'; // 桩 logger 不往控制台刷
fs.copyFileSync(path.join(built, 'logger.js'), path.join(root, 'logger.js'));
fs.copyFileSync(path.join(built, 'safe-mode.js'), path.join(root, 'safe-mode.js'));
fs.writeFileSync(
  path.join(root, 'paths.js'),
  'exports.userDataDir = () => process.env.DSH_SAFEMODE_TEST_APPDATA;\n' +
    'exports.dshHomeDir = () => process.env.DSH_SAFEMODE_TEST_HOME;\n',
);

const sm = require(path.join(root, 'safe-mode.js'));
const ENV = sm.SAFE_MODE_ENV;

const INBOX = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
const profileFile = path.join(dshHome, 'profiles', 'web', 'package.json');
const backupPath = path.join(appData, 'safe-bundles.json');

const readProfile = () => JSON.parse(fs.readFileSync(profileFile, 'utf8')).dsh.profile.bundles;
const writeProfile = (bundles) =>
  fs.writeFileSync(
    profileFile,
    JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles } } }, null, 2) + '\n',
  );
const readBackup = () => JSON.parse(fs.readFileSync(backupPath, 'utf8'));
const thirdParty = (bundles) => bundles.filter((b) => !INBOX.includes(b));

let pass = 0;
let fail = 0;
function check(label, actual, expect) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  const ok = a === e;
  ok ? pass++ : fail++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok ? '' : `\n        期望 ${e}\n        实际 ${a}`));
}
function section(t) {
  console.log(`\n── ${t}`);
}

try {
  // ── 1) 全新用户：备份建立成镜像，profile 不动 ──
  section('1) 全新用户，正常启动');
  writeProfile([...INBOX, 'dsh-context']);
  delete process.env[ENV];
  let r = sm.prepareBundles('web');
  check('profile 不被改动', readProfile(), [...INBOX, 'dsh-context']);
  check('备份是镜像（未带 stripped）', readBackup().stripped, false);
  check('返回值 = 当前', r.bundles, [...INBOX, 'dsh-context']);

  // ── 2) 核心回归：旧版遗留的 stale 备份不得覆盖 profile ──
  section('2) 旧版遗留备份（无 stripped 字段、只有内置两项）');
  writeProfile([...INBOX, 'dsh-context', 'dsh-workbuddy-xdpool']);
  fs.writeFileSync(
    backupPath,
    JSON.stringify({ version: 1, profile: 'web', bundles: INBOX, at: 1791207051980 }, null, 2) + '\n',
  );
  delete process.env[ENV];
  r = sm.prepareBundles('web');
  check('第三方 bundle 全部保留', thirdParty(readProfile()), ['dsh-context', 'dsh-workbuddy-xdpool']);
  check('备份刷新为当前这份', readBackup().bundles, [...INBOX, 'dsh-context', 'dsh-workbuddy-xdpool']);
  check('返回值不再是被抹掉的那份', r.bundles, [...INBOX, 'dsh-context', 'dsh-workbuddy-xdpool']);

  // ── 3) 之后每次新增插件都要活下来 ──
  section('3) 再新增插件后正常启动');
  writeProfile([...INBOX, 'dsh-context', 'dsh-workbuddy-xdpool', '@eghrhegpe/dsh-connect-qoder']);
  sm.prepareBundles('web');
  check('新增的保留', readProfile().includes('@eghrhegpe/dsh-connect-qoder'), true);
  check('第三方共 3 个', thirdParty(readProfile()).length, 3);

  // ── 4) 进安全模式：收敛 + 备份剥离前那份 ──
  section('4) 进入安全模式');
  process.env[ENV] = '1';
  r = sm.prepareBundles('web');
  check('profile 收敛为内置', readProfile(), INBOX);
  check('备份带 stripped 标记', readBackup().stripped, true);
  check('备份存的是剥离前那份', thirdParty(readBackup().bundles).length, 3);
  check('excluded 报告 3 个', r.excluded.length, 3);
  check('safe=true', r.safe, true);

  // ── 5) 安全模式中重复启动：不得把「只剩内置」当成原始值 ──
  section('5) 安全模式中重复启动');
  sm.prepareBundles('web');
  check('备份仍是剥离前那份', thirdParty(readBackup().bundles).length, 3);
  check('profile 仍是内置', readProfile(), INBOX);

  // ── 6) 退出安全模式：还原 + 清标记 ──
  section('6) 退出安全模式（还原）');
  delete process.env[ENV];
  sm.prepareBundles('web');
  check('第三方全部还原', thirdParty(readProfile()).length, 3);
  check('stripped 标记清除', readBackup().stripped, false);

  // ── 7) 还原后再启动：以当前为准，不重复回滚 ──
  section('7) 还原后再正常启动');
  writeProfile([...INBOX, 'dsh-context']);
  sm.prepareBundles('web');
  check('不回滚成 3 个', readProfile(), [...INBOX, 'dsh-context']);

  // ── 8) 安全模式下本就没有第三方：不该写空备份 ──
  section('8) 安全模式下 profile 本来就没有第三方');
  process.env[ENV] = '1';
  writeProfile(INBOX);
  fs.rmSync(backupPath, { force: true });
  sm.prepareBundles('web');
  check('不写备份', fs.existsSync(backupPath), false);
  delete process.env[ENV];

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);
