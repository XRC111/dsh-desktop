// 从 npm 拉取一个第三方插件到 resources/dsh-plugins/<name>（含它的运行时依赖）。
//
// 用法：
//   node scripts/fetch-plugin.mjs --name dshmarket
//        [--version latest] [--registry https://registry.npmmirror.com]
//        [--dry-run] [--force]
//
// 为什么需要它：dshmarket 是**第三方**插件，版本由上游决定。它 vendored 在
// resources/dsh-plugins/dshmarket 里跟随安装包分发，靠人手更新必然落后
// （实测：仓里 1.66.1，上游已经 1.66.8）。这个脚本把「下载 → 解压 → 装依赖 → 校验」
// 做成一步，并且**先在暂存目录里做完再原子替换** —— 中途断网或装依赖失败时，
// 原目录原封不动，不会留下半成品被后面打进安装包。
//
// 注意 node_modules 不在 git 里（.gitignore: resources/dsh-plugins/*/node_modules/），
// 所以**打包前必须跑过这个脚本**，否则打出来的包会缺依赖。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes('--' + f);
const opt = (f, d) => {
  const i = argv.indexOf('--' + f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const die = (m) => {
  // 不用 process.exit：紧跟 await 之后调用会触发 libuv 的
  // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"（实测 exit=3221226505）。
  // 抛出去让进程自然以非 0 退出，错误码才可靠。
  throw new Error(m);
};

const name = opt('name', '');
if (!name) die('需要 --name <插件名>');
const want = opt('version', 'latest');
const DRY = has('dry-run');
const FORCE = has('force');
const inCI = !!(process.env.CI || process.env.GITHUB_ACTIONS);
const registry = (
  opt('registry', process.env.DSH_NPM_REGISTRY || (inCI ? 'https://registry.npmjs.org' : 'https://registry.npmmirror.com')) || ''
).replace(/\/+$/, '');

process.on('uncaughtException', (err) => {
  console.error('[fetch-plugin] ' + (err && err.message ? err.message : err));
  process.exit(1);
});

const dest = path.join(root, 'resources', 'dsh-plugins', name);
if (!fs.existsSync(dest)) die('目录不存在：' + path.relative(root, dest) + '（新插件请先手工建好目录与 package.json）');
const log = (m) => console.log('[fetch-plugin] ' + m);

// ── 1) 查上游版本 ──────────────────────────────────────────────────────────
const metaRes = await fetch(registry + '/' + encodeURIComponent(name), { headers: { accept: 'application/json' } });
if (!metaRes.ok) die('查询 ' + name + ' 失败：HTTP ' + metaRes.status + '（registry=' + registry + '）');
const meta = await metaRes.json();
const target = want === 'latest' ? meta['dist-tags'] && meta['dist-tags'].latest : want;
if (!target) die('解析不出目标版本');
const ver = meta.versions && meta.versions[target];
if (!ver) die('上游没有 ' + target + ' 这个版本');

const localPkg = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8'));
log('本地 ' + localPkg.version + ' → 上游 ' + target + '（registry=' + registry + '）');
const alreadyLatest = localPkg.version === target && !FORCE;
if (alreadyLatest) log('已是最新，未做改动（要强制重拉加 --force）');
if (DRY) log('--dry-run：只报告，不下载');
if (!alreadyLatest && !DRY) {

// ── 2) 下载并解压到暂存目录 ────────────────────────────────────────────────
const staging = path.join(root, 'build', '.fetch-' + name);
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });

const tgz = path.join(root, 'build', '.' + name + '-' + target + '.tgz');
const tgzRes = await fetch(ver.dist.tarball, { headers: { accept: 'application/octet-stream' } });
if (!tgzRes.ok) die('下载 tarball 失败：HTTP ' + tgzRes.status);
fs.writeFileSync(tgz, Buffer.from(await tgzRes.arrayBuffer()));
log('已下载 ' + path.basename(tgz) + '（' + Math.round(fs.statSync(tgz).size / 1024) + ' KB）');

const tarExe =
  process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
// npm 的包是一层 package/ 前缀
const r1 = spawnSync(tarExe, ['-xzf', tgz, '-C', staging, '--strip-components=1'], { stdio: 'inherit' });
if (r1.status !== 0) die('解压失败（exit=' + r1.status + '）');
fs.rmSync(tgz, { force: true });

const pkgPath = path.join(staging, 'package.json');
if (!fs.existsSync(pkgPath)) die('解压后没有 package.json');
const sp = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (sp.version !== target) die('解压出的版本是 ' + sp.version + '，与期望的 ' + target + ' 不符');

// ── 3) 装运行时依赖 ────────────────────────────────────────────────────────
//
// 为什么不用 npm CLI：
//   1. CVE-2024-27980 修复后 Node 22 禁止不带 shell:true spawn npm.cmd（EINVAL）
//   2. 绕开 .cmd 改 node npm-cli.js 后，npm v10 在 CI Windows runner 上又报
//      `Cannot read properties of null (reading 'edgesOut')` —— arborist 内部崩溃，
//      换独立缓存目录也没用，是 npm 在全新临时目录 + --no-save 下的已知 bug。
//
// 插件依赖通常极少（dshmarket 只有 js-yaml + undici，都是纯 JS 包），
// 直接写个迷你安装器：查 registry → 下 tarball → tar 解压 → 递归装传递依赖。
// 完全不依赖 npm CLI，零版本兼容问题。

/** 解析 semver range 为具体版本号（只支持 ^ ~ >= x 等常见 range，足够插件用） */
function pickVersion(versions, range) {
  const all = Object.keys(versions).sort((a, b) => {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) { if ((pa[i]||0) !== (pb[i]||0)) return (pb[i]||0) - (pa[i]||0); }
    return 0;
  });
  if (!range || range === 'latest' || range === '*') return all[0];
  const m = range.match(/^[\^~]?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return all[0];
  const [, maj, min] = m.map(Number);
  const caret = range.startsWith('^');
  const tilde = range.startsWith('~');
  // ^：同 major；~：同 major.minor；裸：精确
  return all.find((v) => {
    const [vmaj, vmin] = v.split('.').map(Number);
    if (caret) return vmaj === maj;
    if (tilde) return vmaj === maj && vmin === min;
    return v === range.replace(/^[\^~]/, '');
  }) || all[0];
}

const installed = new Map(); // name -> version（去重）
async function installPkg(pkgName, range, depth = 0) {
  if (depth > 4) return;
  const key = pkgName + '@' + range;
  if (installed.has(key)) return;
  installed.set(key, true);

  const metaRes = await fetch(registry + '/' + pkgName.replace('/', '%2f'), { headers: { accept: 'application/json' } });
  if (!metaRes.ok) die('查不到包 ' + pkgName + '（HTTP ' + metaRes.status + '）');
  const meta = await metaRes.json();
  const ver = pickVersion(meta.versions, range);
  const pkg = meta.versions[ver];
  if (!pkg) die('包 ' + pkgName + '@' + ver + ' 不存在');

  // 下载 tarball
  const tgzRes = await fetch(pkg.dist.tarball);
  if (!tgzRes.ok) die('下载 ' + pkgName + '@' + ver + ' tarball 失败：HTTP ' + tgzRes.status);
  const tgzBuf = Buffer.from(await tgzRes.arrayBuffer());

  // 解压到 node_modules/<pkgName>/（npm tarball 包一层 package/ 前缀）
  const dest = path.join(staging, 'node_modules', ...pkgName.split('/'));
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const tmpTgz = path.join(root, 'build', '.' + pkgName.replace('/', '_') + '-' + ver + '.tgz');
  fs.writeFileSync(tmpTgz, tgzBuf);
  const tarExe = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  const r = spawnSync(tarExe, ['-xzf', tmpTgz, '-C', dest, '--strip-components=1'], { stdio: 'inherit' });
  fs.rmSync(tmpTgz, { force: true });
  if (r.status !== 0) die('解压 ' + pkgName + '@' + ver + ' 失败');

  // 递归装生产依赖
  const subdeps = pkg.dependencies || {};
  for (const [dn, dr] of Object.entries(subdeps)) {
    await installPkg(dn, dr, depth + 1);
  }
  log('  ✓ ' + pkgName + '@' + ver + (depth > 0 ? '（传递依赖）' : ''));
}

const deps = Object.keys(sp.dependencies || {});
if (deps.length > 0) {
  log('装依赖：' + deps.join('、') + '（迷你安装器，不经过 npm CLI）');
  for (const [dn, dr] of Object.entries(sp.dependencies || {})) {
    await installPkg(dn, dr);
  }
}

// ── 4) 校验：入口与依赖都得在 ──────────────────────────────────────────────
const problems = [];
if (!fs.existsSync(path.join(staging, 'cordis.patch.yml'))) problems.push('缺 cordis.patch.yml');
for (const d of deps) {
  if (!fs.existsSync(path.join(staging, 'node_modules', ...d.split('/'), 'package.json'))) {
    problems.push('依赖没装上：' + d);
  }
}
if (problems.length) die('校验未通过：' + problems.join('；') + '。原目录未改动');

// ── 5) 原子替换 ────────────────────────────────────────────────────────────
const backup = path.join(root, 'build', '.prev-' + name);
fs.rmSync(backup, { recursive: true, force: true });
fs.renameSync(dest, backup);
try {
  fs.renameSync(staging, dest);
} catch (err) {
  fs.renameSync(backup, dest); // 回滚
  die('替换失败，已回滚：' + err.message);
}
fs.rmSync(backup, { recursive: true, force: true });
log('已更新到 ' + target + '：' + path.relative(root, dest));
log('记得提交这个目录的改动（node_modules 不入库）。');
}
