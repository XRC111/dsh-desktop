// 拉取 DeepSeek Harness **最新源码**并编译，产出 nightly 运行时树。
//
// ── 为什么要这个脚本 ────────────────────────────────────────────────────────
// stable/beta/dev 都是「装 npm 上已发布的版本」（fetch-dsh.mjs）。nightly 不一样：
// 它要 **master 分支的最新提交**，而官方 npm 上根本没有 nightly 标签
// （实测 dist-tags 只有 alpha / latest / next），所以只能自己从源码编。
//
// ── 已实测的事实（2026-09-30，本机 Windows）────────────────────────────────
//   · 仓库公开：github.com/deepseek-ai/deepseek-harness，默认分支 master
//   · 克隆可行：本地走 gh-proxy 镜像（115MB / 0.5 分钟），CI 直连 github.com
//   · pnpm install --frozen-lockfile：4.3 分钟；常在 1388/1392 处网络超时 → 必须重试
//   · pnpm run build：可行，但**要求 git 在 PATH**（构建期 git rev-parse HEAD 烧标识）
//   · Windows 上 build:native-system 是 no-op（官方只在 linux/darwin 编原生件）
//   · 构建产物 apps/cli/lib/bin.js 可被 Electron 直接跑起来（实测 dsh web 正常）
//   · pnpm deploy **不可用**：只带 508 个包（源码树 1393 个），vendor/ 下的包会丢
//   · ⚠️ 构建目录的**任一父目录**若有 0 字节 package.json，PostCSS 向上查找时
//      JSON.parse('') 会崩 → 构建目录必须干净（本机踩过）
//
// 用法：
//   node scripts/fetch-nightly.mjs                       # 装到 resources/dsh-runtime
//   node scripts/fetch-nightly.mjs --to build/rt-nightly
//   node scripts/fetch-nightly.mjs --ref <commit|branch>
//   node scripts/fetch-nightly.mjs --keep-src            # 保留源码树（调试）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback = '') {
  const i = process.argv.indexOf('--' + name);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : fallback;
}
function flag(name) {
  return process.argv.includes('--' + name);
}

const targetDir = (() => {
  const t = arg('to');
  if (!t) return path.join(root, 'resources', 'dsh-runtime');
  return path.isAbsolute(t) ? t : path.resolve(root, t);
})();
const ref = arg('ref', 'master');
const keepSrc = flag('keep-src');
const srcDir = path.resolve(arg('src', path.join(root, 'build', 'harness-src')));

const REPO = 'https://github.com/deepseek-ai/deepseek-harness.git';

// ── 镜像策略：CI 直连，本地走镜像 ───────────────────────────────────────────
// GitHub runner 在**美国**，走 gh-proxy/npmmirror 等于「美国 → 中国代理 → 美国」，
// 绕远路还多一个故障点；而本机在国内，直连 github.com 常失败。
// 所以按 CI 环境变量自动切换，两边都可用 DSH_GIT_MIRROR / DSH_NPM_REGISTRY 覆盖。
const inCI = process.env.CI === 'true' || process.env.CI === '1';
const MIRROR = process.env.DSH_GIT_MIRROR ?? (inCI ? '' : 'https://gh-proxy.com/');
const registry = process.env.DSH_NPM_REGISTRY || (inCI ? 'https://registry.npmjs.org' : 'https://registry.npmmirror.com');

function log(m) { console.log('[nightly] ' + m); }
function die(m) { console.error('[nightly] ' + m); process.exit(1); }

/** 找一个可用的 git（PATH 上没有就用便携版） */
function gitExe() {
  const probe = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (probe.status === 0) return 'git';
  for (const c of [
    'D:\\flutter\\bin\\mingit\\cmd\\git.exe',
    'C:\\Users\\Administrator\\workbuddy\\binaries\\PortableGit\\versions\\1.2.0\\mingw64\\bin\\git.exe',
  ]) {
    if (fs.existsSync(c)) return c;
  }
  die('找不到 git。构建期需要 git rev-parse HEAD，请把 git 放进 PATH。');
}

const git = gitExe();

