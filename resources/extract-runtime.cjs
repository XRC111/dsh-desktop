#!/usr/bin/env node
/*
 * Harness 运行时「多线程」解压器 —— 安装期 / 首次启动 / 自动修复三处共用同一实现。
 *
 * 为什么需要它：
 *   运行时是 3.5 万个 npm 小文件（≈314 MB）。
 *   - NSIS 单线程逐个写文件：慢，而且在杀软实时扫描的机器上会静默丢文件（实测丢 25.6%）。
 *   - 系统 tar 单个进程顺序解压：同样是单线程写，慢。
 *   本脚本把 tar 的文件清单按「字节数」均分成几十个小批次（LPT 装箱），
 *   再用 N 个 tar 进程并行解压互不相交的子集 —— 写入并行、CPU 并行，
 *   解压完再逐个 stat 校验，缺失的自动重试补齐（所以不会再出现静默丢文件）。
 *
 * 用法：
 *   extract-runtime.cjs --tar <dsh-runtime.tar> --dest <resources 目录>
 *                       [--threads 8] [--only <缺失文件清单>] [--progress <进度文件>]
 *                       [--version-tag 1.0.9] [--force] [--quiet]
 *
 *   退出码：0 = 全部文件校验通过；1 = 失败（含校验后仍缺失）。
 *
 * 依赖：只有 Node（安装期由 Electron 内置 Node 以 ELECTRON_RUN_AS_NODE=1 充当）。
 *       有 Windows 自带 bsdtar（%SystemRoot%\System32\tar.exe，Win10 1803+）时用它多进程并行；
 *       Win7 没有 tar.exe，自动退回内置纯 JS 单线程解压（慢一些，但不需要任何外部程序）。
 *
 * 注：本文件必须以 CommonJS 纯 Node 运行，不得引用 electron / asar。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TAR_EXE =
  process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';

const BLOCK = 512;

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

function arg(name, fallback) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? fallback : v;
}
function flag(name) {
  return argv.includes('--' + name);
}

// 实测（12 核 / NVMe，3.5 万文件 / 240 MB）：
//   1 线程 92s → 4 线程 26s → 8 线程 19s → 16 线程 19s（I/O 已饱和）
// 因此默认 8 线程：再多的并发不再带来收益，反而更容易触发杀软扫描风暴。
const defaultThreads = () => Math.min(8, Math.max(4, os.cpus().length));

const opts = {
  tar: path.resolve(arg('tar', path.join(__dirname, 'dsh-runtime.tar'))),
  dest: path.resolve(arg('dest', __dirname)),
  rootName: arg('entry', 'dsh-runtime'),
  threads: Math.max(1, Math.min(32, parseInt(arg('threads', String(defaultThreads())), 10) || 8)),
  only: arg('only', ''),
  progress: arg('progress', ''),
  versionTag: arg('version-tag', ''),
  force: flag('force'),
  quiet: flag('quiet'),
};

function say(msg) {
  if (opts.quiet) return;
  process.stdout.write(`[extract-runtime] ${msg}\n`);
}
function fail(msg, code = 1) {
  process.stderr.write(`[extract-runtime] 错误：${msg}\n`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// tar 索引：只读头部块（跳过数据块），拿到「成员名 + 字节数」精确清单
// ---------------------------------------------------------------------------

function readString(buf, off, len) {
  const end = buf.indexOf(0, off);
  return buf
    .subarray(off, end >= off && end < off + len ? end : off + len)
    .toString('utf8')
    .trim();
}

function isZeroBlock(buf) {
  for (let i = 0; i < BLOCK; i++) if (buf[i] !== 0) return false;
  return true;
}

/** 解析 PAX 扩展头（typeflag 'x'）里的 path= 记录 */
function parsePaxPath(data) {
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) break;
    const len = parseInt(data.subarray(off, sp).toString('ascii'), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = data.subarray(sp + 1, off + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0 && record.slice(0, eq) === 'path') return record.slice(eq + 1);
    off += len;
  }
  return '';
}

