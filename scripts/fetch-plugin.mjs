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

// ── 3) 装运行时依赖（插件把自己的依赖放在自己的 node_modules 里随包走）────
const deps = Object.keys(sp.dependencies || {});
if (deps.length > 0) {
  log('装依赖：' + deps.join('、'));
  // Windows 上 node 不能直接 spawn 'npm'（那是个 .cmd 脚本）；
  // 用 npm.cmd 并**不要** shell:true —— 后者会触发 DEP0190 且参数不转义。
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r2 = spawnSync(
    npmCmd,
    [
      'install',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--no-save',
      // 必须 --ignore-scripts：npm 包的 prepare/prepublish 是给源码仓库用的，
      // 发布出来的 tarball 已经带编译产物（client/client.js、lib/*.js），
      // 但**不含** tsconfig.json 之类的构建配置 —— 不忽略脚本就会在
      // 「npm run build → tsc -p tsconfig.json」上直接失败（实测 exit=1）。
      '--ignore-scripts',
      '--registry=' + registry,
    ],
    { cwd: staging, stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '' } },
  );
  if (r2.status !== 0) die('npm install 失败（exit=' + r2.status + '），原目录未改动');
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
