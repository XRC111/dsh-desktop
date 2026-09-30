// 下载并准备 Win7 专用的 fork Electron（e3kskoy7wqk/Electron-for-windows-7）。
//
// ── 为什么需要这个脚本 ──────────────────────────────────────────────────────
// `build/electron-win7/` 被 .gitignore 排除（369MB），所以 **CI 里不存在**。
// 以前它是手工下载解压的 —— 手工步骤在 CI 上无法复现，所以补上这一环。
//
// 完整链路（三步，本脚本做前两步）：
//   1) 从 GitHub Release 下载 dist.zip（v44.2.0，约 158MB）
//   2) 解压到 build/electron-win7/（zip 内**无顶层目录**，electron.exe 在根）
//   3) 用 scripts/patch-w7-electron.py 打宿主指纹补丁（release-v2.ps1 里会调）
//
// ── 为什么必须打补丁 ────────────────────────────────────────────────────────
// dsh 0.1.7 起用 node-addon-require-builtin 按宿主指纹白名单校验（43.0.0 / 44.0.0 / 45.0.0-alpha.6）。
// fork 44.2.0 的真实指纹是 (Node 24.20.0, V8 15.2.124.19-electron.0)，不在表内 → dsh 拒绝启动。
// 打补丁把指纹改成官方 44.0.0 的值即可过门（等长原位替换，不改文件大小）。
//
// 用法：
//   node scripts/fetch-w7-electron.mjs              # 下载 + 解压（已存在则跳过）
//   node scripts/fetch-w7-electron.mjs --force      # 强制重下
//   node scripts/fetch-w7-electron.mjs --version v40.2.0   # 换 fork 版本
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetDir = path.join(root, 'build', 'electron-win7');

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : fallback;
}

const force = process.argv.includes('--force');
const forkVersion = arg('version', 'v44.2.0');
const REPO = 'e3kskoy7wqk/Electron-for-windows-7';
const asset = arg('asset', 'dist.zip');
const url = `https://github.com/${REPO}/releases/download/${forkVersion}/${asset}`;

// ── 幂等：已就绪且补丁已打就跳过 ─────────────────────────────────────────────
const exePath = path.join(targetDir, 'electron.exe');
const versionPath = path.join(targetDir, 'version');

function forkReady() {
  if (!fs.existsSync(exePath)) return false;
  // 目录里必须有 electron.exe + version（判断解压完整，而不是解压到一半）
  return fs.existsSync(versionPath);
}

if (!force && forkReady()) {
  const v = fs.readFileSync(versionPath, 'utf8').trim();
  console.log(`[fetch-w7] 已存在：build/electron-win7（Electron ${v}），跳过下载。用 --force 可重下。`);
  process.exit(0);
}

console.log(`[fetch-w7] fork 版本 = ${forkVersion}`);
console.log(`[fetch-w7] 下载源   = ${url}`);

// ── 下载 ────────────────────────────────────────────────────────────────────
// 用系统 curl（Windows 10+ 自带，CI 的 windows runner 也有）；
// 不用 Node 的 fetch 是因为大文件要跟随重定向 + 进度，curl 更省事也更快。
const zipPath = path.join(root, 'build', `.w7-fork-${forkVersion}.zip`);
fs.mkdirSync(path.dirname(zipPath), { recursive: true });

if (force || !fs.existsSync(zipPath) || fs.statSync(zipPath).size < 1024 * 1024) {
  const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const res = spawnSync(
    curl,
    ['-fL', '--retry', '3', '--retry-delay', '5', '-o', zipPath, url],
    { stdio: 'inherit' },
  );
  if (res.status !== 0) {
    console.error(`[fetch-w7] 下载失败（exit=${res.status}）。若在 CI，检查网络或改用 --version 换版本。`);
    process.exit(res.status ?? 1);
  }
} else {
  console.log('[fetch-w7] zip 已缓存，跳过下载');
}

const size = fs.statSync(zipPath).size;
console.log(`[fetch-w7] 已下载：${(size / 1024 / 1024).toFixed(1)} MB`);
if (size < 100 * 1024 * 1024) {
  console.error(`[fetch-w7] zip 体积异常（${size} B）—— 可能下到了错误页而不是真包`);
  process.exit(1);
}

// ── 解压 ────────────────────────────────────────────────────────────────────
// zip 内**没有顶层目录**（electron.exe 直接在根），所以直接解到目标目录。
// 用系统 tar（Windows 10+ 的 bsdtar 支持 zip）；PowerShell 的 Expand-Archive 更慢。
fs.rmSync(targetDir, { recursive: true, force: true });
fs.mkdirSync(targetDir, { recursive: true });

const tarExe =
  process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';

const unzip = spawnSync(tarExe, ['-xf', zipPath, '-C', targetDir], { stdio: 'inherit' });
if (unzip.status !== 0) {
  console.error(`[fetch-w7] 解压失败（exit=${unzip.status}）`);
  process.exit(unzip.status ?? 1);
}

// ── 校验解压结果 ────────────────────────────────────────────────────────────
if (!forkReady()) {
  console.error('[fetch-w7] 解压后缺少 electron.exe 或 version，目录结构不符预期');
  const got = fs.existsSync(targetDir) ? fs.readdirSync(targetDir).slice(0, 10) : [];
  console.error(`[fetch-w7] 实际内容：${got.join(', ')}`);
  process.exit(1);
}

const v = fs.readFileSync(versionPath, 'utf8').trim();
const exeSize = fs.statSync(exePath).size;
const fileCount = fs.readdirSync(targetDir, { withFileTypes: true }).filter((e) => e.isFile()).length;
console.log(`[fetch-w7] ✓ 就绪：build/electron-win7（Electron ${v}，electron.exe ${(exeSize / 1024 / 1024).toFixed(1)} MB，${fileCount} 个顶层文件）`);
console.log('[fetch-w7] 下一步：release-v2.ps1 会自动调 patch-w7-electron.py 打指纹补丁');

// 顺手清理 zip（369MB 解压后留着没用，CI 上更该省磁盘）
try {
  fs.rmSync(zipPath, { force: true });
  console.log('[fetch-w7] 已清理下载缓存');
} catch {
  /* 删不掉不影响构建 */
}