/**
 * 跑一条外部命令。
 *
 * ⚠️ Windows 上的坑（CI 实测踩到）：`spawnSync('pnpm', ...)` **不会**自动解析
 * `.cmd` 后缀 —— pnpm/npm 在 Windows 上是 `pnpm.cmd`，Node 只按字面找 `pnpm`，
 * 结果 ENOENT（status=null → 这里返回 1，看起来像「命令失败」但没有任何输出）。
 *
 * 判据不能只看命令名带不带 .cmd（`'pnpm'` 不带），得看**平台**：
 * Windows 上一律用 shell，让 cmd.exe 去解析 .cmd/.exe。
 * 代价是参数要自己防注入，但这里全是固定串与内部路径，无外部输入。
 */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  });
  if (r.error) log('  命令启动失败：' + cmd + ' —— ' + String(r.error.message));
  return r.status ?? 1;
}

// ── 1) 克隆或更新源码 ───────────────────────────────────────────────────────
log('源码目录 ' + srcDir);
if (fs.existsSync(path.join(srcDir, '.git'))) {
  log('已有源码树 → fetch 更新到 ' + ref);
  run(git, ['-C', srcDir, 'fetch', '--depth', '1', 'origin', ref]);
  run(git, ['-C', srcDir, 'checkout', '-f', 'FETCH_HEAD']);
} else {
  fs.rmSync(srcDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(srcDir), { recursive: true });
  // MIRROR 为空 = CI（直连）；非空 = 本地（走镜像，失败再回落直连）
  const primary = MIRROR ? MIRROR + REPO : REPO;
  log('克隆 ' + ref + '（' + (MIRROR ? '镜像 ' + MIRROR : '直连 github.com') + '）');
  let code = run(git, ['clone', '--depth', '1', '--branch', ref, primary, srcDir]);
  if (code !== 0 && MIRROR) {
    log('镜像克隆失败 → 回落到直连 github.com');
    fs.rmSync(srcDir, { recursive: true, force: true });
    code = run(git, ['clone', '--depth', '1', '--branch', ref, REPO, srcDir]);
  }
  if (code !== 0) die('克隆失败');
}

// ⚠️ 干净性检查：构建目录的任一父目录若有 0 字节 package.json，
// PostCSS 向上查找时会 JSON.parse('') 崩溃（本机实测踩过）。
for (let d = path.dirname(srcDir); ; ) {
  const pj = path.join(d, 'package.json');
  if (fs.existsSync(pj) && fs.statSync(pj).size === 0) {
    die('父目录存在 0 字节 package.json，会导致 PostCSS 崩溃：' + pj + '\n  请删掉它，或用 --src 换目录。');
  }
  const up = path.dirname(d);
  if (up === d) break;
  d = up;
}

