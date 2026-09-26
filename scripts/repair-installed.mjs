// 就地修复一个已安装的 DSH Desktop（不重新安装）。
//
// 用法：
//   node scripts/repair-installed.mjs "<安装目录>\resources"
//   例：node scripts/repair-installed.mjs "D:\dsh\DSH Desktop\resources"
//
// 它做的事与应用启动时的自愈完全相同：
//   1) 读 build/dsh-runtime-manifest.json 得到应有文件列表
//   2) 与安装目录实际文件比对，找出缺失项
//   3) 交给多线程解压器（--only 模式）并行补齐 —— 与安装期用的是同一份实现
//
// 注意：安装目录通常位于 Program Files，需要管理员权限才能写入。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2];

if (!base) {
  console.error('用法: node scripts/repair-installed.mjs "<安装目录>\\resources"');
  process.exit(1);
}
if (!fs.existsSync(base)) {
  console.error(`目标目录不存在: ${base}`);
  process.exit(1);
}

const manifestFile = path.join(root, 'build', 'dsh-runtime-manifest.json');
const tarFile = path.join(root, 'build', 'dsh-runtime.tar');
if (!fs.existsSync(manifestFile) || !fs.existsSync(tarFile)) {
  console.error('缺少 build/dsh-runtime-manifest.json 或 build/dsh-runtime.tar，请先构建');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
console.log(`清单文件数: ${manifest.fileCount}`);

const exists = (rel) => fs.existsSync(path.join(base, ...rel.split('/')));

console.log('正在比对缺失文件…');
const missing = manifest.files.filter((rel) => !exists(rel));
console.log(`缺失 ${missing.length} 个文件`);

if (missing.length === 0) {
  console.log('运行时完整，无需修复。');
  process.exit(0);
}

const listFile = path.join(os.tmpdir(), `dsh-repair-${process.pid}.txt`);
fs.writeFileSync(listFile, missing.join('\n'), 'utf8');

// 优先用目标安装目录里自带的解压器（与那个版本完全配套），否则用项目里的
const extractor = fs.existsSync(path.join(base, 'extract-runtime.cjs'))
  ? path.join(base, 'extract-runtime.cjs')
  : path.join(root, 'resources', 'extract-runtime.cjs');

console.log('正在用多线程解压器并行补齐…');
const res = spawnSync(process.execPath, [extractor, '--tar', tarFile, '--dest', base, '--only', listFile], {
  stdio: 'inherit',
});

try {
  fs.unlinkSync(listFile);
} catch {
  /* ignore */
}

if ((res.status ?? 1) !== 0) {
  console.error(`修复失败（解压器退出码 ${res.status}）`);
  process.exit(1);
}

let fixed = 0;
for (const rel of missing) if (exists(rel)) fixed++;
console.log(`修复完成：成功补齐 ${fixed}/${missing.length} 个文件`);

if (fixed < missing.length) {
  console.warn(`仍有 ${missing.length - fixed} 个文件未补齐，建议重新安装 1.0.2 及以上版本。`);
}
