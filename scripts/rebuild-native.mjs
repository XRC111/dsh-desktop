// 原生模块 ABI 处理
//
// 背景：Electron 的 Node ABI 与标准 Node.js 不同，早年间必须为 Electron 重编译原生模块。
// 实测结论（dsh 0.1.5-rc.1 / Electron 44，ABI 149）：
//   node-pty (N-API 预编译) / koffi / sharp / node-addon-require-builtin 均可直接加载，
//   因此默认不重编译。仅当探测失败时才自动调用 @electron/rebuild。
//
// 用法：
//   node scripts/rebuild-native.mjs          探测，仅在失败时重建
//   node scripts/rebuild-native.mjs --force  无条件重建
//   node scripts/rebuild-native.mjs --check  只探测不重建
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = path.join(root, 'resources', 'dsh-runtime');
const force = process.argv.includes('--force');
const checkOnly = process.argv.includes('--check');

if (!fs.existsSync(runtimeDir)) {
  console.error('[rebuild-native] 未找到 resources/dsh-runtime，请先 npm run prepare:runtime');
  process.exit(1);
}

const electronExe = require('electron');
const electronVersion = JSON.parse(
  fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8'),
).version;

function probe() {
  const res = spawnSync(
    electronExe,
    [path.join(root, 'scripts', 'probe-native.cjs'), runtimeDir],
    {
      cwd: runtimeDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 120000,
    },
  );
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
  return { ok: res.status === 0, out };
}

console.log('[rebuild-native] 探测原生模块在 Electron ABI 下的加载情况…');
const first = probe();
console.log(first.out);

if (first.ok && !force) {
  console.log('\n[rebuild-native] 全部原生模块可加载，无需 ABI 重编译（跳过 @electron/rebuild）。');
  process.exit(0);
}

if (checkOnly) {
  console.log('\n[rebuild-native] --check 模式：仅报告，不执行重建。');
  process.exit(first.ok ? 0 : 1);
}

console.log(`\n[rebuild-native] 开始用 @electron/rebuild 针对 Electron ${electronVersion} 重编译…`);
const cli = path.join(root, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js');
const args = [cli, '-f', '-v', electronVersion, '-m', 'dsh-runtime', '--arch', process.arch];

const res = spawnSync(process.execPath, args, {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
  },
});

if (res.status !== 0) {
  console.error('[rebuild-native] 重编译失败。');
  process.exit(res.status ?? 1);
}

const second = probe();
console.log(second.out);
process.exit(second.ok ? 0 : 1);
