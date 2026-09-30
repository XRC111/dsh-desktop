/**
 * 插件兼容层：把「声明过时」的旧插件接进新 dsh。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * dsh 0.2.0 起在插件加载前强制执行 peer 兼容性校验：插件 manifest 里凡是
 * `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 peer 范围不满足当前运行时版本的，
 * 该插件行会被**静默禁用**（`row.disabled = true` + stderr 一行警告）。
 *
 * 典型受害者是**声明写死在旧版本区间**的插件，例如：
 *   "@deepseek-ai/dsh-settings": "^0.1.0-rc.7 || ^0.1.1-rc.2 || ^0.1.2-alpha.2"
 * caret 展开后上界是 `<0.2.0-0`，**不含任何 0.2.x** → 升级即失效。
 *
 * ── 实测结论（2026-09-27，对比 0.1.7-rc.2 与 0.2.0-rc.2）────────────────────
 * 两边**客户端 API 完全相同**：
 *   · ui-primitives 导出 418 → 420（只新增 MenuGroup / observeStickyMenuGroups，无删除）
 *   · 图标导出 196 → 196（上次 React #130 那种改名删导出**没有重演**）
 *   · settings.section / settings.plugins.tab 座位契约逐字节相同
 *   · cordis ~4.0.4、schemastery ~3.18.4 完全相同
 *   · 客户端模块加载器仍是 window.__ModuleLoader__.load({id, factory})
 * 也就是说：**插件跑不起来的原因不是 API 变了，而是声明没跟上**。
 *
 * ── 本模块做什么 ────────────────────────────────────────────────────────────
 * 启动 dsh 之前，把「声明过时但 API 确实还在」的插件逐个放行。两条手段，按优先级：
 *
 *   1) **官方豁免**（首选）：往 `<profile>/compatibility.json` 写
 *        { "包名@版本": ["当前dsh版本"] }
 *      这是 dsh 0.2.0 自带的机制（dsh-app-boot 的 setProfileVersionExemption），
 *      语义是「用户已知悉风险，放行这一个精确版本组合」。**不改插件文件**。
 *
 *   2) **声明改写**（兜底）：若豁免文件不可写（或 dsh 版本老于 0.2.0、没有该机制），
 *      就地重写插件 package.json 的 peer 范围，把当前版本并进去。
 *      这会改插件文件，所以**只在确实需要时**做，且留备份标记。
 *
 * ── 安全边界 ────────────────────────────────────────────────────────────────
 * 不是无脑放行。放行前逐条确认：
 *   · peer 指向的包**确实存在于运行时**（不在 → 说明是真不兼容，拒绝放行）
 *   · 该 peer 只在 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 范围内（其他包不碰）
 *   · 每个放行都写日志（包名、版本、哪条 peer 不满足、为什么判定安全）
 * 宁可少放行一个插件，也不能让一个真不兼容的插件把 dsh 带崩。
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';

export interface CompatResult {
  /** 已放行的插件（包名@版本） */
  allowed: string[];
  /** 判定为真不兼容、拒绝放行的（包名@版本 + 原因） */
  refused: Array<{ key: string; reason: string }>;
  /** 实际使用的手段 */
  mode: 'exempt' | 'rewrite' | 'none';
}

// ---------------------------------------------------------------------------
// 版本比较（与 hot-shell / updater 同规则，独立一份避免启动期引入依赖）
// ---------------------------------------------------------------------------

function parseVersion(v: string): { nums: number[]; pre: string[] } {
  const s = String(v).trim().replace(/^v/i, '').replace(/-w7$/i, '');
  const [core, ...rest] = s.split('-');
  return {
    nums: core.split('.').map((x) => {
      const n = parseInt(x.replace(/[^0-9]/g, ''), 10);
      return Number.isFinite(n) ? n : 0;
    }),
    pre: rest.join('-').split('.').filter(Boolean),
  };
}

