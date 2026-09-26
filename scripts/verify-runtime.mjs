// 校验 dsh 运行时完整性与可用性（打包前 / 首次启动前的同类检查）
//   1) 目录结构与 bin 入口
//   2) 用 Electron 内置 Node 执行 dsh --version（等价于应用真实启动方式）
//   3) 原生模块在 Electron ABI 下能否加载
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = path.join(root, 'resources', 'dsh-runtime');
const DSH = '@deepseek-ai/dsh';

const problems = [];
const ok = [];

function fail(msg) {
  problems.push(msg);
}

// --- electron 可执行文件 ---
let electronExe;
try {
  electronExe = require('electron'); // 在 Node 下返回 electron 二进制路径
} catch {
  electronExe = null;
}

// --- 1) 目录结构 ---
const pkgDir = path.join(runtimeDir, 'node_modules', DSH);
if (!fs.existsSync(runtimeDir)) fail(`缺少运行时目录：${runtimeDir}`);
else if (!fs.existsSync(pkgDir)) fail(`缺少 dsh 包：${pkgDir}`);

let entry = null;
let dshVersion = null;
if (fs.existsSync(pkgDir)) {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  dshVersion = pkg.version;
  const bin = pkg.bin;
  const rel = typeof bin === 'string' ? bin : bin?.dsh ?? Object.values(bin ?? {})[0];
  if (!rel) fail('dsh 的 package.json 未声明 bin 字段');
  else {
    entry = path.resolve(pkgDir, rel);
    if (!fs.existsSync(entry)) fail(`bin 指向的入口不存在：${entry}`);
    else ok.push(`入口（读取 bin 字段）：${path.relative(runtimeDir, entry)}`);
  }
  ok.push(`dsh 版本：${dshVersion}`);
}

if (problems.length) {
  report();
  process.exit(1);
}

// --- 2) 用 Electron 内置 Node 跑 dsh --version ---
if (!electronExe || !fs.existsSync(electronExe)) {
  fail('未找到 Electron 二进制，请先执行 npm install');
} else {
  const res = spawnSync(electronExe, [entry, '--version'], {
    cwd: runtimeDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 60000,
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
  if (res.status === 0 && out) {
    ok.push(`Electron 内置 Node 可运行 dsh：${out.split('\n').pop().trim()}`);
  } else {
    fail(`用 Electron 内置 Node 运行 dsh 失败（exit=${res.status}）：${out.slice(0, 400)}`);
  }

  // --- 3) 原生模块 ---
  const probe = spawnSync(
    electronExe,
    [path.join(root, 'scripts', 'probe-native.cjs'), runtimeDir],
    {
      cwd: runtimeDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 120000,
    },
  );
  const probeOut = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.trim();
  for (const line of probeOut.split('\n')) {
    if (line.startsWith('OK ')) ok.push(`原生模块 ${line.slice(3)} 可加载`);
    else if (line.startsWith('FAIL ')) fail(`原生模块加载失败 → ${line.slice(5)}（需要 ABI 重编译）`);
  }
}

report();

function report() {
  console.log('\n=== 运行时校验 ===');
  for (const line of ok) console.log(`  ✓ ${line}`);
  for (const line of problems) console.log(`  ✗ ${line}`);
  if (problems.length) {
    console.log('\n结论：校验未通过。若为原生模块 ABI 问题，请执行 npm run rebuild:native');
    process.exitCode = 1;
  } else {
    console.log('\n结论：运行时可用（无需额外 Node 运行时）。');
  }
}