function readTarIndex(file) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const block = Buffer.alloc(BLOCK);
  const entries = [];
  let pos = 0;
  let pendingName = ''; // GNU 'L' 长文件名 / PAX 'x' 扩展头为「下一个成员」准备的路径

  try {
    while (pos + BLOCK <= size) {
      if (fs.readSync(fd, block, 0, BLOCK, pos) < BLOCK) break;
      if (isZeroBlock(block)) break;

      const rawName = readString(block, 0, 100);
      const prefix = readString(block, 345, 155);
      const sizeField = readString(block, 124, 12).replace(/[^0-7]/g, '');
      const dataSize = parseInt(sizeField || '0', 8) || 0;
      const typeFlag = String.fromCharCode(block[156]);
      const dataBlocks = Math.ceil(dataSize / BLOCK);
      const dataStart = pos + BLOCK;

      if (typeFlag === 'L') {
        // GNU 长文件名：数据就是下一个成员的名字
        const buf = Buffer.alloc(dataSize);
        fs.readSync(fd, buf, 0, dataSize, dataStart);
        pendingName = buf.toString('utf8').replace(/\0+$/, '');
      } else if (typeFlag === 'x') {
        // POSIX PAX 扩展头
        const buf = Buffer.alloc(dataSize);
        fs.readSync(fd, buf, 0, dataSize, dataStart);
        const p = parsePaxPath(buf);
        if (p) pendingName = p;
      } else if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '' || typeFlag === '5' ||
                 typeFlag === '1' || typeFlag === '2') {
        const name = pendingName || (prefix ? `${prefix}/${rawName}` : rawName);
        // 目录条目（typeflag '5'）也一并收进来：文件清单只记文件，但 tar 全量解压
        // 会重建空目录，少了它们就与旧流程有细微差异。目录不参与校验（见 verify）。
        // 链接条目（'1' 硬链接 / '2' 符号链接）也要收：pnpm 布局的 node_modules 里
        // 大量包是符号链接，漏掉它们会让装出来的运行时**静默缺包**（实测 nightly
        // 10.4.8 起不来，报 Cannot find package 'semver'）。
        if (name) entries.push({ name, size: dataSize, dir: typeFlag === '5', link: typeFlag });
        pendingName = '';
      } else {
        pendingName = '';
      }

      pos = dataStart + dataBlocks * BLOCK;
    }
  } finally {
    fs.closeSync(fd);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// 进度
// ---------------------------------------------------------------------------

const state = {
  phase: 'start',
  doneBytes: 0,
  totalBytes: 0,
  doneFiles: 0,
  totalFiles: 0,
  threads: opts.threads,
  startedAt: Date.now(),
};

let lastProgressAt = 0;

function writeProgress(force = false) {
  if (!opts.progress) return;
  const now = Date.now();
  if (!force && now - lastProgressAt < 400) return;
  lastProgressAt = now;
  const pct = state.totalBytes > 0 ? (state.doneBytes / state.totalBytes) * 100 : 0;
  const payload = {
    phase: state.phase,
    percent: Number(pct.toFixed(1)),
    doneBytes: state.doneBytes,
    totalBytes: state.totalBytes,
    doneFiles: state.doneFiles,
    totalFiles: state.totalFiles,
    threads: state.threads,
    elapsedMs: now - state.startedAt,
  };
  try {
    fs.writeFileSync(opts.progress, JSON.stringify(payload), 'utf8');
  } catch {
    /* 进度文件写失败不影响解压本身 */
  }
}

// ---------------------------------------------------------------------------
// 分批：按字节数做 LPT 装箱，保证各批次体量均衡（避免某个大文件拖尾）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pure-JS tar extraction: for platforms WITHOUT System32\tar.exe (Windows 7).
// Slower than tar.exe (single thread) but zero external dependency.
// ---------------------------------------------------------------------------
function extractTarPure(tarFile, destDir, wanted, onProgress) {
  const fd = fs.openSync(tarFile, 'r');
  const fsize = fs.fstatSync(fd).size;
  const BLOCK = 512;
  const block = Buffer.alloc(BLOCK);
  let pos = 0;
  let pendingName = '';
  let doneBytes = 0, doneFiles = 0, lastSay = 0;
  const dirsMade = new Set();
  function ensureDir(d) { if (!dirsMade.has(d)) { fs.mkdirSync(d, { recursive: true }); dirsMade.add(d); } }
  try {
    while (pos + BLOCK <= fsize) {
      if (fs.readSync(fd, block, 0, BLOCK, pos) < BLOCK) break;
      if (isZeroBlock(block)) break;
      const rawName = readString(block, 0, 100);
      const prefix = readString(block, 345, 155);
      const sizeField = readString(block, 124, 12).replace(/[^0-7]/g, '');
      const dataSize = parseInt(sizeField || '0', 8) || 0;
      const typeFlag = String.fromCharCode(block[156]);
      const dataBlocks = Math.ceil(dataSize / BLOCK);
      const dataStart = pos + BLOCK;
      if (typeFlag === 'L') {
        const nb = Buffer.alloc(dataSize);
        fs.readSync(fd, nb, 0, dataSize, dataStart);
        pendingName = nb.toString('utf8').replace(/\0+$/, '');
        pos = dataStart + dataBlocks * BLOCK; continue;
      }
      if (typeFlag === 'x' || typeFlag === 'g') {
        // PAX 扩展头：真正的长名/非 ASCII 名在 path= 记录里，必须解析出来
        const pb = Buffer.alloc(dataSize);
        fs.readSync(fd, pb, 0, dataSize, dataStart);
        const p = parsePaxPath(pb);
        if (p && typeFlag === 'x') pendingName = p;
        pos = dataStart + dataBlocks * BLOCK; continue;
      }
      if (typeFlag !== '0' && typeFlag !== '\0' && typeFlag !== '' && typeFlag !== '5' &&
          typeFlag !== '1' && typeFlag !== '2') {
        pendingName = ''; pos = dataStart + dataBlocks * BLOCK; continue;
      }
      const name = pendingName || (prefix ? prefix + '/' + rawName : rawName);
      pendingName = '';
      if (wanted && !wanted.has(name)) { pos = dataStart + dataBlocks * BLOCK; continue; }
      if (typeFlag === '5') { ensureDir(path.join(destDir, name)); pos = dataStart + dataBlocks * BLOCK; continue; }
      // 链接条目：'2' 符号链接 / '1' 硬链接。pnpm 布局里 node_modules 大量用符号链接，
      // 漏掉就会**静默缺包**（实测 nightly 装完 dsh 起不来）。
      if (typeFlag === '1' || typeFlag === '2') {
        const linkName = readString(block, 157, 100);
        if (!linkName) { pendingName = ''; pos = dataStart + dataBlocks * BLOCK; continue; }
        const abs2 = path.join(destDir, name);
        ensureDir(path.dirname(abs2));
        try { fs.rmSync(abs2, { recursive: true, force: true }); } catch { /* 无则跳过 */ }
        if (typeFlag === '1') {
          // 硬链接：tar 里存的是「相对归档根」的名字，直接复制已解出的目标
          const srcAbs = path.join(destDir, linkName.replace(/^\.\//, ''));
          try { fs.copyFileSync(srcAbs, abs2); } catch { /* 目标还没解出来：留到下一轮 */ }
        } else {
          // 符号链接：tar 里存的目标可能是相对路径，也可能是**打包机的绝对路径**
          // （Windows 的 bsdtar 会写成 //?/D:/code/symtest/src/rt/real）—— 后者在目标机上
          // 根本不存在，直接照建就是断链。所以要把它归一到「树内相对路径」：
          //   去掉 //?/ 前缀与盘符，再从右往左找与**条目路径首段**重合的位置，
          //   那一段就是打包根在树内的对应物。
          let rel = linkName.replace(/^\/\/\?\//, '').replace(/\\/g, '/');
          if (/^[A-Za-z]:\//.test(rel)) {
            const segs = rel.replace(/^[A-Za-z]:\//, '').split('/').filter(Boolean);
            const firstSeg = name.split('/')[0];
            const at = segs.indexOf(firstSeg);
            const rootRel = at >= 0 ? segs.slice(at).join('/') : segs[segs.length - 1];
            rel = path.relative(path.dirname(abs2), path.join(destDir, rootRel)).replace(/\\/g, '/');
          }
          try {
            fs.symlinkSync(rel, abs2, 'file');
          } catch (e) {
            // Windows 非开发者模式/无权限时建不了符号链接：退化成复制目标内容（最稳的兜底）
            const tgt = path.resolve(path.dirname(abs2), rel);
            try {
              const st = fs.statSync(tgt);
              if (st.isDirectory()) fs.cpSync(tgt, abs2, { recursive: true, force: true });
              else fs.copyFileSync(tgt, abs2);
            } catch { /* 目标还没解出来：留到下一轮 */ }
          }
        }
        pos = dataStart + dataBlocks * BLOCK; continue;
      }
      const abs = path.join(destDir, name);
      ensureDir(path.dirname(abs));
      const out = fs.openSync(abs, 'w');
      try {
        let left = dataSize, at2 = dataStart;
        const buf2 = Buffer.alloc(1024 * 1024);
        while (left > 0) {
          const take = Math.min(buf2.length, left);
          if (fs.readSync(fd, buf2, 0, take, at2) !== take) throw new Error('short read: ' + name);
          fs.writeSync(out, buf2, 0, take);
          at2 += take; left -= take;
        }
      } finally { fs.closeSync(out); }
      doneBytes += dataSize; doneFiles++;
      pos = dataStart + dataBlocks * BLOCK;
      const now = Date.now();
      if (onProgress && now - lastSay > 500) { lastSay = now; onProgress(doneBytes, doneFiles); }
    }
  } finally { fs.closeSync(fd); }
  return { doneBytes: doneBytes, doneFiles: doneFiles };
}

function planBatches(entries, targetBatches) {
  const bins = Array.from({ length: Math.max(1, targetBatches) }, () => ({ bytes: 0, items: [] }));
  for (const e of [...entries].sort((a, b) => b.size - a.size)) {
    let best = bins[0];
    for (const b of bins) if (b.bytes < best.bytes) best = b;
    best.items.push(e);
    best.bytes += e.size;
  }
  return bins.filter((b) => b.items.length > 0);
}

// ---------------------------------------------------------------------------
// 并行执行
// ---------------------------------------------------------------------------

function runTarChunk(listFile) {
  return new Promise((resolve) => {
    const child = spawn(TAR_EXE, ['-xf', opts.tar, '-C', opts.dest, '-T', listFile], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });
    child.once('error', (err) => resolve({ code: -1, error: err.message }));
    child.once('exit', (code) => resolve({ code, error: stderr.slice(-400) }));
  });
}

async function runBatches(batches, tmpDir) {
  const lists = batches.map((b, i) => {
    const f = path.join(tmpDir, `batch-${i}.txt`);
    fs.writeFileSync(f, b.items.map((it) => it.name).join('\n'), 'utf8');
    return f;
  });

  let cursor = 0;
  const errors = [];
  const workers = Array.from({ length: Math.min(opts.threads, batches.length) }, async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= batches.length) return;
      const res = await runTarChunk(lists[idx]);
      if (res.code !== 0) errors.push(`batch#${idx} exit=${res.code} ${res.error || ''}`);
      state.doneBytes += batches[idx].bytes;
      state.doneFiles += batches[idx].items.filter((it) => !it.dir).length;
      state.phase = 'extract';
      writeProgress();
      const pct = state.totalBytes > 0 ? ((state.doneBytes / state.totalBytes) * 100).toFixed(0) : '0';
      say(`解压中 ${pct}%（${state.doneFiles}/${state.totalFiles} 个文件，${opts.threads} 个并发进程）`);
    }
  });
  await Promise.all(workers);
  return errors;
}

function verify(entries) {
  const missing = [];
  for (const e of entries) {
    if (e.dir) continue; // 目录由 tar 按需创建，不单独校验
    const abs = path.join(opts.dest, ...e.name.split('/'));
    try {
      // 链接条目（e.link）要用 lstat：stat 会跟随链接，断链会误判为缺失
      if (e.link) {
        fs.lstatSync(abs);
        continue;
      }
      if (!fs.statSync(abs).isFile()) missing.push(e.name);
    } catch {
      missing.push(e.name);
    }
  }
  return missing;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  if (!fs.existsSync(opts.tar)) fail(`未找到 tar：${opts.tar}`);

  // Windows 7 没有 %SystemRoot%\System32\tar.exe（微软从 Win10 1803 才内置 bsdtar）。
  // 有系统 tar 就用多进程并行（快）；没有就退回内置纯 JS 解压（慢，但零依赖、不报错）。
  const hasTar = fs.existsSync(TAR_EXE);
  if (!hasTar) {
    say(`未找到系统 tar（${TAR_EXE}），改用内置纯 JS 解压（单线程，会慢一些）`);
  }

  const started = Date.now();

  const index = readTarIndex(opts.tar).filter((e) => e.name.startsWith(`${opts.rootName}/`));

  // 只报告索引（打包自检用：核对 tar 与 manifest 是否同批次）
  if (flag('index-only')) {
    const files = index.filter((e) => !e.dir);
    const totalBytes = files.reduce((s, e) => s + e.size, 0);
    say(
      `索引：${files.length} 个文件 / ${(totalBytes / 1048576).toFixed(1)} MB` +
        `（另有 ${index.length - files.length} 个目录条目）`,
    );
    process.stdout.write(`INDEX ${JSON.stringify({ files: files.length, bytes: totalBytes })}\n`);
    return;
  }

  // 正常安装路径的快速跳过：目录已完整且版本一致
  const entryFile = path.join(opts.dest, opts.rootName, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  const markerFile = path.join(opts.dest, opts.rootName, '.runtime-version');
  if (!opts.force && !opts.only && fs.existsSync(entryFile)) {
    let tag = '';
    try {
      tag = fs.readFileSync(markerFile, 'utf8').trim();
    } catch {
      /* 无标记 */
    }
    if (opts.versionTag && tag === opts.versionTag) {
      say(`运行时已就绪（版本 ${tag}），跳过解压`);
      return;
    }
    if (!opts.versionTag && verify(index).length === 0) {
      say('运行时已完整，跳过解压');
      return;
    }
  }

  let targets = index;
  if (opts.only) {
    const wanted = new Set(
      fs
        .readFileSync(opts.only, 'utf8')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((rel) => (rel.startsWith(`${opts.rootName}/`) ? rel : `${opts.rootName}/${rel}`)),
    );
    targets = index.filter((e) => wanted.has(e.name));
    if (targets.length === 0) {
      say('给定清单中没有需要补齐的成员，跳过');
      return;
    }
  }

  state.totalBytes = targets.reduce((s, e) => s + e.size, 0);
  state.totalFiles = targets.filter((e) => !e.dir).length;
  state.phase = 'extract';
  writeProgress(true);

  say(
    `开始解压：${state.totalFiles} 个文件 / ${(state.totalBytes / 1048576).toFixed(1)} MB，` +
      (hasTar ? `并发 ${opts.threads}（CPU ${os.cpus().length} 核）` : '纯 JS 单线程模式'),
  );

  fs.mkdirSync(opts.dest, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rt-'));
  let missing = [];
  let round = 0;

  try {
    // 3 轮：首轮全量并行；后续轮只重试缺失项（杀软偶发拦截 / 瞬时锁）
    while (round < 3) {
      round++;
      if (hasTar) {
        const batches = planBatches(targets, Math.min(64, Math.max(opts.threads, opts.threads * 3)));
        const errors = await runBatches(batches, tmpDir);
        if (errors.length > 0) say(`第 ${round} 轮有 ${errors.length} 个批次报错：${errors[0]}`);
      } else {
        // Windows 7 路径：单线程纯 JS 解压（只解 targets 里点名的成员）
        const wanted = new Set(targets.map((e) => e.name));
        const res = extractTarPure(opts.tar, opts.dest, wanted, (bytes, files) => {
          state.doneBytes = bytes;
          state.doneFiles = files;
          writeProgress();
        });
        state.doneBytes = res.doneBytes;
        state.doneFiles = res.doneFiles;
        say(`第 ${round} 轮纯 JS 解压完成：${res.doneFiles} 个文件`);
      }

      state.phase = 'verify';
      writeProgress(true);
      missing = verify(targets);
      if (missing.length === 0) break;

      say(`第 ${round} 轮校验：仍缺 ${missing.length} 个文件，重试补齐…`);
      targets = index.filter((e) => missing.includes(e.name));
      state.totalBytes = targets.reduce((s, e) => s + e.size, 0);
      state.totalFiles = targets.length;
      state.doneBytes = 0;
      state.doneFiles = 0;
    }
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);

  if (missing.length > 0) {
    state.phase = 'failed';
    writeProgress(true);
    fail(`校验未通过：仍缺 ${missing.length} 个文件（例如 ${missing[0]}），耗时 ${secs}s`);
  }

  if (opts.versionTag) {
    try {
      fs.writeFileSync(markerFile, opts.versionTag, 'utf8');
    } catch {
      /* ignore */
    }
  }

  state.phase = 'done';
  state.doneBytes = state.totalBytes;
  writeProgress(true);
  say(`完成：${state.totalFiles} 个文件校验通过，耗时 ${secs}s（并发 ${opts.threads}）`);
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err)));
