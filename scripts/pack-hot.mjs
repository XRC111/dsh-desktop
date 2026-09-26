// 打包「热更新壳」：把编译产物 out/ 打成 build/hot-shell.tar，并打印 sha256 / size。
//
// 用法：
//   npm run build                       # 先编译
//   node scripts/pack-hot.mjs --version 1.1.1 --base 1.1.0
//
// 产物直接填到云端 JSON 的 hot 字段：
//   "hot": {
//     "version": "1.1.1",
//     "baseVersion": "1.1.0",
//     "url": "https://你的域名/hot-1.1.1.tar",
//     "sha256": "<脚本打印>",
//     "size": <脚本打印>
//   }
//
// 说明：
//   - 热更新包只含外壳代码（main + preload + renderer，约 200KB），
//     不含 dsh 运行时（269MB）与 Electron，所以客户端只需重启即可生效。
//   - baseVersion 必须等于客户端**已安装的版本**（app.asar 里的版本）；
//     baseVersion 不匹配时客户端会自动忽略热更新、改走完整安装包。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : fallback;
}

const version = arg('version', pkg.version);
// baseVersion 是「最低支持的已安装版本」，不是"必须等于"。
// 默认取 package.json 的 config.hotMinBaseVersion（= 最早支持热更新的版本），
// 这样每次发版只管 --version，客户端会自动爬上来，不用再手工配比基线。
const baseVersion = arg('base', pkg.config?.hotMinBaseVersion ?? version);
const staging = path.join(root, 'build', 'hot-staging');

// ── 1) 准备暂存目录 ─────────────────────────────────────────────────────────
if (!fs.existsSync(path.join(root, 'out', 'main', 'boot.js'))) {
  console.error('[pack-hot] 未找到 out/main/boot.js，请先执行 npm run build');
  process.exit(1);
}

fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });

for (const dir of ['main', 'preload', 'renderer', 'assets']) {
  const from = path.join(root, 'out', dir);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(staging, dir), { recursive: true });
}

// 热更新包自己的元信息：客户端据此判断版本与兼容性
fs.writeFileSync(
  path.join(staging, 'hot-manifest.json'),
  JSON.stringify(
    {
      version,
      baseVersion,
      builtAt: new Date().toISOString(),
    },
    null,
    2,
  ),
);

// ── 2) 打成 tar ──────────────────────────────────────────────────────────────
// 注意：文件名里带内容哈希。因为静态托管那边对这些包设了长缓存/immutable，
// 同名文件换了内容会导致 CDN 一直吐旧包（实测踩过），所以内容变 → 文件名就变。
//
// 打包方式：优先用系统 tar.exe；如果不可用（被安全软件/shim 阻断、返回 null），
// 回退到 Node 原生 tar 打包（用 tar npm 包，客户端也用同一个库解压）。
const tarExe =
  process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';

const tmpTar = path.join(root, 'build', `.hot-shell-${version}.tmp.tar`);
fs.rmSync(tmpTar, { force: true });

let tarOk = false;
try {
  const probe = spawnSync(tarExe, ['--version'], { encoding: 'utf8', timeout: 5000 });
  tarOk = probe.status === 0;
} catch {
  tarOk = false;
}

if (tarOk) {
  const res = spawnSync(tarExe, ['-cf', tmpTar, '-C', staging, '.'], { stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`[pack-hot] tar 打包失败（exit=${res.status}）`);
    process.exit(res.status ?? 1);
  }
} else {
  // 回退：用 tar npm 包（项目已依赖，客户端解压也用它）
  console.log('[pack-hot] 系统 tar 不可用，回退到 Node tar 包');
  const tar = await import('tar');
  await tar.c({ file: tmpTar, cwd: staging, portable: true }, ['.']);
}

const buf = fs.readFileSync(tmpTar);
const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
const outFile = path.join(root, 'build', `hot-shell-${version}-${sha256.slice(0, 8)}.tar`);
fs.rmSync(outFile, { force: true });
fs.renameSync(tmpTar, outFile);

// ── 3) 校验 + 打印云端 JSON 片段 ────────────────────────────────────────────
const kb = (buf.length / 1024).toFixed(1);
const files = [];
(function walk(dir, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, path.join(rel, e.name));
    else files.push(path.join(rel, e.name).split(path.sep).join('/'));
  }
})(staging, '');
fs.rmSync(staging, { recursive: true, force: true });

console.log(`\n[pack-hot] 完成：build/${path.basename(outFile)}（${kb} KB，${files.length} 个文件）`);
console.log(`[pack-hot] version=${version}  baseVersion=${baseVersion}`);
console.log('\n填到云端 JSON 里：');
console.log(
  JSON.stringify(
    { hot: { version, baseVersion, url: `https://你的域名/${path.basename(outFile)}`, sha256, size: buf.length } },
    null,
    2,
  ),
);
