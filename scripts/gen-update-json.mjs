// 生成云端更新 JSON（latest.json）——sha256 / size 全部从实际产物算出，避免手填出错。
//
// 用法：
//   node scripts/gen-update-json.mjs --base-url https://cdn.example.com/dsh/
//        [--version 1.1.1]                       # 默认取 package.json 的版本
//        [--setup dist/DSH-Desktop-Setup-1.1.1.exe]   # 默认自动找 dist 下同版本安装包
//        [--hot build/hot-shell-1.1.2.tar]       # 可选：带上热更新通道
//        [--notes "更新说明"] [--mandatory] [--min-version 1.0.0]
//        [--channel stable] [--out dist/update/latest.json] [--no-stage]
//
// 产出：
//   dist/update/latest.json      ← 上传到你的静态托管
//   dist/update/<安装包>          ← 与 json 放同一目录即可（--no-stage 可关掉复制）
//
// 部署时把 dist/update 整个目录传到同一路径下，保证 json 里的 URL 与文件同名可达。
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
function flag(name) {
  return process.argv.includes(`--${name}`);
}
function die(msg) {
  console.error(`[gen-update-json] ${msg}`);
  process.exit(1);
}

const version = arg('version', pkg.version);
const channel = String(arg('channel', 'stable')).toLowerCase();
if (!['stable', 'beta', 'dev', 'nightly', 'w7', 'w7-beta', 'w7-dev'].includes(channel)) {
  console.error(`[gen-update-json] 未知通道 ${channel}（可选 stable / beta / dev / nightly / w7 / w7-beta / w7-dev）`);
  process.exit(1);
}
// 通道决定文件名：静态托管只能靠不同文件区分（?channel= 参数对静态源无效）
const channelSuffix = channel === 'stable' ? '' : `-${channel}`;
const baseUrl = (arg('base-url', '') || '').replace(/\/+$/, '');
if (!baseUrl) {
  die(
    '缺少 --base-url。示例：\n' +
      '  node scripts/gen-update-json.mjs --base-url https://cdn.example.com/dsh/ --version 1.1.1',
  );
}
if (!/^https:\/\//i.test(baseUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)/i.test(baseUrl)) {
  die('更新源必须是 https（本地联调可用 http://127.0.0.1）');
}

// 未显式给 --out 时按通道自动命名：latest.json / latest-beta.json / latest-dev.json
const outFile = path.resolve(
  arg('out', path.join(root, 'dist', 'update', `latest${channelSuffix}.json`)),
);
const stage = !flag('no-stage');

// ---------------------------------------------------------------------------
// 1) 安装包
// ---------------------------------------------------------------------------
const setupArg = arg('setup', '');
let setupFile = setupArg ? path.resolve(setupArg) : '';
if (!setupFile) {
  // 只认**版本号精确匹配**的安装包，绝不退回「dist 下最新的那个」。
  // 退回最新版是个静默的错误源：发 10.2.1 时若 10.2.1.exe 还没构建，
  // 会拿 10.1.2.exe 的 sha256/size 填进 feed —— 用户下载时哈希对不上，
  // 或更糟：下到别的版本却被当成目标版本校验通过（实测踩过）。
  const guess = path.join(root, 'dist', `DSH-Desktop-Setup-${version}.exe`);
  if (fs.existsSync(guess)) setupFile = guess;
}


