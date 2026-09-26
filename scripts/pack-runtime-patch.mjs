// 打「运行时差分补丁」：对比两份 dsh 运行时树，只打包新增/改动的文件 + 待删除清单。
//
// 为什么做差分：dsh 运行时是 269MB / 3.5 万文件，整包热更新太重；
// 而一个小版本升级通常只动几个包，差分后往往只有几百 KB ~ 几 MB，
// 于是「跟版 dsh」也能走热更新（下载 → 重启即生效），并且能放进免费静态托管。
//
// 用法：
//   node scripts/pack-runtime-patch.mjs --from <旧运行时目录> --to <新运行时目录>
//        [--out build] [--chunk-mb 20] [--dry-run]
//
// 产物：
//   build/dsh-runtime-patch-<base>-to-<ver>.tar.gz      （补丁本体）
//   build/dsh-runtime-patch-<base>-to-<ver>.tar.gz.partNN（超过 chunk 上限时切片）
//   并打印可填进云端 JSON 的 runtime 段
//
// 补丁包结构：
//   runtime-patch.json      { version, baseVersion, files:[{p,size}], deletes:[...], counts }
//   files/<相对路径>        新增或改动的文件（保持原目录结构）
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
const dryRun = process.argv.includes('--dry-run');
const die = (m) => {
  console.error(`[pack-runtime-patch] ${m}`);
  process.exit(1);
};

const fromDir = arg('from', path.join(root, 'resources', 'dsh-runtime'));
const toDir = arg('to', '');
if (!toDir) die('需要 --to <新运行时目录>');
const outDir = path.resolve(arg('out', path.join(root, 'build')));
const chunkMB = Number(arg('chunk-mb', '20'));
const PAGES_LIMIT = 25 * 1024 * 1024; // Pages 单文件上限，切片按它留余量

for (const [label, d] of [['--from', fromDir], ['--to', toDir]]) {
  if (!fs.existsSync(d)) die(`${label} 目录不存在：${d}`);
}

/** 读某个运行时树里 dsh 的版本 */
function runtimeVersion(dir) {
  const p = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  if (!fs.existsSync(p)) die(`不在运行时目录里：${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8')).version;
}

/** 列出一棵树里的所有文件（相对 node_modules 的 posix 路径 → 绝对路径） */
function listFiles(dir) {
  const base = path.join(dir, 'node_modules');
  const out = new Map();
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else out.set(path.relative(base, abs).split(path.sep).join('/'), abs);
    }
  };
  walk(base);
  return out;
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const baseVersion = runtimeVersion(fromDir);
const version = runtimeVersion(toDir);
if (baseVersion === version) die(`两棵树版本相同（${version}），没有可打包的差分`);

console.log(`对比：${baseVersion} → ${version}`);
const t0 = Date.now();
const oldFiles = listFiles(fromDir);
const newFiles = listFiles(toDir);
console.log(`  旧树 ${oldFiles.size} 个文件，新树 ${newFiles.size} 个文件`);

// ── 计算差分 ────────────────────────────────────────────────────────────────
const changed = [];
let sameCount = 0;
for (const [rel, abs] of newFiles) {
  const oldAbs = oldFiles.get(rel);
  if (!oldAbs) {
    changed.push({ rel, abs, kind: 'add' });
    continue;
  }
  const so = fs.statSync(oldAbs).size;
  const sn = fs.statSync(abs).size;
  if (so !== sn || sha256(oldAbs) !== sha256(abs)) changed.push({ rel, abs, kind: 'mod' });
  else sameCount++;
}
const deletes = [...oldFiles.keys()].filter((rel) => !newFiles.has(rel));
const changedBytes = changed.reduce((n, c) => n + fs.statSync(c.abs).size, 0);

console.log(`  未变 ${sameCount}；新增 ${changed.filter((c) => c.kind === 'add').length}；` +
  `改动 ${changed.filter((c) => c.kind === 'mod').length}；删除 ${deletes.length}`);
console.log(`  差分文件合计 ${(changedBytes / 1024 / 1024).toFixed(2)} MB，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

if (dryRun) {
  console.log('\n（--dry-run，不打包）变化清单前 20 项：');
  for (const c of changed.slice(0, 20)) console.log(`  ${c.kind === 'add' ? '+' : 'M'} ${c.rel}`);
  if (deletes.length) console.log(`  删除前 10 项：\n    ${deletes.slice(0, 10).join('\n    ')}`);
  process.exit(0);
}

// ── 组装暂存目录 ────────────────────────────────────────────────────────────
const stage = path.join(outDir, `.patch-stage-${version}`);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, 'files'), { recursive: true });

