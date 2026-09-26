// 打包产物自检：确认 dist/win-unpacked 真的可以拿去装。
//
// 为什么需要它：这条链路有几个「静默出错」的坑，光看 electron-builder 退出码发现不了 ——
//   * `--prepackaged` 不会更新 app.asar（改了代码却只重跑 nsis，包里还是旧的）
//   * electron-builder 不复制 extraResources 里的 node_modules（漏跑 prepare-payload 就没有运行时）
//   * 运行时 tar 与清单必须同批次（只重打一半 → 安装期解压缺文件）
//   * 版本号必须 asar 内与产物文件名一致（否则出现「装了新版但显示旧版」）
//   * 项目 package.json 曾被莫名截断，导致 build 配置丢失
//
// 用法：node scripts/verify-package.mjs [unpackedDir]
// 退出码 0 = 全部通过；1 = 有失败项（会打印 FAIL 行）。

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const unpacked = path.resolve(process.argv[2] ?? path.join(projectRoot, 'dist', 'win-unpacked'));
const resources = path.join(unpacked, 'resources');

const failures = [];
const ok = (label, detail) => console.log(`  PASS  ${label}${detail ? '  — ' + detail : ''}`);
const bad = (label, detail) => {
  failures.push(label);
  console.log(`  FAIL  ${label}${detail ? '  — ' + detail : ''}`);
};

console.log(`自检目标：${unpacked}\n`);

// ── 1) app.asar 与版本 ───────────────────────────────────────────────────────
const asarPath = path.join(resources, 'app.asar');
let asarVersion = null;
if (!fs.existsSync(asarPath)) {
  bad('app.asar 存在', asarPath);
} else {
  try {
    const asar = require('@electron/asar');
    const pkg = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'));
    asarVersion = pkg.version;
    ok('app.asar 可读', `version=${pkg.version}`);
    if (pkg.main === 'out/main/index.js') ok('asar main 入口正确');
    else bad('asar main 入口', String(pkg.main));
    // 关键：桌面外壳自己的代码必须在 asar 里（写错就会「补丁不生效」）。
    // 注意：@electron/asar 在 Windows 上按 path.sep（\）拆路径，必须用 path.join，
    // 写死 'out/main/index.js' 会误报 "was not found in this archive"。
    // 1.1.0 起 index.js 只是引导器，真正的实现都在 boot.js 里。
    const mainBundle = asar
      .extractFile(asarPath, path.join('out', 'main', 'boot.js'))
      .toString('utf8');
    if (mainBundle.includes('installPlugins') || mainBundle.includes('桌面适配插件')) {
      ok('asar 含插件安装逻辑');
    } else {
      bad('asar 含插件安装逻辑', 'out/main/boot.js 里找不到安装插件的痕迹');
    }
    // 1.0.9 起运行时靠多线程解压器落位，asar 里必须带上这条路（否则首启动兜底是单线程的）。
    // 注意：这段逻辑编译后在 out/main/runtime-installer.js，不在 index.js 里。
    const runtimeBundle = asar
      .extractFile(asarPath, path.join('out', 'main', 'runtime-installer.js'))
      .toString('utf8');
    if (runtimeBundle.includes('多线程解压') || runtimeBundle.includes('extract-runtime')) {
      ok('asar 含多线程解压逻辑');
    } else {
      bad('asar 含多线程解压逻辑', 'runtime-installer.js 里找不到多线程解压的痕迹 —— asar 可能是旧版');
    }

    // 热更新：updater.js 必须在 asar 里，且能读到云端 JSON 的字段约定
    const updaterBundle = asar
      .extractFile(asarPath, path.join('out', 'main', 'updater.js'))
      .toString('utf8');
    if (updaterBundle.includes('feedUrl') && updaterBundle.includes('compareVersions')) {
      ok('asar 含热更新逻辑');
    } else {
      bad('asar 含热更新逻辑', 'out/main/updater.js 内容不完整');
    }

    // 入口必须是「引导器」：它决定加载内置壳还是用户数据目录里的热更新壳
    const entryBundle = asar
      .extractFile(asarPath, path.join('out', 'main', 'index.js'))
      .toString('utf8');
    const bootBundle = asar
      .extractFile(asarPath, path.join('out', 'main', 'boot.js'))
      .toString('utf8');
    if (entryBundle.includes('resolveHotShell') && bootBundle.includes('activeHotShell')) {
      ok('入口为热更新引导器');
    } else {
      bad('入口为热更新引导器', 'out/main/index.js 不是引导器，或 boot.js 缺热壳识别');
    }

    const hotShellBundle = asar
      .extractFile(asarPath, path.join('out', 'main', 'hot-shell.js'))
      .toString('utf8');
    if (hotShellBundle.includes('selfHotShell') && hotShellBundle.includes('installHotShell')) {
      ok('asar 含热壳管理模块');
    } else {
      bad('asar 含热壳管理模块', 'out/main/hot-shell.js 内容不完整');
    }
  } catch (err) {
    bad('app.asar 解析', String(err.message ?? err));
  }
}