const hotOnly = flag('hot-only');
// --setup-url：安装包走外链（网盘/对象存储直链）——feed 只挂 URL，安装包本体
// 不上 Pages（25MiB 上限）。sha256/size 优先从本地 dist 同名安装包算（客户端
// 下载完的哈希校验照常工作）；本地没有安装包时用 --setup-sha256/--setup-size 显式补，
// 两者都没有则哈希校验降级为「无 sha256」（客户端按 size/HEAD 校验兜底）。
const setupUrl = arg('setup-url', '');
const setupShaArg = arg('setup-sha256', '');
const setupSizeArg = Number(arg('setup-size', 0)) || 0;
if (setupUrl && hotOnly) die('--setup-url 与 --hot-only 冲突：外链模式就是要挂安装包');
if (setupUrl && !/^https?:\/\//i.test(setupUrl)) {
  die(`--setup-url 必须是 http(s) 直链（程序可直接 GET）：${setupUrl}`);
}
let setupBuf = null;
let setupName = '';
// --hot-only 时 feed 根本不含安装包，别把 200MB 读进内存
if (!hotOnly && setupFile && fs.existsSync(setupFile)) {
  setupBuf = fs.readFileSync(setupFile);
  setupName = path.basename(setupFile);
}
if (!hotOnly && !setupUrl && !setupBuf) die('找不到安装包（可用 --setup 指定）');
if (setupUrl && !setupBuf && !setupShaArg) {
  console.warn(
    '[gen-update-json] ⚠ 外链模式但本地 dist 没有同版本安装包、也未给 --setup-sha256：' +
      'feed 将不带 sha256，客户端按 size 探测兜底（建议把安装包放回 dist/ 或显式给哈希）',
  );
}
const setupSha = setupBuf
  ? crypto.createHash('sha256').update(setupBuf).digest('hex')
  : setupShaArg;

// ---------------------------------------------------------------------------
// 2) 可选：热更新包（版本/baseVersion 从包内 hot-manifest.json 读，不靠文件名猜）
// ---------------------------------------------------------------------------
/** 支持重复传入（--hot a.tar --hot b.tar）以生成「升级链」 */
function argAll(name) {
  const out = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === `--${name}`) {
      const v = process.argv[i + 1];
      if (v && !v.startsWith('--')) out.push(v);
    }
  }
  return out;
}

