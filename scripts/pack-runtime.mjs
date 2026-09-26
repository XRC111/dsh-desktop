// 把 resources/dsh-runtime 打成单个 tar 供安装包分发。
//
// 为什么不直接让 electron-builder 复制目录：
//   electron-builder 对 extraResources 中的 node_modules 会套用「依赖树」处理逻辑，
//   结果整个 node_modules 一个文件都不会被复制（实测只复制出 package.json）。
//   改用一个 tar 文件分发可以完全绕开该行为。
//
// 产物：build/dsh-runtime.tar（未压缩：体积大但解压快，交给 NSIS 再做整体压缩）
// 使用系统自带 tar.exe（Windows 10 1803+ 内置 bsdtar）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resourcesDir = path.join(root, 'resources');
const runtimeDir = path.join(resourcesDir, 'dsh-runtime');
const outFile = path.join(root, 'build', 'dsh-runtime.tar');

if (!fs.existsSync(runtimeDir)) {
  console.error('[pack-runtime] 未找到 resources/dsh-runtime，请先执行 npm run prepare:runtime');
  process.exit(1);
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
if (fs.existsSync(outFile)) fs.rmSync(outFile, { force: true });

console.log('[pack-runtime] 正在打包 dsh-runtime.tar …');

// 必须使用 Windows 自带的 bsdtar：Git Bash / MSYS 自带的 GNU tar 会把
// "D:\..." 这类路径中的冒号当成远程主机名（报 "Cannot connect to D: resolve failed"）。
const tarExe =
  process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';

const res = spawnSync(tarExe, ['-cf', outFile, '-C', resourcesDir, 'dsh-runtime'], {
  stdio: 'inherit',
  shell: false,
});

if (res.status !== 0) {
  console.error(
    `[pack-runtime] tar 打包失败（exit=${res.status}）。需要系统自带 ${tarExe}（Windows 10 1803+）。`,
  );
  process.exit(res.status ?? 1);
}

const mb = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
console.log(`[pack-runtime] 完成：build/dsh-runtime.tar (${mb} MB)`);
