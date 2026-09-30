/**
 * 可选 bundle 的启用（dsh 0.2.0 起的能力）。
 *
 * ── 背景 ────────────────────────────────────────────────────────────────────
 * dsh 0.2.0 把「定时任务」从内置改为**可选 bundle**：
 *   `@deepseek-ai/dsh-experimental-schedule-bundle`
 * 它随安装树分发（是 dsh 的运行时依赖），但**默认不出现在任何 profile 模板的
 * bundles 列表里**，因此升级后 schedule_create 等工具会消失。
 *
 * 官方给出的启用方式（`dsh plugin` 命令走的也是这条）：把包名加进
 *   `$DSH_HOME/profiles/web/package.json` 的 `dsh.profile.bundles` 数组。
 * 该 bundle 自带 `dsh.bundle.patch`（cordis.patch.yml），会 insert 三行：
 *   time-context / schedule / ui-schedule
 * 这三个包已经是 dsh 的运行时依赖（实测在树里），所以不需要额外安装。
 *
 * ── 为什么由外壳来做 ────────────────────────────────────────────────────────
 * 官方默认关闭是为了省 token（调度会给每个活跃请求挂工具 schema）。
 * 但我们的用户升级前**本来就有**这个能力，默认关掉等于功能回退。
 * 所以按通道决定：dev 通道默认启用（试水），stable/beta 保持官方默认。
 * 想改就改这里的 SHELL_ENABLE_SCHEDULE_BUNDLE 或 profile 的 bundles 列表。
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';

const SCHEDULE_BUNDLE = '@deepseek-ai/dsh-experimental-schedule-bundle';

export interface OptionalBundleResult {
  /** 本次是否真的改了 profile 清单 */
  changed: boolean;
  /** 变更后的 bundles 列表 */
  bundles: string[];
  /** 跳过原因（未变更时） */
  skipped?: string;
}

/**
 * 确保某个可选 bundle 出现在 profile 的 bundles 列表里（幂等）。
 *
 * @param profileDir profile 目录（如 $DSH_HOME/profiles/web）
 * @param bundleName 要启用的 bundle 包名
 * @param enabled false = 不启用（直接返回，不删已有项，避免把用户手动开的又关掉）
 */
export function ensureOptionalBundle(
  profileDir: string,
  bundleName: string,
  enabled: boolean,
): OptionalBundleResult {
  const manifestFile = path.join(profileDir, 'package.json');

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch (err) {
    // profile 还没初始化（首次启动由 dsh 自己建）→ 什么都不做，下次启动再说
    return { changed: false, bundles: [], skipped: `profile 清单不可读：${String(err)}` };
  }

  const dsh = (manifest.dsh ?? {}) as Record<string, unknown>;
  const profile = (dsh.profile ?? {}) as Record<string, unknown>;
  const bundles = Array.isArray(profile.bundles) ? (profile.bundles as string[]) : [];

  if (bundles.includes(bundleName)) {
    return { changed: false, bundles, skipped: '已在 bundles 列表里' };
  }
  if (!enabled) {
    return { changed: false, bundles, skipped: '该通道未启用（保持官方默认）' };
  }

  const next = [...bundles, bundleName];
  const updated = {
    ...manifest,
    dsh: { ...dsh, profile: { ...profile, bundles: next } },
  };
  try {
    fs.writeFileSync(manifestFile, JSON.stringify(updated, null, 2) + '\n', 'utf8');
    log(`已启用可选 bundle：${bundleName}（写入 ${path.relative(profileDir, manifestFile) || 'package.json'}）`);
    return { changed: true, bundles: next };
  } catch (err) {
    log(`启用可选 bundle 失败（${bundleName}）：${String(err)}`);
    return { changed: false, bundles, skipped: `写入失败：${String(err)}` };
  }
}

/**
 * 按通道决定是否启用定时任务 bundle。
 *
 * 当前策略（2026-09-27 用户拍板）：**只在 dev 通道启用**（试水）。
 * stable/beta 保持官方默认（不启用），等 dev 验证稳定后再推。
 *
 * @param profileDir profile 目录
 * @param channel 更新通道（stable / beta / dev）
 */
export function ensureScheduleBundle(profileDir: string, channel: string): OptionalBundleResult {
  return ensureOptionalBundle(profileDir, SCHEDULE_BUNDLE, channel === 'dev');
}
