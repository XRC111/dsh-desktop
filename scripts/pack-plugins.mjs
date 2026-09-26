// 把内嵌插件打成「可分发插件包」（tar.gz），超过托管单文件上限时自动切片。
//
// 用法：
//   node scripts/pack-plugins.mjs --name dsh-univer-office
//        [--dir resources/dsh-plugins/dsh-univer-office]
//        [--out build] [--chunk-mb 20] [--base-url https://dl.666-xrc.cc.cd]
//
// 产物：
//   build/plugins-<name>-<version>-<sha8>.tar.gz          （整包）
//   build/plugins-<name>-<version>-<sha8>.tar.gz.part01…   （超过上限时切片，每片 ≤ chunk-mb）
// 并打印可填进云端 JSON 的 plugins 段。
//
// 为什么还要切片：免费静态托管（Pages / Workers 静态资源）单文件上限 25MB，
// 而 dsh-univer-office 这类带原生绑定和自带产物的插件压缩后也有 60MB 上下。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : fallback;
}
const die = (m) => {
  console.error(`[pack-plugins] ${m}`);
  process.exit(1);
};

const name = arg('name', '');
if (!name) die('需要 --name <插件目录名>');
const srcDir = path.resolve(arg('dir', path.join(root, 'resources', 'dsh-plugins', name)));
const outDir = path.resolve(arg('out', path.join(root, 'build')));
const chunkMB = Number(arg('chunk-mb', '20'));
const baseUrl = (arg('base-url', 'https://dl.666-xrc.cc.cd') || '').replace(/\/+$/, '');
const HOST_LIMIT = 25 * 1024 * 1024; // 免费托管单文件上限

if (!fs.existsSync(srcDir)) die(`插件目录不存在：${srcDir}`);
const pkgPath = path.join(srcDir, 'package.json');
if (!fs.existsSync(pkgPath)) die(`插件缺少 package.json：${pkgPath}`);
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

const tarExe =
  process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';

fs.mkdirSync(outDir, { recursive: true });
const tmpTar = path.join(outDir, `.plugins-${name}.tmp.tar.gz`);
fs.rmSync(tmpTar, { force: true });
const res = spawnSync(tarExe, ['-czf', tmpTar, '-C', path.dirname(srcDir), path.basename(srcDir)], {
  stdio: 'inherit',
});
if (res.status !== 0) die(`tar 打包失败（exit=${res.status}）`);

const buf = fs.readFileSync(tmpTar);
const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
const short = sha256.slice(0, 8);
const outFile = path.join(outDir, `plugins-${name}-${pkg.version}-${short}.tar.gz`);
fs.rmSync(outFile, { force: true });
fs.renameSync(tmpTar, outFile);
console.log(`\n✓ 插件包：${path.relative(root, outFile)}（${(buf.length / 1024 / 1024).toFixed(2)} MB，sha256=${short}…）`);

const block = {
  version: `${pkg.name}@${pkg.version}`,
  sha256,
  size: buf.length,
};

if (buf.length <= HOST_LIMIT) {
  block.url = `${baseUrl}/${path.basename(outFile)}`;
  console.log('  未超过 25MB，单文件即可。');
} else {
  const chunkSize = Math.max(1, Math.floor(chunkMB)) * 1024 * 1024;
  const parts = [];
  // 分片直接平铺在 outDir 里（部署脚本按文件名找，别再套一层子目录）
  const base = path.basename(outFile);
  for (let i = 0, n = 1; i < buf.length; i += chunkSize, n++) {
    const partName = `${base}.part${String(n).padStart(2, '0')}`;
    fs.writeFileSync(path.join(outDir, partName), buf.subarray(i, i + chunkSize));
    parts.push(partName);
  }
  block.parts = parts.map((p) => `${baseUrl}/${p}`);
  console.log(`  超过 25MB → 切成 ${parts.length} 片（每片 ≤${chunkMB}MB），平铺在 build/`);
}

console.log('\n填到云端 JSON 的 plugins 段：');
console.log(JSON.stringify({ plugins: block }, null, 2));

// 顺手写一份 meta 描述，供 gen-update-json --plugins <meta.json> 直接引用（含分片清单）
const metaFile = path.join(outDir, `plugins-${name}-${pkg.version}-${short}.meta.json`);
fs.writeFileSync(metaFile, JSON.stringify(block, null, 2), 'utf8');
console.log(`\nmeta 描述：${path.relative(root, metaFile)}`);
