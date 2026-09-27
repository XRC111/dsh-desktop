// 准备 NSIS 载荷：让安装包「只落地一个 tar」，而不是 3.5 万个运行时文件。
//
// 背景（为什么改了做法）：
//   旧做法是把 resources/dsh-runtime 用 robocopy 注入 dist/win-unpacked，
//   好让运行时的 3.5 万个文件在「安装过程」中落地。但 NSIS 是单线程逐个写文件，
//   实测一次安装要 110 秒，而且杀软实时扫描下还会静默丢文件（实测丢 25.6%）。
//
// 新做法：
//   1) 运行时只以 build/dsh-runtime.tar（未压缩 tar）随包分发；
//   2) 安装包里不再出现 resources/dsh-runtime 目录（文件数 3.5 万 → 数百）；
//   3) 安装期由 resources/extract-runtime.cmd 调用多线程解压器并行展开，
//      装完即完整可用；首次启动的自检/修复也复用同一实现。
//
// 本脚本职责：
//   - 校验 tar / 清单 / 解压器都在 build 与 win-unpacked 里齐备
//   - 清掉 win-unpacked 里可能残留的运行时目录（旧版本构建留下的）
//   - 打印载荷文件数，方便确认「安装包内确实只有几百个文件」
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const winUnpacked = path.join(root, 'dist', 'win-unpacked');
const resources = path.join(winUnpacked, 'resources');
const runtimeTree = path.join(resources, 'dsh-runtime');

function die(msg) {
  console.error(`[prepare-payload] ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(winUnpacked)) {
  die('未找到 dist/win-unpacked，请先执行 electron-builder --win dir --x64');
}

// ── 1) 构建期产物 ────────────────────────────────────────────────────────────
for (const [label, file] of [
  ['运行时 tar', path.join(root, 'build', 'dsh-runtime.tar')],
  ['运行时清单', path.join(root, 'build', 'dsh-runtime-manifest.json')],
]) {
  if (!fs.existsSync(file)) {
    die(
      `缺少${label} ${file}\n` +
        '  请先执行：node scripts/pack-runtime.mjs && node scripts/gen-runtime-manifest.mjs',
    );
  }
}

// ── 2) 清掉残留的运行时目录（旧构建注入的 / 上次构建留下的） ────────────────
if (fs.existsSync(runtimeTree)) {
  console.log('[prepare-payload] 移除 win-unpacked 内残留的运行时目录…');
  const started = Date.now();
  const emptyDir = fs.mkdtempSync(path.join(process.env.TEMP || root, 'dsh-empty-'));
  // robocopy /MIR 用空目录镜像过去 = 多线程删除，比 fs.rmSync 快很多
  const res = spawnSync(
    'robocopy',
    [emptyDir, runtimeTree, '/MIR', '/MT:32', '/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1'],
    { stdio: 'ignore' },
  );
  try {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  // robocopy 退出码 < 8 视为成功（0-7 都是正常语义）
  if ((res.status ?? 1) >= 8) {
    die(`robocopy 清理失败（exit=${res.status}）→ ${runtimeTree}`);
  }
  try {
    fs.rmdirSync(runtimeTree);
  } catch {
    /* 目录非空或已被删除，忽略 */
  }
  console.log(`[prepare-payload] 已清理（${((Date.now() - started) / 1000).toFixed(1)}s）`);
}

// ── 3) 载荷齐备性校验 ────────────────────────────────────────────────────────
const required = [
  ['运行时 tar', 'dsh-runtime.tar'],
  ['运行时清单', 'dsh-runtime-manifest.json'],
  ['多线程解压器', 'extract-runtime.cjs'],
  ['解压器入口', 'extract-runtime.cmd'],
  ['桌面适配补丁', 'desktop-patch.yml'],
  ['托盘图标', 'tray.png'],
  ['应用图标', 'icon.ico'],
];
const missing = required.filter(([, f]) => !fs.existsSync(path.join(resources, f)));

// 桌面适配插件必须随包分发（热更只换 out/，插件到不了已装用户，所以装机这份是基线）
for (const [label, rel] of [
  ['目录选择插件', path.join('dsh-plugins', 'directory-picker', 'package.json')],
  ['桌面适配面板', path.join('dsh-plugins', 'shell', 'package.json')],
  ['更新面板', path.join('dsh-plugins', 'updater', 'package.json')],
]) {
  if (!fs.existsSync(path.join(resources, rel))) missing.push([label, rel]);
}
if (missing.length > 0) {
  die(
    'win-unpacked/resources 缺以下载荷（检查 package.json 的 build.extraResources）：\n' +
      missing.map(([label, f]) => `  - ${label}: ${f}`).join('\n'),
  );
}

// ── 4) 统计安装包内的文件数 ──────────────────────────────────────────────────
function countFiles(dir) {
  let n = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(abs);
      else n++;
    }
  }
  return n;
}

const files = countFiles(winUnpacked);
const mb = (fs.statSync(path.join(resources, 'dsh-runtime.tar')).size / 1024 / 1024).toFixed(1);

console.log(`[prepare-payload] 载荷就绪：安装包内 ${files} 个文件（tar ${mb} MB 单文件承载运行时）`);
if (files > 20000) {
  console.warn(
    `[prepare-payload] 警告：文件数仍然高达 ${files}，运行时目录可能没清干净，安装会很慢。`,
  );
}
