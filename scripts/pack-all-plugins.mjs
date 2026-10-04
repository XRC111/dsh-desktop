// 一次打包白名单里的全部插件，并在**内容变了**的时候自动迭代版本号。
//
// 用法：
//   node scripts/pack-all-plugins.mjs                 # 打全部（内容变了就升版本号）
//   node scripts/pack-all-plugins.mjs --dry-run       # 只报告会做什么，不落盘
//   node scripts/pack-all-plugins.mjs --no-bump       # 只打包，不动版本号
//   node scripts/pack-all-plugins.mjs --only shell,updater
//
// mode 在 scripts/plugins.json 里配置：
//   upstream  先从 npm 拉上游最新版（含依赖）再打包 —— 第三方插件用，避免 vendored 副本落后
//   auto      内容变了就自动升一个 patch 版本号（默认）
//   frozen    只打包，绝不改插件的 package.json（插件正在开发中）
//
// ── 为什么必须自动迭代版本号 ──────────────────────────────────────────────
// 客户端 updater 的 pickPlugins() 判「要不要装这个插件包」用的是
//   profile 里已落位的 package.json version === feed 里的 expectedVersion
// **只看版本号**。所以内容变了而版本号没动，用户永远收不到新插件 ——
// 实测踩过：5c3cf3e 改了 shell/client.js 192 行，package.json 一个字没动，
// 结果「设置页优化」在插件热更这条路上永远到不了用户。
//
// ── 怎么判断「内容变了」而不会无限升版 ────────────────────────────────────
// 用**内容哈希**，不是 git、也不是 mtime：
//   1. 算插件目录的内容哈希（逐文件 sha256、按相对路径排序；跳过 node_modules/隐藏文件，
//      并把 package.json 里的 version / dshDesktopBuild 剔除后再算 ——
//      否则「升版本」本身会改变哈希，下次又升，死循环）；
//   2. 与 package.json 里记着的 dshDesktopBuild 比；
//   3. 不一致 → 升一个 patch 版本号，并把新哈希写回。
// 于是同一份内容重复跑是幂等的，换机器、清空 build/ 也照样成立。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const opt = (f, d) => {
  const i = argv.indexOf(`--${f}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const DRY = has('dry-run');
const NO_BUMP = has('no-bump');
const ONLY = opt('only', '').split(',').map((s) => s.trim()).filter(Boolean);

const listFile = path.join(root, 'scripts', 'plugins.json');
if (!fs.existsSync(listFile)) {
  console.error('[pack-all] 缺少 scripts/plugins.json');
  process.exit(1);
}
const targets = (JSON.parse(fs.readFileSync(listFile, 'utf8')).plugins ?? []).filter(
  (p) => p && p.name && (ONLY.length === 0 || ONLY.includes(p.name)),
);
if (targets.length === 0) {
  console.error('[pack-all] 白名单为空（或 --only 没匹配上）');
  process.exit(1);
}

/** 逐文件内容哈希；package.json 剔除 version / dshDesktopBuild（见文件头说明） */
function contentHash(dir) {
  const parts = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name === 'node_modules' || e.name === 'artifacts' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(p, r); continue; }
      if (!e.isFile()) continue;
      let buf = fs.readFileSync(p);
      if (r === 'package.json') {
        const pkg = JSON.parse(buf.toString('utf8'));
        delete pkg.version;
        delete pkg.dshDesktopBuild;
        buf = Buffer.from(JSON.stringify(pkg), 'utf8');
      }
      parts.push(`${r}:${crypto.createHash('sha256').update(buf).digest('hex')}`);
    }
  };
  walk(dir, '');
  parts.sort();
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

/**
 * 只留这个插件**最新**的一份产物，删掉同名的旧版本。
 *
 * 为什么必须清：build/ 里会同时躺着好几个版本的包（换版本、或改了内容重打），
 * 而 release-v2.ps1 是按「同名前缀 + mtime 最新」挑的 —— 一旦 mtime 顺序不对，
 * 挂上 feed 的就是旧包，表现是「版本号升了但用户装到的还是旧插件」。
 * 这里直接消灭歧义：同一插件只留一份。
 */
function pruneOld(name) {
  const dir = path.join(root, 'build');
  const prefix = `plugins-${name}-`;
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.includes('.meta.json'));
  } catch {
    return;
  }
  if (files.length === 0) return;
  let newest = null;
  let newestAt = -1;
  for (const f of files) {
    const t = fs.statSync(path.join(dir, f)).mtimeMs;
    if (t > newestAt) {
      newestAt = t;
      newest = f;
    }
  }
  const stem = newest.replace(/\.meta\.json$/, '');
  let removed = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith(prefix) || f.startsWith(stem)) continue;
    fs.rmSync(path.join(dir, f), { force: true });
    removed++;
  }
  if (removed > 0) console.log(`      清理旧产物 ${removed} 个（保留 ${stem}）`);
}

function bumpPatch(v) {
  const m = String(v).match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : null;
}

/** 定向改两个字段，保持原有键顺序 / 缩进 / 行尾，不做整文件重排 */
function writeMark(pkgFile, raw, version, hash) {
  let out = raw;
  if (version) {
    const before = out;
    out = out.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
    if (out === before) throw new Error('没找到 version 字段，无法升版本');
  }
  if (/\)"dshDesktopBuild"\s*:\s*"[^"]*"/.test(out)) {
    out = out.replace(/("dshDesktopBuild"\s*:\s*")[^"]*(")/, `$1${hash}$2`);
  } else {
    const i = out.lastIndexOf('}');
    const head = out.slice(0, i).replace(/\s*$/, '');
    const tail = out.slice(i);
    const sep = /,\s*$/.test(head) ? '\n' : ',\n';
    out = `${head}${sep}  "dshDesktopBuild": "${hash}"\n${tail}`;
  }
  fs.writeFileSync(pkgFile, out, 'utf8');
}

console.log(`[pack-all] 白名单 ${targets.length} 个：${targets.map((p) => p.name).join('、')}${DRY ? '（dry-run）' : ''}`);

let bumped = 0;
for (const entry of targets) {
  const name = entry.name;
  const dir = path.join(root, 'resources', 'dsh-plugins', name);
  const pkgFile = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgFile)) {
    console.error(`  ✗ ${name}：找不到 ${path.relative(root, pkgFile)}`);
    process.exitCode = 1;
    continue;
  }
  let raw = fs.readFileSync(pkgFile, 'utf8');
  let pkg = JSON.parse(raw);
  let hash = contentHash(dir);
  let known = pkg.dshDesktopBuild;
  let changed = known !== hash;
  const mode = entry.mode || 'auto';
  const frozen = mode === 'frozen';
  const mayBump = mode === 'auto' && !NO_BUMP;

  // upstream：先从 npm 拉上游最新版（含依赖），再打包。
  // 第三方插件的版本归上游管，我们只负责「别落后」。
  if (mode === 'upstream' && !DRY) {
    const r0 = spawnSync(process.execPath, [path.join(root, 'scripts', 'fetch-plugin.mjs'), '--name', name], {
      stdio: 'inherit',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    if (r0.status !== 0) {
      console.error(`  ✗ ${name} 拉上游失败（exit=${r0.status}）`);
      process.exitCode = 1;
      continue;
    }
    // 必须重读：pkg / hash 都是**同步前**算的，不重读会把旧版本号当成本次结果，
    // 而且 writeMark 会拿旧的 package.json 原文覆盖刚同步下来的新文件。
    raw = fs.readFileSync(pkgFile, 'utf8');
    pkg = JSON.parse(raw);
    hash = contentHash(dir);
    known = pkg.dshDesktopBuild;
    changed = known !== hash;
  }

  let next = null;
  if (changed && mayBump) next = bumpPatch(pkg.version);
  if (changed && mayBump && !next) {
    console.error(`  ✗ ${name}：版本号 ${pkg.version} 不是 x.y.z，无法自动升`);
    process.exitCode = 1;
    continue;
  }

  const bits = [`${name}@${pkg.version}`, `hash=${hash}`];
  if (mode === 'upstream') bits.push('upstream（已同步上游最新版）');
  else if (frozen) bits.push('frozen（只打包，不改 package.json）');
  else if (!changed) bits.push('内容未变');
  else if (!mayBump) bits.push('--no-bump：只记录，不升版本');
  else bits.push(`→ ${next}`);
  console.log(`  · ${bits.join('  ')}`);

  if (DRY) {
    if (changed && !frozen) console.log('      （dry-run：会更新 package.json）');
    console.log('      （dry-run：跳过打包）');
    continue;
  }
  if (changed && !frozen && mode !== 'upstream') {
    writeMark(pkgFile, raw, next, hash);
    if (next) bumped++;
  }
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'pack-plugins.mjs'), '--name', name], {
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  if (r.status !== 0) {
    console.error(`  ✗ ${name} 打包失败（exit=${r.status}）`);
    process.exitCode = 1;
  } else {
    pruneOld(name);
  }
}
console.log(`[pack-all] 完成：${bumped} 个插件升了版本号`);
if (bumped > 0 && !DRY) {
  console.log('[pack-all] 版本号改动写在 resources/dsh-plugins/*/package.json，记得一并提交。');
}