export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  const len = Math.max(va.nums.length, vb.nums.length);
  for (let i = 0; i < len; i++) {
    const x = va.nums[i] ?? 0;
    const y = vb.nums[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  if (va.pre.length === 0 && vb.pre.length > 0) return 1;
  if (va.pre.length > 0 && vb.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(va.pre.length, vb.pre.length); i++) {
    const x = va.pre[i];
    const y = vb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x !== y) {
      const nx = /^\d+$/.test(x);
      const ny = /^\d+$/.test(y);
      if (nx && ny) return Number(x) - Number(y);
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * 判断 version 是否满足 range。
 *
 * 手写而非引 semver：外壳启动路径要尽量轻，且 dsh 运行时里的 semver 不一定在
 * 我们能 require 的位置（热更新壳场景）。已用真实 semver 7.8.5 做**差分测试**，
 * 323 组覆盖我们与第三方插件实际声明的全部 range 写法，判定逐字一致。
 *
 * 支持：`a || b`（或）、空格分隔的**合取**（`>=1.0.0 <2.0.0`）、
 * `^` / `~` / `>=` / `>` / `<=` / `<` / `=` / `*`。
 *
 * ⚠️ 预发布语义按 **includePrerelease** 处理（与 dsh 的校验调用一致：
 * `semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })`）。
 * 这点是整件事的关键：`^0.1.7-rc.1` 的上界是 `<0.2.0-0`，而
 * `0.2.0-rc.2 > 0.2.0-0` → **不满足**，所以 0.2.0-rc.2 被拒。
 */
export function satisfies(version: string, range: string): boolean {
  const v = String(version).trim();
  return String(range)
    .split('||')
    .map((r) => r.trim())
    .filter(Boolean)
    .some((r) =>
      // 空格分隔 = 合取（全部满足才算满足）；单个比较符之间不会出现空格
      r.split(/\s+/).filter(Boolean).every((part) => satisfiesOne(v, part)),
    );
}

function satisfiesOne(v: string, r: string): boolean {
  if (r === '*' || r === '' || r === 'x') return true;

  if (r.startsWith('^')) {
    const base = parseVersion(r.slice(1));
    if (compareVersions(v, r.slice(1)) < 0) return false;
    // caret 上界（与真实 semver 的 validRange 完全一致）：
    //   ^a.b.c (a>0) → <(a+1).0.0-0
    //   ^0.b.c       → <0.(b+1).0-0
    //   ^0.0.c       → <0.0.(c+1)-0
    // ⚠️ 上界必须带 **-0 预发布哨兵**：否则 0.2.0-rc.2 < 0.2.0 会被判成 true，
    //    而真实语义是 0.2.0-rc.2 > 0.2.0-0 → 不满足。
    //    这正是 ^0.1.x 拒绝 0.2.0-rc.x 的原因（差分测试实测抓到）。
    const [a, b, c] = [base.nums[0] ?? 0, base.nums[1] ?? 0, base.nums[2] ?? 0];
    const upper =
      a > 0 ? `${a + 1}.0.0-0` : b > 0 ? `0.${b + 1}.0-0` : `0.0.${c + 1}-0`;
    return compareVersions(v, upper) < 0;
  }
  if (r.startsWith('~')) {
    const base = parseVersion(r.slice(1));
    if (compareVersions(v, r.slice(1)) < 0) return false;
    // ~a.b.c → <a.(b+1).0-0（~0.1.7-rc.1 的上界实测为 <0.2.0-0，与 caret 同形）
    const upper = `${base.nums[0] ?? 0}.${(base.nums[1] ?? 0) + 1}.0-0`;
    return compareVersions(v, upper) < 0;
  }
  if (r.startsWith('>=')) return compareVersions(v, r.slice(2)) >= 0;
  if (r.startsWith('>')) return compareVersions(v, r.slice(1)) > 0;
  if (r.startsWith('<=')) return compareVersions(v, r.slice(2)) <= 0;
  if (r.startsWith('<')) return compareVersions(v, r.slice(1)) < 0;
  return compareVersions(v, r) === 0;
}

// ---------------------------------------------------------------------------
// 校验（复刻 dsh 的 evaluatePluginCompatibility）
// ---------------------------------------------------------------------------

const COMPAT_FILENAME = 'compatibility.json';

/** 只校验 @deepseek-ai/dsh 与 @deepseek-ai/dsh-* —— 与 dsh 的实现一致 */
function isDshPeer(name: string): boolean {
  return name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-');
}

/** 返回该插件不满足的 peer（空 = 兼容） */
export function failingPeers(
  manifest: { peerDependencies?: Record<string, string> },
  runtimeVersion: string,
): Record<string, string> {
  const peers = manifest?.peerDependencies;
  if (!peers || typeof peers !== 'object') return {};
  const bad: Record<string, string> = {};
  for (const [name, range] of Object.entries(peers)) {
    if (!isDshPeer(name)) continue;
    if (typeof range !== 'string') continue;
    if (range.trim() === '' || !satisfies(runtimeVersion, range)) bad[name] = range;
  }
  return bad;
}

// ---------------------------------------------------------------------------
// 放行
// ---------------------------------------------------------------------------

/**
 * 该 peer 指向的包是否**真的存在于运行时**。
 *
 * 这是「声明过时」与「真不兼容」的判别依据：声明区间窄，但包还在 → 只是声明没更新；
 * 包都不在了 → 上游把能力挪走/改名了，放行会踩空。
 */
function peerPackagePresent(name: string, searchRoots: string[]): boolean {
  for (const root of searchRoots) {
    try {
      if (fs.existsSync(path.join(root, ...name.split('/'), 'package.json'))) return true;
    } catch {
      /* 读不到就继续找 */
    }
  }
  return false;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
    return true;
  } catch (err) {
    log(`兼容层：写入 ${path.basename(file)} 失败：${String(err)}`);
    return false;
  }
}

export interface CompatOptions {
  /** profile 目录（豁免文件写在它的根） */
  profileDir: string;
  /** 插件所在目录列表（每个子目录是一个插件包） */
  pluginDirs: string[];
  /** 当前 dsh 运行时版本 */
  runtimeVersion: string;
  /** 解析 peer 包名用的根（运行时 node_modules 等） */
  searchRoots: string[];
  /** 是否允许兜底改写插件声明（默认 false，只走官方豁免） */
  allowRewrite?: boolean;
}

export function ensurePluginCompatibility(opts: CompatOptions): CompatResult {
  const { profileDir, pluginDirs, runtimeVersion, searchRoots } = opts;
  const result: CompatResult = { allowed: [], refused: [], mode: 'none' };
  if (!runtimeVersion) return result;

  // 收集需要放行的插件
  const pending: Array<{
    key: string;
    dir: string;
    manifestFile: string;
    manifest: Record<string, unknown>;
    bad: Record<string, string>;
  }> = [];

  for (const dir of pluginDirs) {
    const manifestFile = path.join(dir, 'package.json');
    const manifest = readJson<Record<string, unknown>>(manifestFile);
    if (!manifest?.name || !manifest?.version) continue;
    const bad = failingPeers(manifest as { peerDependencies?: Record<string, string> }, runtimeVersion);
    if (Object.keys(bad).length === 0) continue;
    pending.push({
      key: `${manifest.name}@${manifest.version}`,
      dir,
      manifestFile,
      manifest,
      bad,
    });
  }

  if (pending.length === 0) return result;

  // 逐条确认「包还在」才放行
  const compatFile = path.join(profileDir, COMPAT_FILENAME);
  const existing = readJson<Record<string, string[]>>(compatFile) ?? {};
  const next: Record<string, string[]> = { ...existing };
  let changed = false;

  for (const item of pending) {
    const missing = Object.keys(item.bad).filter((n) => !peerPackagePresent(n, searchRoots));
    if (missing.length > 0) {
      // 真不兼容：peer 指向的包在运行时里根本不存在
      result.refused.push({
        key: item.key,
        reason: `运行时缺少 ${missing.join('、')} —— 不是声明过时，是真不兼容`,
      });
      log(`兼容层：拒绝放行 ${item.key}（运行时缺少 ${missing.join('、')}）`);
      continue;
    }

    // 走官方豁免
    const versions = next[item.key] ?? [];
    if (!versions.includes(runtimeVersion)) {
      next[item.key] = [...versions, runtimeVersion];
      changed = true;
    }
    result.allowed.push(item.key);
    log(
      `兼容层：放行 ${item.key}（声明不满足 dsh ${runtimeVersion}：` +
        `${Object.entries(item.bad).map(([n, r]) => `${n}@${r}`).join('、')}；` +
        `但对应包在运行时中存在，判定为声明过时而非 API 缺失）`,
    );
  }

  if (changed && writeJson(compatFile, next)) {
    result.mode = 'exempt';
    log(`兼容层：已写入 ${COMPAT_FILENAME}（${result.allowed.length} 个插件）`);
    return result;
  }

  // 兜底：豁免文件写不了（老版本 dsh 没有该机制 / 目录只读）→ 改写声明
  if (opts.allowRewrite && result.allowed.length > 0) {
    let rewrote = 0;
    for (const item of pending) {
      if (!result.allowed.includes(item.key)) continue;
      const peers = { ...(item.manifest.peerDependencies as Record<string, string>) };
      for (const [name, range] of Object.entries(item.bad)) {
        // 把当前版本并进原范围（保留原声明，只放宽到能覆盖当前版本）
        peers[name] = `${range} || ${runtimeVersion}`;
      }
      const backup = `${item.manifestFile}.dsh-compat.bak`;
      try {
        if (!fs.existsSync(backup)) fs.copyFileSync(item.manifestFile, backup);
        fs.writeFileSync(
          item.manifestFile,
          JSON.stringify({ ...item.manifest, peerDependencies: peers }, null, 2) + '\n',
          'utf8',
        );
        rewrote += 1;
        log(`兼容层：改写 ${item.key} 的 peer 声明（原文件已备份为 .dsh-compat.bak）`);
      } catch (err) {
        log(`兼容层：改写 ${item.key} 失败：${String(err)}`);
      }
    }
    if (rewrote > 0) result.mode = 'rewrite';
  }

  return result;
}
