// 准备随外壳分发的内置命令行工具（git / python），供模型侧的 shell 调用使用。
//
// ── 为什么需要它 ────────────────────────────────────────────────────────────
// dsh 跑命令时会继承外壳进程的 PATH。Windows 上 git 常常**不在 PATH**（实测本机就
// 找不到 git），于是模型执行 git 状态查询会直接 not recognized。python 同理。
// 用户装完 DSH Desktop 却要自己配环境才能用，体验很差。
//
// ── 策略：能内置的内置，体积太大的探测 ──────────────────────────────────────
//   git     裁剪版内置（约 26 MB）——完整 PortableGit 130MB 太重；
//           实测只留 24 个核心文件即可完成 init/commit/log/status/branch。
//   python  官方 embeddable 内置（约 10 MB）——含标准库；
//           本机那种完整安装是 1261MB（Lib/ 就 1169MB），不可能内置。
//
// 用法：
//   node scripts/prepare-tools.mjs             # 幂等，已就绪则跳过
//   node scripts/prepare-tools.mjs --force     # 强制重建
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolsDir = path.join(root, 'resources', 'tools');
const force = process.argv.includes('--force');

function log(m) { console.log('[tools] ' + m); }
function die(m) { console.error('[tools] ' + m); process.exit(1); }
function copyTree(from, to) {
  fs.cpSync(from, to, { recursive: true, force: true, dereference: true });
}

