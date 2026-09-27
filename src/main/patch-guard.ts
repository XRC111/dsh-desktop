/**
 * 桌面适配补丁的可用性防护。
 *
 * 为什么需要它（实测会砖机）：补丁里 `insert` 的插件只要有一个**解析不到**，
 * dsh 的加载器就直接抛 `plugin tree failed to load: loader entries failed to apply`，
 * 进程 exit=1 —— 表现是「应用启动后 Harness 永远起不来」。
 *
 * 这个风险是热更新带进来的：pack-hot 现在会把 desktop-patch.yml 打进热壳
 * （否则热壳新增的插件行到不了已装用户），而插件包是**另一条链路**下载的。
 * 两者不同步时（插件下载失败/被跳过/落位前就重启）就会踩到。
 *
 * 做法：启动前把补丁里解析不到的 insert 行剔除，其余原样保留，写一份
 * 「实际生效的补丁」到用户数据目录再交给 dsh。宁可少一个插件，也不能起不来。
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';

/**
 * 从补丁文本里找出 `insert` 块中每一项的插件名。
 *
 * 只做**行级**解析：补丁是我们自己维护的（格式固定），不值得引入 YAML 依赖。
 * 识别规则：`- insert:` 之后、缩进更深的 `- id: <x>` / `name: '<pkg>'` 成对出现，
 * 直到遇到顶格（非缩进）的下一个条目。
 */
export function collectInsertedPlugins(patchText: string): string[] {
  const names: string[] = [];
  const lines = patchText.split(/\r?\n/);
  let inInsert = false;
  for (const line of lines) {
    // 顶格（无缩进）的行 = 新条目的开始：`- id: xxx` / `- insert:`
    if (/^-\s/.test(line)) {
      inInsert = /^-\s*insert\s*:/.test(line);
      continue;
    }
    if (!inInsert) continue;
    const m = /^\s+name\s*:\s*['"]?([^'"\s#]+)['"]?/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

/** 插件能否被解析到：profile 共享 node_modules 或运行时自带的 node_modules */
function resolvable(pkgName: string, searchRoots: string[]): boolean {
  for (const root of searchRoots) {
    const p = path.join(root, ...pkgName.split('/'), 'package.json');
    if (fs.existsSync(p)) return true;
  }
  return false;
}

export interface PatchGuardResult {
  /** 实际交给 dsh 的补丁路径 */
  file: string;
  /** 被剔除的插件名（解析不到的） */
  dropped: string[];
}

/**
 * 校验并落盘「实际生效的补丁」。
 *
 * @param patchFile 原始补丁（可能来自热壳，也可能来自安装目录）
 * @param outFile   实际生效的补丁输出路径（用户数据目录，保证可写）
 * @param searchRoots 解析插件包名的根目录列表（profile node_modules 优先）
 */
export function guardPatch(patchFile: string, outFile: string, searchRoots: string[]): PatchGuardResult {
  let text: string;
  try {
    text = fs.readFileSync(patchFile, 'utf8');
  } catch (err) {
    log(`读取桌面适配补丁失败（${patchFile}）：${String(err)}`);
    return { file: patchFile, dropped: [] };
  }

  const wanted = collectInsertedPlugins(text);
  const missing = wanted.filter((n) => !resolvable(n, searchRoots));
  if (missing.length === 0) {
    // 全都解析得到：直接用原补丁，不做任何改写（避免引入无谓差异）
    return { file: patchFile, dropped: [] };
  }

  // 逐个剔除缺失插件的行（`- id: ...` + 紧随的 `name: '<缺失包>'`，以及紧邻的注释）
  const keep: string[] = [];
  const lines = text.split(/\r?\n/);
  let skipNext = false;
  for (const line of lines) {
    if (skipNext) {
      // 跳过配对的 name 行
      if (/^\s+name\s*:/.test(line)) { skipNext = false; continue; }
      skipNext = false;
    }
    const m = /^\s+name\s*:\s*['"]?([^'"\s#]+)['"]?/.exec(line);
    if (m && missing.includes(m[1])) {
      // 删掉这一行，同时把**紧邻的上一条 `- id:` 行**也删掉
      while (keep.length > 0 && /^\s+-\s*id\s*:/.test(keep[keep.length - 1])) keep.pop();
      continue;
    }
    keep.push(line);
  }

  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, keep.join('\n'), 'utf8');
    log(
      `桌面适配补丁已剔除 ${missing.length} 个未就绪的插件（${missing.join('、')}）→ 用 ${outFile}`,
    );
    return { file: outFile, dropped: missing };
  } catch (err) {
    log(`写入生效补丁失败，回退原补丁：${String(err)}`);
    return { file: patchFile, dropped: [] };
  }
}