// ── 2) 项目 package.json 完整性（防被截断） ──────────────────────────────────
try {
  const projectPkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  if (projectPkg.scripts && projectPkg.build && projectPkg.build.extraResources) {
    ok('项目 package.json 完整', `${Object.keys(projectPkg.scripts).length} 个脚本`);
  } else {
    bad('项目 package.json 完整', 'scripts / build / extraResources 有缺失 —— 可能被截断了');
  }
  if (asarVersion && projectPkg.version !== asarVersion) {
    bad('版本一致', `项目 ${projectPkg.version} ≠ asar ${asarVersion}`);
  } else if (asarVersion) {
    ok('版本一致', asarVersion);
  }
} catch (err) {
  bad('项目 package.json 解析', String(err.message ?? err));
}

// ── 3) 运行时载荷：安装包里只带一个 tar，安装期由多线程解压器展开 ────────────
// 旧做法（把 3.5 万个文件注入 win-unpacked）会让 NSIS 单线程写文件，实测安装要 110 秒，
// 且杀软实时扫描下会静默丢文件。现在改为「一个 tar + 安装期并行展开」。
const runtimeRoot = path.join(resources, 'dsh-runtime');
if (fs.existsSync(runtimeRoot)) {
  bad(
    '载荷不含运行时目录',
    `${runtimeRoot} 仍存在 —— 安装会退化成单线程写 3.5 万个小文件。请先执行 node scripts/prepare-payload.mjs`,
  );
} else {
  ok('载荷不含运行时目录', '安装期由多线程解压器展开');
}

for (const [label, file] of [
  ['运行时 tar（单文件承载 3.5 万文件）', 'dsh-runtime.tar'],
  ['运行时文件清单', 'dsh-runtime-manifest.json'],
  ['多线程解压器', 'extract-runtime.cjs'],
  ['解压器入口（安装期由 NSIS 调用）', 'extract-runtime.cmd'],
  ['更新源配置（热更新用）', 'update-config.json'],
]) {
  if (fs.existsSync(path.join(resources, file))) ok(label);
  else bad(label, path.join(resources, file));
}

// tar 与清单必须同批次（防「换了运行时却只重打了其中一半」）
const tarPath = path.join(resources, 'dsh-runtime.tar');
const manifestPath = path.join(resources, 'dsh-runtime-manifest.json');
const extractorPath = path.join(resources, 'extract-runtime.cjs');
if (fs.existsSync(tarPath) && fs.existsSync(manifestPath) && fs.existsSync(extractorPath)) {
  const probe = spawnSync(process.execPath, [extractorPath, '--tar', tarPath, '--index-only'], {
    encoding: 'utf8',
  });
  const line = (probe.stdout || '').split(/\r?\n/).find((l) => l.startsWith('INDEX '));
  if (!line) {
    bad('tar 索引可解析', (probe.stderr || '').trim() || '解压器没有输出索引');
  } else {
    const index = JSON.parse(line.slice('INDEX '.length));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (index.files === manifest.fileCount) {
      ok('tar 与清单同批次', `${index.files} 个文件`);
    } else {
      bad(
        'tar 与清单同批次',
        `tar 里 ${index.files} 个 ≠ 清单 ${manifest.fileCount} 个 —— 需重新执行 pack-runtime + gen-manifest`,
      );
    }
    if (manifest.fileCount > 30000) ok('清单规模合理', `${manifest.fileCount} 个文件`);
    else bad('清单规模合理', `只有 ${manifest.fileCount} 个文件，运行时可能不完整`);
  }
}

