// 把更新源部署到 Cloudflare Pages（免费、不用绑卡、可挂自定义域名）。
//
// 适合「热更新通道」：latest.json + hot-shell-*.tar 总共约 220KB。
// Pages 单文件上限 25 MiB —— 145MB 的安装包放不下，所以默认只部署热更新包；
// 若 JSON 里带 files（安装包），且本地文件超限，会明确报错而不是静默漏掉。
//
// 用法：
//   node scripts/deploy-pages.mjs --project dsh-desktop-feed \
//        [--base-url https://dsh-desktop-feed.pages.dev]   # 默认按项目名推导
//        [--feed dist/update/latest.json] [--hot build/hot-shell-1.1.2.tar]
//        [--branch main] [--dry-run]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : fallback;
}
const flag = (n) => process.argv.includes(`--${n}`);
const die = (m) => {
  console.error(`[deploy-pages] ${m}`);
  process.exit(1);
};

const PAGES_FILE_LIMIT = 25 * 1024 * 1024; // Pages 单文件上限 25 MiB

const project = arg('project', 'dsh-desktop-feed');
const baseUrl = (arg('base-url', `https://${project}.pages.dev`) || '').replace(/\/+$/, '');
const branch = arg('branch', 'main');
const dryRun = flag('dry-run');
// 本机的 wrangler 嵌套调用会 exit=null（环境拦截），所以支持「只暂存不上传」：
// 由外部脚本自己跑 wrangler pages deploy <stageDir>。暂存目录会保留，并把路径
// 写进 dist/update/.stage-dir 供外部脚本读取（比扫 %TEMP% 可靠）。
const stageOnly = flag('stage-only');
// 分通道：`--feed` 可重复，一次部署把所有通道的 JSON 都传上去
// （Pages 部署是整目录替换，分多次部署会让先传的通道被后一次覆盖）。
function argAll(name) {
  const out = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] !== `--${name}`) continue;
    const v = process.argv[i + 1];
    if (v && !v.startsWith('--')) out.push(v);
  }
  return out;
}

const feedFiles = (
  argAll('feed').length ? argAll('feed') : [path.join(root, 'dist', 'update', 'latest.json')]
).map((p) => path.resolve(p));
const hotArg = arg('hot', '');
const wrangler = arg(
  'wrangler',
  'C:\\Users\\Administrator\\WorkBuddy\\openlist\\openlist-worker\\node_modules\\wrangler\\bin\\wrangler.js',
);
const wranglerCwd = path.dirname(path.dirname(path.dirname(wrangler)));

for (const f of feedFiles) if (!fs.existsSync(f)) die(`找不到更新 JSON：${f}`);
if (!fs.existsSync(wrangler)) die(`找不到 wrangler：${wrangler}`);

// 每个通道一份：文件名即通道（latest.json / latest-beta.json / latest-dev.json）
const feeds = feedFiles.map((file) => ({
  file,
  name: path.basename(file),
  json: JSON.parse(fs.readFileSync(file, 'utf8')),
}));

// ---------------------------------------------------------------------------
// 1) 改写 JSON 里的地址 + 收集要部署的文件
// ---------------------------------------------------------------------------
const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pages-'));
const staged = [];

const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

function resolveLocal(name) {
  const cands = [
    hotArg && path.basename(hotArg) === name ? path.resolve(hotArg) : '',
    path.join(root, 'dist', 'update', name),
    path.join(root, 'dist', name),
    path.join(root, 'build', name),
  ].filter(Boolean);
  return cands.find((p) => fs.existsSync(p)) || '';
}

