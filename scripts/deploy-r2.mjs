// 把更新源部署到 Cloudflare R2（用你账号里的存储桶）。
//
// 前提：本机已授权 wrangler（`wrangler login` 或提供 CLOUDFLARE_API_TOKEN）。
//
// 用法：
//   node scripts/deploy-r2.mjs --bucket openlist --prefix dsh-desktop
//        [--account-id <id>]                  # 用 API token 方式时需要
//        [--base-url https://pub-xxx.r2.dev/dsh-desktop]   # 不给则自动取 r2.dev 域名
//        [--setup dist/update/DSH-Desktop-Setup-1.1.1.exe]
//        [--hot build/hot-shell-1.1.2.tar]
//        [--feed dist/update/latest.json]
//        [--dry-run]                          # 只打印要执行的动作
//
// 做的事：
//   1) 校验 wrangler 登录态
//   2) 需要时创建桶、确保公开访问（r2.dev）
//   3) 先上传安装包/热更新包，最后上传 latest.json（顺序很重要：客户端不该拿到
//      指向尚未上传文件的 JSON），上传前会把 JSON 里的 url 改写成真实公开地址
//   4) 打印最终 feedUrl（填进 resources/update-config.json）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : fallback;
}
const flag = (n) => process.argv.includes(`--${n}`);
const die = (msg, code = 1) => {
  console.error(`[deploy-r2] ${msg}`);
  process.exit(code);
};

const bucket = arg('bucket', 'openlist');
const prefixRaw = arg('prefix', 'dsh-desktop');
// --prefix / 或 --prefix - 表示放在桶根目录（绑了专用子域名时通常这么用）
const prefix = prefixRaw === '/' || prefixRaw === '-' ? '' : prefixRaw.replace(/^\/+|\/+$/g, '');
const keyOf = (...parts) => parts.filter(Boolean).join('/');
/** 拼公开地址：prefix 为空时不要留出双斜杠 */
const joinUrl = (host, p) => `https://${host}${p ? `/${p}` : ''}`;
const dryRun = flag('dry-run');
const wrangler = arg(
  'wrangler',
  'C:\\Users\\Administrator\\WorkBuddy\\openlist\\openlist-worker\\node_modules\\wrangler\\bin\\wrangler.js',
);
const wranglerCwd = path.dirname(path.dirname(path.dirname(wrangler)));

if (!fs.existsSync(wrangler)) die(`找不到 wrangler：${wrangler}\n（用 --wrangler 指定，或先 npm i -D wrangler）`);

const env = { ...process.env, CI: '1' };
if (arg('account-id', '')) env.CLOUDFLARE_ACCOUNT_ID = arg('account-id', '');