let hotBlock = null;
const hotBlocks = [];
const stagedHot = [];
const hotFiles = argAll('hot');
for (const hotArg of hotFiles) {
  const hotFile = path.resolve(hotArg);
  if (!fs.existsSync(hotFile)) die(`找不到热更新包：${hotFile}`);

  const tarExe =
    process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
  // 读包内 manifest：优先系统 tar.exe；不可用（被安全软件/沙盒拦截）时回退到
  // Node 的 tar 包——两种打包路径格式都要认（系统 tar 打出来是 `hot-manifest.json`，
  // Node tar 包打出来带 `./` 前缀），所以回退时用 endsWith 匹配。
  let manifestText = '';
  const probe = spawnSync(tarExe, ['-xOf', hotFile, './hot-manifest.json'], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (probe.status === 0 && probe.stdout) {
    manifestText = probe.stdout;
  } else {
    const os = await import('node:os');
    const tar = await import('tar');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-manifest-'));
    try {
      await tar.x({
        file: hotFile,
        cwd: tmpDir,
        filter: (p) => String(p).replace(/\\/g, '/').endsWith('hot-manifest.json'),
      });
      const found = path.join(tmpDir, 'hot-manifest.json');
      if (fs.existsSync(found)) manifestText = fs.readFileSync(found, 'utf8');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
  if (!manifestText) {
    die(`热更新包里读不到 hot-manifest.json（用 npm run pack:hot 生成）`);
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    die('热更新包里的 hot-manifest.json 不是合法 JSON');
  }

  const hotBuf = fs.readFileSync(hotFile);
  const block = {
    version: manifest.version,
    baseVersion: manifest.baseVersion,
    url: `${baseUrl}/${path.basename(hotFile)}`,
    sha256: crypto.createHash('sha256').update(hotBuf).digest('hex'),
    size: hotBuf.length,
  };
  hotBlocks.push(block);
  stagedHot.push(hotFile);
  console.log(
    `[gen-update-json] 热更新包：${manifest.version}（最低支持 ${manifest.baseVersion}）`,
  );
}
// 兼容旧写法：单个包时仍是对象，多个包时是升级链数组。
// 多变体（同一 version、不同 baseVersion）按 baseVersion **降序**输出：
// 老客户端的 pickHot 在同版本时不重排、按数组顺序取第一个能用的，
// 而更老的引导器按 baseVersion === 安装版严格相等选壳 —— 数组乱序会让
// baseVersion 过低的变体被选中后遭引导器拒收，用户重启后永远停在旧壳。
const baseCmp = (x, y) => {
  const core = (s) => String(s).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const [a, b] = [core(x), core(y)];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
};
hotBlocks.sort((x, y) => baseCmp(y.baseVersion ?? '', x.baseVersion ?? ''));
hotBlock = hotBlocks.length === 1 ? hotBlocks[0] : hotBlocks.length > 1 ? hotBlocks : null;

// ---------------------------------------------------------------------------
// 2b) 可选：运行时差分补丁（dsh 本体升级，重启时套用）
//     版本信息从包内 runtime-patch.json 读（由 scripts/pack-runtime-patch.mjs 生成）
//     支持重复传入（--runtime a.tar.gz --runtime b.tar.gz）以生成「升级链」
// ---------------------------------------------------------------------------
const runtimeFiles = argAll('runtime');
let runtimeBlock = null;
const runtimeBlocks = [];
const stagedRuntime = [];
for (const runtimeArg of runtimeFiles) {
  const runtimeFile = path.resolve(runtimeArg);

  // meta 形态（`pack-runtime-patch.mjs` 写的 `<包>.meta.json`）：直接采用，
  // 因为**分片清单只在 meta 里**——大补丁超过托管单文件上限后整包根本上传不了。
  if (runtimeFile.endsWith('.meta.json')) {
    const meta = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    const file = meta.file || String(meta.url || '').split('/').pop();
    if (!file) die(`运行时 meta 缺少 file 字段：${runtimeFile}`);
    const dir = path.dirname(runtimeFile);
    const tarPath = path.join(dir, file);
    const hasWhole = fs.existsSync(tarPath);
    const hasParts = Array.isArray(meta.parts) && meta.parts.length > 0;

    // 整包**可以不存在**：超过托管单文件上限的补丁只发分片，整包本身就不上传
    // （deploy-pages 也会跳过已切片整包的 25MiB 校验）。
    // 所以有 parts 时，直接用 meta 里已有的 sha256/size —— 它们就是整包的哈希/大小，
    // 客户端按分片拼接后再校验，等价。
    // 以前这里无条件要求整包在盘，导致「重新切片后旧整包被清理」的发版直接 die。
    let sha = meta.sha256;
    let size = meta.size;
    if (hasWhole) {
      const buf = fs.readFileSync(tarPath);
      sha = crypto.createHash('sha256').update(buf).digest('hex');
      size = buf.length;
      if (meta.sha256 && meta.sha256 !== sha) die(`运行时整包 sha256 与 meta 不符：${tarPath}`);
    } else if (!hasParts) {
      die(`运行时 meta 指向的整包不存在，且没有 parts 可用：${tarPath}`);
    } else if (!sha || !size) {
      die(`运行时整包缺失，且 meta 未提供 sha256/size：${runtimeFile}`);
    }

    // 分片齐全性：缺片会导致客户端拼接后校验失败，必须在这里拦住
    if (hasParts) {
      const missing = meta.parts.filter((p) => !fs.existsSync(path.join(dir, p)));
      if (missing.length) die(`运行时补丁缺分片（${missing.length} 个）：${missing.slice(0, 3).join('、')}`);
      const sum = meta.parts.reduce((n, p) => n + fs.statSync(path.join(dir, p)).size, 0);
      if (size && sum !== size) {
        die(`运行时补丁分片大小合计（${sum}）与 meta.size（${size}）不符：${path.basename(runtimeFile)}`);
      }
    }

    runtimeBlocks.push({
      version: meta.version,
      baseVersion: meta.baseVersion,
      url: `${baseUrl}/${file}`,
      sha256: sha,
      size,
      ...(hasParts ? { parts: meta.parts.slice() } : {}),
      // meta 里可声明 requiresElectron（如 dsh 0.1.7 只认官方 44.0.0 指纹），
      // 新壳在下载前据此跳过不兼容的补丁
      ...(meta.requiresElectron?.length ? { requiresElectron: meta.requiresElectron.slice() } : {}),
    });
    // 分片与整包同级，一并 stage 到输出目录，部署时才传得上去。
    // 整包不存在（已切片的补丁）时不 stage 它 —— 反正也不上传。
    if (hasWhole) stagedRuntime.push(tarPath);
    for (const p of meta.parts ?? []) {
      stagedRuntime.push(path.join(dir, p));
    }
    console.log(
      `[gen-update-json] 运行时补丁：dsh ${meta.baseVersion} → ${meta.version}` +
        `（${(size / 1024 / 1024).toFixed(2)} MB` +
        `${hasParts ? `，切成 ${meta.parts.length} 片` : ''}${hasWhole ? '' : '，整包未保留'}）`,
    );
    continue;
  }

  if (!fs.existsSync(runtimeFile)) die(`找不到运行时补丁：${runtimeFile}`);

  const tarExe =
    process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
  // 与上面热更包同理：系统 tar.exe 不可用时回退到 Node tar 包（.tar.gz 也能解）
  let runtimeManifestText = '';
  const probe = spawnSync(tarExe, ['-xzOf', runtimeFile, './runtime-patch.json'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (probe.status === 0 && probe.stdout) {
    runtimeManifestText = probe.stdout;
  } else {
    const os = await import('node:os');
    const tar = await import('tar');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-patch-'));
    try {
      await tar.x({
        file: runtimeFile,
        cwd: tmpDir,
        filter: (p) => String(p).replace(/\\/g, '/').endsWith('runtime-patch.json'),
      });
      const found = path.join(tmpDir, 'runtime-patch.json');
      if (fs.existsSync(found)) runtimeManifestText = fs.readFileSync(found, 'utf8');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
  if (!runtimeManifestText) {
    die('运行时补丁里读不到 runtime-patch.json（用 node scripts/pack-runtime-patch.mjs 生成）');
  }
  let manifest;
  try {
    manifest = JSON.parse(runtimeManifestText);
  } catch {
    die('运行时补丁里的 runtime-patch.json 不是合法 JSON');
  }
  const buf = fs.readFileSync(runtimeFile);
  runtimeBlocks.push({
    version: manifest.version,
    baseVersion: manifest.baseVersion,
    url: `${baseUrl}/${path.basename(runtimeFile)}`,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    size: buf.length,
  });
  stagedRuntime.push(runtimeFile);
  console.log(
    `[gen-update-json] 运行时补丁：dsh ${manifest.baseVersion} → ${manifest.version}` +
      `（覆盖 ${manifest.files?.length ?? '?'} 个文件，${(buf.length / 1024 / 1024).toFixed(2)} MB）`,
  );
}
// 兼容旧写法：单个补丁仍是对象，多个补丁是升级链数组（pickRuntime 每次重启爬一档）
runtimeBlock =
  runtimeBlocks.length === 1 ? runtimeBlocks[0] : runtimeBlocks.length > 1 ? runtimeBlocks : null;

// ---------------------------------------------------------------------------
// 2c) 可选：插件包（scripts/pack-plugins.mjs 生成的 meta 描述，含分片清单）
// ---------------------------------------------------------------------------
// 支持重复传入（--plugins a.meta.json --plugins b.meta.json）以一次挂多个插件包。
// 单个时仍输出**对象**（与历史 feed 完全一致，老客户端不需要改）；
// 多个时输出数组（客户端 asArray 归一化，老客户端会忽略多余项而不是崩）。
const pluginsArgs = argAll('plugins');
const pluginsBlocks = [];
for (const raw of pluginsArgs) {
  const metaPath = path.resolve(raw);
  if (!fs.existsSync(metaPath)) die(`找不到插件 meta 描述：${metaPath}`);
  let block;
  try {
    block = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    die(`插件 meta 描述不是合法 JSON：${metaPath}`);
  }
  if (!block?.sha256 || !block?.size) die(`插件 meta 描述缺少 sha256/size：${metaPath}`);
  const n = block.parts?.length ?? 0;
  console.log(
    `[gen-update-json] 插件包：${block.version}` +
      `（${(block.size / 1024 / 1024).toFixed(1)} MB${n ? `，${n} 个分片` : ''}）`,
  );
  pluginsBlocks.push(block);
}
const pluginsBlock =
  pluginsBlocks.length === 0 ? null : pluginsBlocks.length === 1 ? pluginsBlocks[0] : pluginsBlocks;

// ---------------------------------------------------------------------------
// 3) 组装 JSON
// ---------------------------------------------------------------------------
const notes = arg('notes', `${version} 版本更新`);
const feed = {
  version,
  channel,
  releaseDate: new Date().toISOString().slice(0, 10),
  notes,
  mandatory: flag('mandatory'),
  minSupportedVersion: arg('min-version', ''),
};

if (hotBlock) feed.hot = hotBlock;
if (runtimeBlock) feed.runtime = runtimeBlock;
if (pluginsBlock) feed.plugins = pluginsBlock;
// --hot-only：不放安装包（纯热更新 feed，可以托管在免费的静态空间里 —— 单个 tar 仅 220KB）
// --setup-url：安装包挂外链（feed 只记 URL，包本体不进 Pages 托管目录）
if (!flag('hot-only')) {
  const entry = { url: setupUrl || `${baseUrl}/${setupName}` };
  // sha256 / size 都**只在确实知道时才写**。
  // 写一个假的 0 比不写更危险：客户端会拿它当期望值做校验，必然失败，
  // 而且报错信息会指向「大小不符」这种误导性的方向。
  // 客户端对缺失字段本来就有兜底（HEAD 探测 content-length / 按 size 校验可选）。
  if (setupSha) entry.sha256 = setupSha;
  const size = setupBuf ? setupBuf.length : setupSizeArg;
  if (size) entry.size = size;
  feed.files = { 'win32-x64': entry };
}
if (!feed.minSupportedVersion) delete feed.minSupportedVersion;

// 顶层放一份 channel 只为排查方便（curl 一下就知道这是哪个通道的 feed）；
// 客户端不读它 —— 通道由「请求哪个文件」决定。

// ---------------------------------------------------------------------------
// 4) 落盘（可选：把产物复制到同一目录，方便整目录上传）
// ---------------------------------------------------------------------------
const outDir = path.dirname(outFile);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(feed, null, 2), 'utf8');

if (stage) {
  // 安装包不 stage 的两种情况：外链模式（url 已指向外部）与 --hot-only（feed 不含
  // 安装包——否则每次生成都会把 200MB+ 的包复制进 dist/update，Pages 部署直接超限）。
  // 热更/运行时包照常（它们是要传 Pages 的）。
  const stageList = [setupUrl || hotOnly ? null : setupFile, ...stagedHot, ...stagedRuntime].filter(
    Boolean,
  );
  for (const src of stageList) {
    const dst = path.join(outDir, path.basename(src));
    if (path.resolve(src) !== path.resolve(dst)) fs.copyFileSync(src, dst);
  }
}

const mb = (n) => (n / 1024 / 1024).toFixed(1);
console.log(`[gen-update-json] 已生成 ${path.relative(root, outFile)}`);
console.log(`  版本      : ${version}`);
if (setupUrl) {
  console.log(
    `  安装包    : 外链 ${setupUrl}` +
      (setupBuf ? `（哈希取自本地 ${setupName}）` : '（本地无包，未带哈希）'),
  );
} else if (setupBuf) {
  console.log(`  安装包    : ${setupName}（${mb(setupBuf.length)} MB）`);
} else {
  console.log('  安装包    : 未包含（--hot-only 或本地无包）');
}
if (hotBlock) {
  const list = Array.isArray(hotBlock) ? hotBlock : [hotBlock];
  for (const h of list) {
    console.log(
      `  热更新包  : v${h.version}（最低支持 ${h.baseVersion}，` +
        `${(h.size / 1024).toFixed(1)} KB）`,
    );
  }
} else {
  console.log('  热更新包  : 未包含（需要时加 --hot build/hot-shell-<版本>.tar）');
}
console.log('');
console.log('部署：把下面这些文件放到同一目录（URL 前缀 = ' + baseUrl + '）');
const files = fs.readdirSync(outDir).filter((n) => fs.statSync(path.join(outDir, n)).isFile());
for (const n of files) console.log(`  · ${n}`);
console.log('');
console.log(JSON.stringify(feed, null, 2));
