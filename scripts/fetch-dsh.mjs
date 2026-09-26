// 拉取 DeepSeek Harness 运行时到 resources/dsh-runtime
//   - 只装生产依赖（dsh 本体 + 依赖树，约 250 MB）
//   - 使用国内镜像加速（可用 DSH_NPM_REGISTRY / DSH_ELECTRON_MIRROR 覆盖）
//   - 已存在且版本一致时跳过（--force 强制重装）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetDir = path.join(root, 'resources', 'dsh-runtime');
const force = process.argv.includes('--force');

const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const dshVersion = rootPkg?.config?.dshVersion;
if (!dshVersion) {
  console.error('[fetch-dsh] 根 package.json 缺少 config.dshVersion，请先指定要封装的 dsh 版本');
  process.exit(1);
}

const registry = process.env.DSH_NPM_REGISTRY || 'https://registry.npmmirror.com';
const electronMirror = process.env.DSH_ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';

fs.mkdirSync(targetDir, { recursive: true });

const runtimePkg = {
  name: 'dsh-runtime',
  version: '0.0.0',
  private: true,
  description: 'Vendored DeepSeek Harness runtime (production dependencies only).',
  dependencies: { '@deepseek-ai/dsh': dshVersion },
};
fs.writeFileSync(
  path.join(targetDir, 'package.json'),
  JSON.stringify(runtimePkg, null, 2) + '\n',
);

const installedMarker = path.join(targetDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
if (!force && fs.existsSync(installedMarker)) {
  try {
    const cur = JSON.parse(fs.readFileSync(installedMarker, 'utf8'));
    if (cur.version === dshVersion) {
      console.log(`[fetch-dsh] 运行时已存在且版本一致（${dshVersion}），跳过安装。用 --force 可强制重装。`);
      process.exit(0);
    }
    console.log(`[fetch-dsh] 版本不一致：现有 ${cur.version} → 目标 ${dshVersion}，开始安装`);
  } catch {
    /* 解析失败则继续安装 */
  }
}

console.log(`[fetch-dsh] 安装 @deepseek-ai/dsh@${dshVersion} → ${path.relative(root, targetDir)}`);
console.log(`[fetch-dsh] registry = ${registry}`);

// --ignore-scripts 是刻意选择的：
//   dsh 依赖树里 koffi 的 install 会调用 cnoke 重新拉取/编译二进制，
//   node-pty 的 install 在缺少 prebuild 时会回落 node-gyp，
//   这两步在 Windows 构建机上极易长时间卡住。
//   而 node-pty / koffi / sharp 的预编译产物本身就随 tarball 分发（已实测可在
//   Electron ABI 下直接加载），因此跳过安装脚本既安全又大幅提速。
//   唯一需要补跑的是 dsh-subprocess-local 的 ensure-spawn-helper（Unix 下恢复
//   spawn-helper 可执行位），见下方 runRequiredPostinstall()。
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const args = [
  'install',
  '--omit=dev',
  '--ignore-scripts',
  '--prefer-offline',
  '--no-audit',
  '--no-fund',
  '--loglevel=error',
  '--maxsockets=25',
  `--registry=${registry}`,
];

const res = spawnSync(npmCmd, args, {
  cwd: targetDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    ELECTRON_MIRROR: electronMirror,
    ELECTRON_BUILDER_BINARIES_MIRROR:
      process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
      'https://npmmirror.com/mirrors/electron-builder-binaries/',
  },
});

if (res.status !== 0) {
  console.error(`[fetch-dsh] npm install 失败（exit=${res.status}）`);
  process.exit(res.status ?? 1);
}

const check = JSON.parse(fs.readFileSync(installedMarker, 'utf8'));
console.log(`[fetch-dsh] 完成：@deepseek-ai/dsh@${check.version}`);
console.log(`[fetch-dsh] 入口(bin)：${JSON.stringify(check.bin)}`);

// 补跑必要的安装脚本（--ignore-scripts 跳过的）
runRequiredPostinstall();

function runRequiredPostinstall() {
  const helper = path.join(
    targetDir,
    'node_modules',
    '@deepseek-ai',
    'dsh-subprocess-local',
    'scripts',
    'ensure-spawn-helper.mjs',
  );
  if (!fs.existsSync(helper)) return;
  const r = spawnSync(process.execPath, [helper], {
    cwd: targetDir,
    stdio: 'ignore',
    env: { ...process.env },
  });
  console.log(
    `[fetch-dsh] ensure-spawn-helper 执行完成（exit=${r.status}，Windows 下为无操作）`,
  );
}