function wr(args, opts = {}) {
  const printable = `wrangler ${args.join(' ')}`;
  // 试运行：一条命令都不执行，只把动作列出来（因此也不需要登录态）
  if (dryRun) {
    console.log(`  [dry-run] ${printable}`);
    return { status: 0, stdout: '', stderr: '', all: '' };
  }
  const res = spawnSync(process.execPath, [wrangler, ...args], {
    cwd: wranglerCwd,
    env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  if (opts.echo) console.log(out.trim().split(/\r?\n/).slice(-4).join('\n'));
  return { status: res.status ?? 1, stdout: res.stdout || '', stderr: res.stderr || '', all: out };
}

// ---------------------------------------------------------------------------
// 1) 登录态
// ---------------------------------------------------------------------------
console.log('→ 检查 wrangler 登录态…');
const who = wr(process.env.CLOUDFLARE_API_TOKEN ? ['whoami'] : ['whoami'], { must: true });
if (/not authenticated|Please run .?wrangler login/i.test(who.all)) {
  die(
    '本机 wrangler 未登录，无法上传到你的 Cloudflare 账号。二选一：\n' +
      '  A) 浏览器授权（推荐，不用把密钥贴进对话）：\n' +
      `     cd ${wranglerCwd}\n` +
      '     npx wrangler login\n' +
      '     然后重新运行本脚本。\n' +
      '  B) 用 API token（权限：Account → Workers R2 Storage → Edit）：\n' +
      '     set CLOUDFLARE_API_TOKEN=xxxx\n' +
      '     set CLOUDFLARE_ACCOUNT_ID=yyyy\n' +
      '     node scripts/deploy-r2.mjs --bucket openlist --prefix dsh-desktop --account-id %CLOUDFLARE_ACCOUNT_ID%',
    2,
  );
}
console.log('  ✓ 已登录');

// ---------------------------------------------------------------------------
// 2) 桶与公开访问
// ---------------------------------------------------------------------------
console.log(`→ 确保桶 ${bucket} 存在…`);
const create = wr(['r2', 'bucket', 'create', bucket]);
if (create.status !== 0 && !/already exists|10004|10008/i.test(create.all)) {
  die(`创建桶失败：\n${create.all.trim().slice(-500)}`);
} else {
  console.log('  ✓ 桶可用（已存在或刚创建）');
}

console.log('→ 确定公开访问地址（优先自定义域名）…');
let publicBase = arg('base-url', '');
const domainArg = arg('domain', '');
const zoneArg = arg('zone-id', '');

/** 从 wrangler 输出里挑出域名（排除 r2.dev） */
function pickDomain(text) {
  const hosts = (text.match(/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/gi) || [])
    .map((h) => h.toLowerCase())
    .filter((h) => !h.endsWith('r2.dev') && !h.endsWith('cloudflare.com') && !h.endsWith('workers.dev'));
  return hosts[0] || '';
}

if (dryRun) {
  console.log(`  [dry-run] wrangler r2 bucket domain list ${bucket}`);
  if (domainArg) console.log(`  [dry-run] wrangler r2 bucket domain add ${bucket} --domain ${domainArg} --zone-id <zone>`);
  publicBase = publicBase || joinUrl(domainArg || '<你的域名>', prefix);
} else if (!publicBase && domainArg) {
  // 明确要绑这个域名：先看是否已绑，没绑就绑上
  const listed = wr(['r2', 'bucket', 'domain', 'list', bucket]).all || '';
  if (!listed.toLowerCase().includes(domainArg.toLowerCase())) {
    if (!zoneArg) {
      die(
        `绑定自定义域名需要 zone id（域名所在区的 ID）：\n` +
          `  node scripts/deploy-r2.mjs --bucket ${bucket} --prefix ${prefix} ` +
          `--domain ${domainArg} --zone-id <zone-id>\n` +
          `zone id 在 Cloudflare Dashboard → 你的域名 → 右侧 Overview 底部；\n` +
          `也可以在 Dashboard 里手动绑：R2 → ${bucket} → Settings → Custom Domains → Connect Domain`,
      );
    }
    const add = wr(
      ['r2', 'bucket', 'domain', 'add', bucket, '--domain', domainArg, '--zone-id', zoneArg, '--min-tls', '1.2', '-y'],
      { echo: true },
    );
    if (add.status !== 0) die(`绑定域名失败：\n${(add.all || '').trim().slice(-500)}`);
    console.log(`  ✓ 已绑定自定义域名 ${domainArg}`);
  } else {
    console.log(`  ✓ 自定义域名已存在：${domainArg}`);
  }
  publicBase = joinUrl(domainArg, prefix);
} else if (!publicBase) {
  // 自动探测：已绑的自定义域名优先，其次 r2.dev
  const listed = pickDomain(wr(['r2', 'bucket', 'domain', 'list', bucket]).all || '');
  if (listed) {
    console.log(`  ✓ 探测到已绑的自定义域名：${listed}`);
    publicBase = joinUrl(listed, prefix);
  } else {
    console.log('  · 没绑自定义域名，回退到 r2.dev（限速、国内访问不稳，建议生产绑域名）');
    wr(['r2', 'bucket', 'dev-url', 'enable', bucket]);
    const got = wr(['r2', 'bucket', 'dev-url', 'get', bucket]);
    const m = (got.all || '').match(/https:\/\/[a-z0-9-]+\.r2\.dev/i);
    if (m) publicBase = joinUrl(m[0].replace(/^https?:\/\//i, ''), prefix);
  }
}

if (!publicBase) {
  die(
    '缺少公开访问地址。R2 桶默认不公开，客户端必须能 https 下载。\n' +
      `  · 推荐：--domain <你的域名> --zone-id <zone-id>（或先在 Dashboard 绑定，脚本会自动探测）\n` +
      `  · 快法：r2.dev（wrangler r2 bucket dev-url enable ${bucket}），限速、不适合生产`,
  );
}
console.log(`  ✓ 公开地址前缀：${publicBase}`);

// ---------------------------------------------------------------------------
// 3) 上传（先产物，最后 JSON）
// ---------------------------------------------------------------------------
const feedFile = path.resolve(arg('feed', path.join(root, 'dist', 'update', 'latest.json')));
if (!fs.existsSync(feedFile)) die(`找不到更新 JSON：${feedFile}`);
const feed = JSON.parse(fs.readFileSync(feedFile, 'utf8'));

// 收集要上传的产物 + 改写 JSON 里的 URL
const uploads = [];
function collect(info, label) {
  if (!info) return;
  const url = new URL(info.url);
  const key = url.pathname.replace(/^\/+/, '').split('/').pop();
  uploads.push({ key: keyOf(prefix, key), file: null, label });
  info.url = `${publicBase}/${key}`;
}
if (feed.files) for (const [k, v] of Object.entries(feed.files)) collect(v, `安装包(${k})`);
if (feed.hot) collect(feed.hot, '热更新包');

// 把本地文件对应上
const setupArg = arg('setup', '');
const hotArg = arg('hot', '');
for (const u of uploads) {
  const name = u.key.split('/').pop();
  const guess =
    (setupArg && path.basename(setupArg) === name && path.resolve(setupArg)) ||
    (hotArg && path.basename(hotArg) === name && path.resolve(hotArg)) ||
    [
      path.join(root, 'dist', 'update', name),
      path.join(root, 'dist', name),
      path.join(root, 'build', name),
    ].find((p) => fs.existsSync(p));
  if (!guess || !fs.existsSync(guess)) die(`找不到产物文件：${name}（用 --setup/--hot 指定）`);
  u.file = guess;
}

for (const u of uploads) {
  const ct = u.key.endsWith('.tar') || u.key.endsWith('.exe') ? 'application/octet-stream' : 'application/json';
  const bytes = fs.statSync(u.file).size;
  console.log(`→ 上传 ${u.label}：${u.key}（${(bytes / 1024 / 1024).toFixed(1)} MB）`);
  const res = wr(
    [
      'r2',
      'object',
      'put',
      `${bucket}/${u.key}`,
      '--file',
      u.file,
      '--content-type',
      ct,
      '--cache-control',
      'public, max-age=31536000, immutable',
      '--remote',
    ],
    { echo: true },
  );
  if (res.status !== 0) die(`上传失败：\n${(res.all || '').trim().slice(-600)}`);
}

// JSON 最后传，且不缓存（客户端已带 no-cache 头，避免 CDN 缓存旧版本）
console.log(`→ 上传更新 JSON：${keyOf(prefix, 'latest.json')}（no-cache）`);
const tmpJson = path.join(root,'dist','update','.upload-latest.json');
fs.writeFileSync(tmpJson, JSON.stringify(feed, null, 2), 'utf8');
const res = wr(
  [
    'r2',
    'object',
    'put',
    keyOf(bucket, prefix, 'latest.json'),
    '--file',
    tmpJson,
    '--content-type',
    'application/json',
    '--cache-control',
    'no-cache',
    '--remote',
  ],
  { echo: true },
);
fs.rmSync(tmpJson, { force: true });
if (res.status !== 0) die(`上传 JSON 失败：\n${(res.all || '').trim().slice(-600)}`);

// 本地也留一份「已改写为真实地址」的版本，方便排查
const finalLocal = path.join(root, 'dist', 'update', 'latest.deployed.json');
fs.writeFileSync(finalLocal, JSON.stringify(feed, null, 2), 'utf8');

console.log('\n✓ 部署完成');
console.log(`  feedUrl（填进 resources/update-config.json）：${publicBase}/latest.json`);
console.log(`  本地留档：${path.relative(root, finalLocal)}`);