for (const c of changed) {
  const dst = path.join(stage, 'files', ...c.rel.split('/'));
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(c.abs, dst);
}
const manifest = {
  version,
  baseVersion,
  files: changed.map((c) => ({ p: c.rel, size: fs.statSync(c.abs).size, k: c.kind })),
  deletes,
  counts: { total: newFiles.size, changed: changed.length, deleted: deletes.length, unchanged: sameCount },
  builtAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(stage, 'runtime-patch.json'), JSON.stringify(manifest, null, 2), 'utf8');

// ── 打 tar.gz ───────────────────────────────────────────────────────────────
// 文件名同样带内容哈希：静态托管对这些包设了长缓存，同名换内容会拿到旧包
const tarExe =
  process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
fs.mkdirSync(outDir, { recursive: true });
const tmpTar = path.join(outDir, `.runtime-patch-${version}.tmp.tar.gz`);
fs.rmSync(tmpTar, { force: true });
const tarRes = spawnSync(tarExe, ['-czf', tmpTar, '-C', stage, '.'], { stdio: 'inherit' });
if (tarRes.status !== 0) die(`tar 打包失败（exit=${tarRes.status}）`);
fs.rmSync(stage, { recursive: true, force: true });

const buf = fs.readFileSync(tmpTar);
const digest = crypto.createHash('sha256').update(buf).digest('hex');
const outFile = path.join(
  outDir,
  `dsh-runtime-patch-${baseVersion}-to-${version}-${digest.slice(0, 8)}.tar.gz`,
);
fs.rmSync(outFile, { force: true });
fs.renameSync(tmpTar, outFile);
console.log(`\n✓ 补丁包：${path.relative(root, outFile)}（${(buf.length / 1024 / 1024).toFixed(2)} MB）`);

// ── 超过免费托管单文件上限就切片 ────────────────────────────────────────────
const runtimeBlock = {
  version,
  baseVersion,
  file: path.basename(outFile),
  url: '',
  sha256: digest,
  size: buf.length,
};

if (buf.length <= PAGES_LIMIT) {
  console.log('  未超过 25MB，单文件即可（Pages/KV/Workers 静态资源都能放）');
} else {
  const chunkSize = Math.max(1, Math.floor(chunkMB)) * 1024 * 1024;
  const parts = [];
  // 分片**与整包同级**输出：部署时 collectUrls 按 basename 找得到，
  // 客户端用 new URL(part, url) 解析成同级 URL，两边都不用额外记前缀。
  const partsDir = outDir;
  fs.mkdirSync(partsDir, { recursive: true });
  for (let i = 0, n = 1; i < buf.length; i += chunkSize, n++) {
    const name = `${path.basename(outFile)}.part${String(n).padStart(2, '0')}`;
    fs.writeFileSync(path.join(partsDir, name), buf.subarray(i, i + chunkSize));
    parts.push(name);
  }
  console.log(`  超过 25MB → 切成 ${parts.length} 片（每片 ≤${chunkMB}MB）放在 ${path.relative(root, partsDir)}`);
  runtimeBlock.parts = parts.slice();
}

// meta 描述：给 gen-update-json 直接引用（分片清单在里面，手抄易错）
const metaFile = `${outFile}.meta.json`;
fs.writeFileSync(metaFile, JSON.stringify(runtimeBlock, null, 2) + '\n');
console.log(`\nmeta 描述：${path.relative(root, metaFile)}`);

console.log('\n填到云端 JSON 的 runtime 段：');
console.log(JSON.stringify({ runtime: runtimeBlock }, null, 2));