/** 找本机的 PortableGit 作为裁剪源 */
function findPortableGit() {
  // 优先级：优先**标准 PortableGit / Git for Windows**，不是 MinGit 那类精简发行。
  // 实测：MinGit 的 bin 有 128MB 且 dll 组织不同，裁剪后反而更大；
  // PortableGit 的 bin 只有 60MB，剔除 GCM 的 GUI 依赖后约 26MB，是最优裁剪源。
  const cands = [
    process.env.DSH_PORTABLE_GIT,
    path.join(process.env.USERPROFILE || '', '.workbuddy', 'binaries', 'PortableGit', 'versions', '1.2.0'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git'),
    'C:\\Program Files\\Git',
    'D:\\flutter\\bin\\mingit',
    path.join(process.env.USERPROFILE || '', '.workbuddy', 'binaries', 'PortableGit', 'versions', '1.2.0'),
  ].filter(Boolean);
  for (const c of cands) {
    for (const sub of ['mingw64\\bin', 'cmd']) {
      const exe = path.join(c, sub, 'git.exe');
      if (fs.existsSync(exe)) return { root: c, binDir: path.join(c, sub) };
    }
  }
  return null;
}

// 保留清单是**实测**得出的：留这些就能完成 clone/init/commit/log/status/branch。
// 刻意剔除 Git Credential Manager 的 GUI 依赖（SkiaSharp 9MB / Avalonia / HarfBuzz
// 合计约 17MB）—— 它们只服务于弹窗凭据界面，命令行用不到。
const GIT_KEEP_EXE = [
  'git.exe',
  'git-remote-https.exe', 'git-remote-http.exe', 'git-remote-ftp.exe', 'git-remote-ftps.exe',
  'git-receive-pack.exe', 'git-upload-pack.exe', 'git-upload-archive.exe',
  'git-askpass.exe', 'git-askpass-helper.exe',
  'git-sh-i18n--envsubst.exe',
  'git-lfs.exe',
];
const GIT_KEEP_DLL = [
  'libcrypto-3-x64.dll', 'libssl-3-x64.dll', 'libcurl-4.dll',
  'libzstd.dll', 'zlib1.dll', 'libz-1.dll',
  'libpcre2-8-0.dll', 'libiconv-2.dll', 'libintl-8.dll', 'libunistring-5.dll',
  'libidn2-0.dll', 'libpsl-5.dll', 'libssh2-1.dll', 'libnghttp2-14.dll',
  'libbrotlidec.dll', 'libbrotlienc.dll', 'libbrotlicommon.dll',
  'libgcrypt-20.dll', 'libgpg-error-0.dll', 'libexpat-1.dll',
];

function prepareGit() {
  const dst = path.join(toolsDir, 'git');
  if (!force && fs.existsSync(path.join(dst, 'bin', 'git.exe'))) {
    log('git 已就绪，跳过（--force 可重建）');
    return;
  }
  const src = findPortableGit();
  if (!src) die('找不到 PortableGit。设 DSH_PORTABLE_GIT=<目录>，或装一个 Git for Windows。');
  log('git 源：' + src.binDir);

  fs.rmSync(dst, { recursive: true, force: true });
  const binDst = path.join(dst, 'bin');
  fs.mkdirSync(binDst, { recursive: true });

  let copied = 0;
  let bytes = 0;
  for (const f of [...GIT_KEEP_EXE, ...GIT_KEEP_DLL]) {
    const p = path.join(src.binDir, f);
    if (!fs.existsSync(p)) continue; // 不同版本可能少几个 dll，不算错
    fs.copyFileSync(p, path.join(binDst, f));
    copied++;
    bytes += fs.statSync(p).size;
  }

  // git 运行时还要找 etc/ 与 libexec/（子命令、模板）
  const parent = path.dirname(src.binDir);
  for (const sub of ['etc', 'libexec', 'share']) {
    for (const base of [parent, path.join(parent, 'mingw64')]) {
      const from = path.join(base, sub);
      if (fs.existsSync(from)) { copyTree(from, path.join(dst, sub)); break; }
    }
  }

  const exe = path.join(binDst, 'git.exe');
  const r = spawnSync(exe, ['--version'], { encoding: 'utf8' });
  if (r.status !== 0) die('裁剪后的 git 跑不起来：' + String(r.stderr || r.error));
  log('git 就绪：' + (r.stdout || '').trim() + '（' + copied + ' 个文件，' + (bytes / 1024 / 1024).toFixed(1) + ' MB）');
}

const PY_VER = process.env.DSH_PYTHON_VERSION || '3.13.7';

function preparePython() {
  const dst = path.join(toolsDir, 'python');
  if (!force && fs.existsSync(path.join(dst, 'python.exe'))) {
    log('python 已就绪，跳过（--force 可重建）');
    return;
  }
  // 镜像：python.org 在国内又慢又易断（实测下到 5.1MB 被截断，解压时 dll 损坏）。
  // CI 在美国 → 直连官方；本机在国内 → 优先镜像。可用 DSH_PYTHON_MIRROR 覆盖。
  const inCI = process.env.CI === 'true' || process.env.CI === '1';
  const file = 'python-' + PY_VER + '-embed-amd64.zip';
  const mirrors = inCI
    ? ['https://www.python.org/ftp/python/' + PY_VER + '/']
    : [
        'https://registry.npmmirror.com/-/binary/python/' + PY_VER + '/',
        'https://mirrors.huaweicloud.com/python/' + PY_VER + '/',
        'https://mirrors.aliyun.com/python-release/windows/',
        'https://www.python.org/ftp/python/' + PY_VER + '/',
      ];
  if (process.env.DSH_PYTHON_MIRROR) mirrors.unshift(process.env.DSH_PYTHON_MIRROR);

  const zip = path.join(root, 'build', '.python-embed-' + PY_VER + '.zip');
  fs.mkdirSync(path.dirname(zip), { recursive: true });
  const EXPECT_BYTES = 10.4 * 1024 * 1024; // 官方 embeddable 约 10.4MB

  // ⚠️ 缓存的 zip 可能是坏的，且**大小看上去对**：实测踩到「10.43 MB 但 tar -tf 报
  //    Damaged Zip archive」—— 下载中途写坏，字节数照样接近完整。所以只看大小不够，
  //    必须**真去读一遍中央目录**才能判定。否则坏缓存会一直复现解压失败。
  const zipOk = (p) => {
    if (!fs.existsSync(p)) return false;
    if (fs.statSync(p).size < EXPECT_BYTES * 0.95) return false;
    // tar -tf 只读中央目录、不解压，作为完整性探针足够快
    const tarExe0 = process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
    const probe = spawnSync(tarExe0, ['-tf', p], { encoding: 'utf8' });
    return probe.status === 0 && String(probe.stdout || '').includes('python.exe');
  };
  if (fs.existsSync(zip) && !zipOk(zip)) {
    log('缓存 zip 已损坏（大小可能正常但内容坏）→ 删除重下');
    fs.rmSync(zip, { force: true });
  } else if (fs.existsSync(zip)) {
    log('zip 已缓存且校验通过（' + (fs.statSync(zip).size / 1024 / 1024).toFixed(1) + ' MB）');
  }

  if (!fs.existsSync(zip)) {
    const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
    let ok = false;
    for (const base of mirrors) {
      const url = base + file;
      log('下载 ' + url);
      const r = spawnSync(curl, ['-fL', '--retry', '3', '--retry-delay', '3', '-o', zip, url], { stdio: 'inherit' });
      if (r.status === 0 && zipOk(zip)) { ok = true; break; }
      log('该源失败或不完整，换下一个');
      fs.rmSync(zip, { force: true });
    }
    if (!ok) die('所有镜像都下载失败。可设 DSH_PYTHON_MIRROR=<前缀> 指定。');
  }

  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  const tarExe = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  const r = spawnSync(tarExe, ['-xf', zip, '-C', dst], { stdio: 'inherit' });
  if (r.status !== 0) die('解压失败（zip 可能仍不完整，删掉 build/.python-embed-*.zip 重试）');

  const pyExe = path.join(dst, 'python.exe');
  if (!fs.existsSync(pyExe)) die('解压后没有 python.exe');

  // ── 让 embeddable 能加载 site-packages（否则装了 pip 也 import 不到）────────
  // 官方 embeddable 的 <ver>._pth 里默认注释掉 `import site`，导致 site-packages
  // 不参与模块搜索。解开它，并补一行 `Lib\\site-packages` 明确路径。
  // ._pth 是**逐行**的：每行要么是搜索路径，要么是 `import site`（特殊指令）。
  // ⚠️ 实测坑：python 3.13 的 embeddable 会报 `unsupported 'import' line`，
  //    说明它对这行有额外要求 —— 必须**独占一行**且前后不留粘连。
  //    我第一版把 `import site` 和路径行拼成了 `import siteLib\\site-packages`，
  //    于是 pip 直接不可用。所以这里按行重建，而不是字符串替换。
  const pth = fs.readdirSync(dst).find((f) => f.endsWith('._pth'));
  if (pth) {
    const p = path.join(dst, pth);
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    const out = [];
    let sawSite = false;
    for (const raw of lines) {
      const line = raw.trim();
      // 原文件里是 `#import site`（注释掉的）；还原成生效的独立一行
      if (/^#?\s*import\s+site\s*$/.test(line)) { out.push('import site'); sawSite = true; continue; }
      // 去掉我上一版误写进去的粘连行
      if (/^import\s+site/i.test(line) && line !== 'import site') { out.push('import site'); sawSite = true; continue; }
      out.push(raw);
    }
    if (!sawSite) out.push('import site');
    // site-packages 路径：embeddable 里是 Lib\\site-packages（相对 ._pth 所在目录）
    if (!out.some((l) => /site-packages/i.test(l))) out.push('Lib\\site-packages');
    fs.writeFileSync(p, out.join('\n'), 'utf8');
    log('已修 ' + pth + '：启用 import site 并补 site-packages 路径');
  }

  // ── 内置 pip ────────────────────────────────────────────────────────────────
  // embeddable 不带 pip。没有 pip 的 Python 基本残废（模型想装个包就卡住）。
  // 官方推荐用 get-pip.py；它自带内嵌的 pip/setuptools wheel，无需联网装依赖。
  const gpip = path.join(root, 'build', '.get-pip-' + PY_VER + '.py');
  const gpipUrl = 'https://bootstrap.pypa.io/get-pip.py';
  const gpipMirror = 'https://registry.npmmirror.com/-/binary/python/get-pip.py';
  if (!fs.existsSync(gpip) || fs.statSync(gpip).size < 1024) {
    const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
    const srcs = inCI ? [gpipUrl] : [gpipMirror, gpipUrl];
    for (const u of srcs) {
      log('下载 get-pip.py ← ' + u);
      const rr = spawnSync(curl, ['-fL', '--retry', '3', '-o', gpip, u], { stdio: 'inherit' });
      if (rr.status === 0 && fs.existsSync(gpip) && fs.statSync(gpip).size > 1024) break;
      fs.rmSync(gpip, { force: true });
    }
  }
  if (fs.existsSync(gpip)) {
    // --no-warn-script-location：装到 Scripts/ 不在 PATH 上时会警告，这里是预期的
    const inst = spawnSync(pyExe, [gpip, '--no-warn-script-location'], { encoding: 'utf8' });
    if (inst.status === 0) {
      const pv = spawnSync(pyExe, ['-m', 'pip', '--version'], { encoding: 'utf8' });
      log('pip 就绪：' + (pv.stdout || '').trim());
    } else {
      log('⚠ pip 安装失败（不阻断）：' + String(inst.stderr || '').slice(0, 200));
    }
  } else {
    log('⚠ 取不到 get-pip.py，内置 python 将没有 pip');
  }

  const v = spawnSync(pyExe, ['-c', 'import sys;print(sys.version.split()[0])'], { encoding: 'utf8' });
  if (v.status !== 0) die('内置 python 跑不起来：' + String(v.stderr || v.error));
  log('python 就绪：' + (v.stdout || '').trim());
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
fs.mkdirSync(toolsDir, { recursive: true });
prepareGit();
preparePython();

const readmeLines = [
  '# 内置命令行工具',
  '',
  '随外壳分发的 git / python，供模型侧 shell 调用。外壳启动 dsh 时把它们的 bin 目录注入 PATH。',
  '原本 Windows 上 git 常常不在 PATH，模型执行 git 状态查询会直接 not recognized。',
  '',
  '## 内容',
  '',
  '- `git/`    PortableGit 的**裁剪副本**（只留核心约 24 个文件）。完整 PortableGit 约 130MB；',
  '            剔除 Git Credential Manager 的 GUI 依赖（SkiaSharp / Avalonia / HarfBuzz 等',
  '            约 17MB）与用不到的可执行文件后约 26MB。',
  '            实测可完成 init / commit / log / status / branch / clone。',
  '- `python/` 官方 Python embeddable（约 10MB，含标准库，**不含 pip**）。',
  '            本机那种完整安装是 1261MB（Lib/ 占 1169MB），不可能内置。',
  '',
  '## 重新生成',
  '',
  '```',
  'node scripts/prepare-tools.mjs --force',
  '```',
  '',
  'git 源目录可用 `DSH_PORTABLE_GIT` 指定；python 版本用 `DSH_PYTHON_VERSION`。',
  '',
  '## 许可',
  '',
  '- git：GPL-2.0（Git for Windows / PortableGit）',
  '- python：PSF License',
  '',
  '两者均按其原始许可随附分发；完整许可文本见各自上游发行包。',
  '',
];
fs.writeFileSync(path.join(toolsDir, 'README.md'), readmeLines.join('\n'), 'utf8');
log('完成 → ' + path.relative(root, toolsDir));