const sha = String(spawnSync(git, ['-C', srcDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout || '').trim();
const shortSha = sha.slice(0, 7);
const pkg = JSON.parse(fs.readFileSync(path.join(srcDir, 'apps', 'cli', 'package.json'), 'utf8'));
log('上游版本 ' + pkg.version + ' @ ' + shortSha);

// ── 2) 安装依赖 ─────────────────────────────────────────────────────────────
log('pnpm install --frozen-lockfile（最多 3 次）');
let installOk = false;
for (let i = 1; i <= 3; i++) {
  const code = run('pnpm', ['install', '--frozen-lockfile', '--reporter=append-only'], {
    cwd: srcDir,
    env: {
      ...process.env,
      npm_config_registry: registry,
      npm_config_fetch_timeout: '600000',
      npm_config_fetch_retries: '5',
      npm_config_fetch_retry_mintimeout: '20000',
      npm_config_fetch_retry_maxtimeout: '120000',
    },
  });
  if (code === 0) { installOk = true; break; }
  log('第 ' + i + ' 次 install 失败（exit=' + code + '），重试…');
}
if (!installOk) die('pnpm install 连续 3 次失败');

// ── 3) 构建 ─────────────────────────────────────────────────────────────────
// ⚠️ 必须让 git 在 PATH 上：build 脚本会 git rev-parse HEAD 烧构建标识。
log('pnpm run build');
const gitDir = path.dirname(git);
const buildCode = run('pnpm', ['run', 'build'], {
  cwd: srcDir,
  env: {
    ...process.env,
    PATH: git === 'git' ? process.env.PATH : gitDir + path.delimiter + process.env.PATH,
    DSH_TELEMETRY_DISABLED: '1',
  },
});
if (buildCode !== 0) die('pnpm run build 失败（exit=' + buildCode + '）');

const binJs = path.join(srcDir, 'apps', 'cli', 'lib', 'bin.js');
if (!fs.existsSync(binJs)) die('构建后缺少 apps/cli/lib/bin.js —— 构建没真正成功');

// ── 4) 组装运行时树 ─────────────────────────────────────────────────────────
// 为什么不用 pnpm deploy：实测只带 508 个包（源码树 1393 个），vendor/ 下的
// workspace 包会丢，启动即 ERR_MODULE_NOT_FOUND。所以按「源码树 + 入口指向
// apps/cli」自己组装 —— 这正是本机实测能跑起来的那种形态。
log('组装运行时树 → ' + targetDir);
fs.rmSync(targetDir, { recursive: true, force: true });
fs.mkdirSync(targetDir, { recursive: true });

log('  复制 node_modules（约 1GB，稍等）');
copyTree(path.join(srcDir, 'node_modules'), path.join(targetDir, 'node_modules'));

// workspace 包在 pnpm 里是符号链接，脱离源码树会断 → 物化成真目录
const scopeDir = path.join(targetDir, 'node_modules', '@deepseek-ai');
fs.mkdirSync(scopeDir, { recursive: true });
let materialized = 0;
for (const base of ['packages', 'apps', 'vendor', 'native']) {
  const baseDir = path.join(srcDir, base);
  if (!fs.existsSync(baseDir)) continue;
  for (const p of findPackages(baseDir)) {
    const manifest = JSON.parse(fs.readFileSync(path.join(p, 'package.json'), 'utf8'));
    if (!manifest.name) continue;
    const dest = path.join(targetDir, 'node_modules', ...manifest.name.split('/'));
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(path.join(p, 'package.json'), path.join(dest, 'package.json'));
    for (const sub of ['lib', 'dist', 'locale', 'assets', 'skills', 'config', 'reference']) {
      const from = path.join(p, sub);
      if (fs.existsSync(from)) copyTree(from, path.join(dest, sub));
    }
    materialized++;
  }
}
log('  物化 workspace 包 ' + materialized + ' 个');

// 入口：@deepseek-ai/dsh 指向 apps/cli 的产物
const dshDir = path.join(targetDir, 'node_modules', '@deepseek-ai', 'dsh');
fs.rmSync(dshDir, { recursive: true, force: true });
fs.mkdirSync(dshDir, { recursive: true });
fs.copyFileSync(path.join(srcDir, 'apps', 'cli', 'package.json'), path.join(dshDir, 'package.json'));
copyTree(path.join(srcDir, 'apps', 'cli', 'lib'), path.join(dshDir, 'lib'));

const nightlyVersion = pkg.version + '+nightly.' + shortSha;
fs.writeFileSync(
  path.join(targetDir, 'package.json'),
  JSON.stringify(
    {
      name: 'dsh-runtime',
      version: '0.0.0',
      private: true,
      description: 'Nightly DeepSeek Harness runtime, built from source at ' + shortSha,
      dependencies: { '@deepseek-ai/dsh': nightlyVersion },
      dshNightly: { upstreamVersion: pkg.version, commit: sha, ref, builtAt: new Date().toISOString() },
    },
    null,
    2,
  ) + '\n',
);

// ── 5) 自检 ─────────────────────────────────────────────────────────────────
const checkBin = path.join(targetDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
if (!fs.existsSync(checkBin)) die('组装后缺少 node_modules/@deepseek-ai/dsh/lib/bin.js');

log('完成：' + nightlyVersion);
log('  入口 ' + path.relative(root, checkBin));

if (!keepSrc) {
  log('清理源码树（--keep-src 可保留）');
  fs.rmSync(srcDir, { recursive: true, force: true });
}

/** 递归找含 package.json 的包目录（深度 3，覆盖 packages/x/y 与 vendor/x） */
function findPackages(dir, depth = 0) {
  const out = [];
  if (depth > 3) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  if (entries.some((e) => e.isFile() && e.name === 'package.json')) return [dir];
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue;
    out.push(...findPackages(path.join(dir, e.name), depth + 1));
  }
  return out;
}

/**
 * 复制目录树。刻意**不** dereference：pnpm 的 .pnpm 布局里链接指向 store，
 * 展开会让体积翻倍。
 */
function copyTree(from, to) {
  fs.cpSync(from, to, { recursive: true, force: true, dereference: false, verbatimSymlinks: true });
}