// ── 4) 桌面适配补丁 + 插件 ───────────────────────────────────────────────────
const patchFile = path.join(resources, 'desktop-patch.yml');
if (!fs.existsSync(patchFile)) {
  bad('桌面适配补丁存在', patchFile);
} else {
  const patch = fs.readFileSync(patchFile, 'utf8');
  if (patch.includes('@dsh-desktop/directory-picker')) ok('补丁指向自有目录选择后端');
  else bad('补丁指向自有目录选择后端', '补丁里找不到 @dsh-desktop/directory-picker');
  if (/id:\s*directory-picker\s*\r?\n\s*disabled:\s*true/.test(patch)) ok('补丁已禁用默认选择器');
  else bad('补丁已禁用默认选择器', 'directory-picker 那行没被 disabled');
  if (patch.includes('ui-directory-picker-browse')) ok('补丁已挂载浏览界面');
  else bad('补丁已挂载浏览界面', '缺少 ui-directory-picker-browse 行');
}

const pluginIndex = path.join(resources, 'dsh-plugins', 'directory-picker', 'lib', 'index.js');
if (!fs.existsSync(pluginIndex)) {
  bad('插件已随包分发', pluginIndex);
} else {
  const src = fs.readFileSync(pluginIndex, 'utf8');
  if (src.includes('export const COMPUTER')) ok('插件为最新版（含 此电脑 虚拟根）');
  else bad('插件为最新版', 'index.js 里没有 COMPUTER 虚拟根 —— 是修复前的旧版本');
}

// ── 5) 图标等杂项 ────────────────────────────────────────────────────────────
for (const file of ['tray.png', 'icon.ico']) {
  if (fs.existsSync(path.join(resources, file))) ok(`资源 ${file}`);
  else bad(`资源 ${file}`, path.join(resources, file));
}

// ── 6) dist 里的安装包 ───────────────────────────────────────────────────────
const distDir = path.join(projectRoot, 'dist');
const installers = fs
  .readdirSync(distDir)
  .filter((n) => /\.exe$/i.test(n) && !n.includes('uninstall'))
  .map((n) => ({
    name: n,
    size: fs.statSync(path.join(distDir, n)).size,
    mtime: fs.statSync(path.join(distDir, n)).mtimeMs,
  }))
  // 优先取版本号与 asar 一致的那个：不要按体积取（新版把 3.5 万个小文件换成一个 tar 后，
  // 包体反而更小，按体积排序会挑到旧版本的安装包）
  .sort((a, b) => {
    if (asarVersion) {
      const av = a.name.includes(asarVersion) ? 0 : 1;
      const bv = b.name.includes(asarVersion) ? 0 : 1;
      if (av !== bv) return av - bv;
    }
    return b.mtime - a.mtime;
  });
if (installers.length === 0) {
  bad('找到安装包', 'dist 下没有 .exe');
} else {
  const newest = installers[0];
  ok('找到安装包', `${newest.name}  ${(newest.size / 1024 / 1024).toFixed(1)} MB`);
  if (asarVersion && !newest.name.includes(asarVersion)) {
    bad('安装包版本与 asar 一致', `${newest.name} 不含 ${asarVersion}`);
  } else if (asarVersion) {
    ok('安装包版本与 asar 一致', asarVersion);
  }
}

console.log('');
if (failures.length === 0) {
  console.log('自检通过：这个产物可以拿去安装。');
  process.exit(0);
}
console.log(`自检失败 ${failures.length} 项：`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