/** 收集 JSON 里引用的二进制文件（含分片），逐个落位暂存目录 */
function collectUrls(feed) {
  const urls = [];
  const push = (u) => {
    // 只收集本站（baseUrl 前缀）的文件——外链（GitHub Releases 等第三方直链）
    // 由客户端直接下载，不进 Pages 暂存清单，否则会被 25MiB 校验拦死。
    if (typeof u === 'string' && u && u.startsWith(baseUrl)) urls.push(u);
  };
  // 分片清单里存的是**相对整包 URL 的同级文件名**（客户端用 new URL(rel, url) 解析），
  // 这里要还原成绝对 URL 才能取 basename。
  const pushParts = (base, parts) => {
    if (!base) return;
    for (const p of parts ?? []) {
      if (/^https?:\/\//i.test(p)) push(p);
      else {
        try {
          push(new URL(p, base).href);
        } catch {
          /* 异常 feed：忽略 */
        }
      }
    }
  };
  if (feed.files) for (const v of Object.values(feed.files)) push(v.url);
  for (const h of asArray(feed.hot)) push(h.url);
  for (const r of asArray(feed.runtime)) {
    push(r.url);
    pushParts(r.url, r.parts);
  }
  // plugins 可能是单个对象或数组（一次挂多个插件包）
  for (const p of asArray(feed.plugins)) {
    push(p.url);
    pushParts(p.url, p.parts);
  }
  return urls;
}

// 多个通道会引用同一批二进制（runtime / plugins 是共用的）→ 按名字去重
const urlNames = new Map();
for (const f of feeds) {
  for (const url of collectUrls(f.json)) {
    const name = decodeURIComponent(new URL(url).pathname).split('/').pop();
    if (!urlNames.has(name)) urlNames.set(name, url);
  }
}

// 已切片的整包：本地可能有上百 MB，但线上只放分片，整包本身**不上传**
//（否则会被下面的 25 MiB 上限检查拦死）。
const chunkedNames = new Set();
const baseNameOf = (u) => decodeURIComponent(new URL(u).pathname).split('/').pop();
for (const f of feeds) {
  for (const r of asArray(f.json.runtime)) {
    if (r.parts?.length && r.url) chunkedNames.add(baseNameOf(r.url));
  }
  for (const pl of asArray(f.json.plugins)) {
    if (pl?.parts?.length && pl.url) chunkedNames.add(baseNameOf(pl.url));
  }
}

for (const [name, url] of urlNames) {
  const local = resolveLocal(name);
  if (!local) die(`找不到产物文件 ${name} —— 用 --hot / --runtime / --plugins 指定，或先生成`);
  const size = fs.statSync(local).size;
  if (size > PAGES_FILE_LIMIT) {
    if (chunkedNames.has(name)) continue; // 有分片，整包不上
    die(
      `${name} 有 ${(size / 1024 / 1024).toFixed(1)} MB，超过 Pages 单文件上限 25 MiB。\n` +
        '  · 安装包需要对象存储（R2/其他 S3）或你自己的服务器；\n' +
        '  · 插件包请让 scripts/pack-plugins.mjs 自动分片（--chunk-mb），分片后会逐片上传。',
    );
  }
  fs.copyFileSync(local, path.join(stageDir, name));
  staged.push({ name, size, label: '发布文件' });
}

// 附带上传安装脚本，让老用户可以用一条命令装插件：
//   irm https://<域名>/install-plugin.ps1 | iex
const ps1 = path.join(root, 'scripts', 'install-plugin.ps1');
if (fs.existsSync(ps1)) {
  fs.copyFileSync(ps1, path.join(stageDir, 'install-plugin.ps1'));
  staged.push({ name: 'install-plugin.ps1', size: fs.statSync(ps1).size, label: '插件安装脚本' });
}

for (const f of feeds) {
  const dst = path.join(stageDir, f.name);
  fs.writeFileSync(dst, JSON.stringify(f.json, null, 2), 'utf8');
  staged.push({ name: f.name, size: fs.statSync(dst).size, label: '更新描述' });
}
if (staged.length === 0) die('JSON 里没有可部署的内容');

// Pages 的缓存策略：
//   各通道的 latest*.json 不缓存（每次都取最新的更新描述）；
//   二进制包文件名里带内容哈希（pack:hot / pack-runtime-patch 生成），
//   所以可以放心 immutable —— 内容一变，文件名就变，不会命中旧缓存。
const headerLines = [];
for (const f of feeds) headerLines.push(`/${f.name}`, '  Cache-Control: no-cache', '');
headerLines.push(
  '/hot-shell-*.tar',
  '  Cache-Control: public, max-age=31536000, immutable',
  '',
  '/dsh-runtime-patch-*',
  '  Cache-Control: public, max-age=31536000, immutable',
  '',
  '/plugins-*',
  '  Cache-Control: public, max-age=31536000, immutable',
  '',
);
fs.writeFileSync(path.join(stageDir, '_headers'), headerLines.join('\n'), 'utf8');

console.log(`→ 暂存目录 ${stageDir}`);
for (const s of staged) console.log(`  · ${s.name}（${(s.size / 1024).toFixed(1)} KB，${s.label}）`);
console.log(`→ 公开地址前缀：${baseUrl}`);

// ---------------------------------------------------------------------------
// 2) 部署
// ---------------------------------------------------------------------------
if (dryRun) {
  console.log(
    `  [dry-run] wrangler pages deploy ${stageDir} --project-name ${project} --branch ${branch} --commit-dirty=true`,
  );
} else if (stageOnly) {
  console.log(`  [stage-only] 暂存完成，未上传。手动上传：`);
  console.log(
    `    node <wrangler.js> pages deploy "${stageDir}" --project-name ${project} --branch ${branch} --commit-dirty=true`,
  );
} else {
  const res = spawnSync(
    process.execPath,
    [wrangler, 'pages', 'deploy', stageDir, '--project-name', project, '--branch', branch, '--commit-dirty=true'],
    { cwd: wranglerCwd, env: { ...process.env, CI: '1' }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  console.log(out.trim().split(/\r?\n/).slice(-8).join('\n'));
  if (res.status !== 0) die(`部署失败（exit=${res.status}）`);
}

// 把暂存路径落盘，外部脚本（scripts/release-channels.ps1）直接读它，不用扫 %TEMP%
const stagePtr = path.join(root, 'dist', 'update', '.stage-dir');
fs.writeFileSync(stagePtr, stageDir, 'utf8');
console.log(`→ 暂存指针：${path.relative(root, stagePtr)}`);

if (!dryRun && !stageOnly) {
  fs.rmSync(stageDir, { recursive: true, force: true });
}
for (const f of feeds) {
  const finalLocal = path.join(root, 'dist', 'update', f.name.replace(/\.json$/, '.deployed.json'));
  fs.writeFileSync(finalLocal, JSON.stringify(f.json, null, 2), 'utf8');
}

console.log('\n✓ 完成');
console.log(`  feedUrl（填进 resources/update-config.json）：${baseUrl}/latest.json`);
for (const f of feeds) {
  console.log(`  本地留档：dist/update/${f.name.replace(/\.json$/, '.deployed.json')}`);
}
