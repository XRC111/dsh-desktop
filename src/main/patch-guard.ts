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

/** 要给某个 insert 行注入的 config（key = 插件 id，值 = 该行的 config 对象） */
export type InsertConfig = Record<string, Record<string, unknown>>;

/**
 * 往 insert 块里的指定行注入 `config:`。
 *
 * 为什么要改文本而不是解析 YAML：补丁是我们自己维护的、格式固定，
 * 为它引一个 YAML 依赖不划算（且要保证**其余内容逐字不变**，避免热壳与安装目录
 * 两份补丁产生无谓差异）。所以只做行级的定点插入。
 *
 * 注入规则：找到 `- id: <key>` 那一行，在它后面的 `name:` 行之后插入 config 块。
 * 若该行**已有** config（用户手写的），原样保留、不覆盖 —— 用户的显式配置优先。
 */
function injectConfigs(lines: string[], configs: InsertConfig): { lines: string[]; injected: string[] } {
  const injected: string[] = [];
  const out: string[] = [];
  let pendingKeys: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);

    // 记录本行声明的 id（可能一行里多个 id 各自成块，但我们的补丁是一行一个）
    const idm = /^\s*-\s*id\s*:\s*['"]?([^'"\s#]+)['"]?/.exec(line);
    if (idm) {
      pendingKeys = [idm[1]];
      continue;
    }

    // name 行紧跟 id 行：到这里才知道这一项是哪个插件
    if (pendingKeys.length && /^\s+name\s*:/.test(line)) {
      const key = pendingKeys[0];
      const cfg = configs[key];
      pendingKeys = [];
      if (!cfg) continue;

      // config 必须与 name **同级**（不是更深一级），否则 YAML 结构就错了。
      const indent = /^(\s*)/.exec(line)?.[1] ?? '';
      const childIndent = indent + '  ';

      // 往后看：该行是否已经有 config → 有就不动，尊重用户手写配置
      let j = i + 1;
      let hasConfig = false;
      while (j < lines.length) {
        const nxt = lines[j];
        if (!nxt.trim()) { j++; continue; }
        if (!nxt.startsWith(indent)) break;
        if (/^\s+config\s*:/.test(nxt)) { hasConfig = true; break; }
        j++;
      }
      if (hasConfig) continue;

      out.push(indent + 'config:');
      for (const [k, v] of Object.entries(cfg)) {
        out.push(childIndent + k + ': ' + JSON.stringify(v));
      }
      injected.push(key);
    }
  }
  return { lines: out, injected };
}

/**
 * 校验并落盘「实际生效的补丁」。
 *
 * @param patchFile 原始补丁（可能来自热壳，也可能来自安装目录）
 * @param outFile   实际生效的补丁输出路径（用户数据目录，保证可写）
 * @param searchRoots 解析插件包名的根目录列表（profile node_modules 优先）
 * @param configs   要注入到指定 insert 行的 config（如 computer-use 的 allowInput）
 */
export function guardPatch(
  patchFile: string,
  outFile: string,
  searchRoots: string[],
  configs: InsertConfig = {},
): PatchGuardResult {
  let text: string;
  try {
    text = fs.readFileSync(patchFile, 'utf8');
  } catch (err) {
    log(`读取桌面适配补丁失败（${patchFile}）：${String(err)}`);
    return { file: patchFile, dropped: [] };
  }

  const wanted = collectInsertedPlugins(text);
  const missing = wanted.filter((n) => !resolvable(n, searchRoots));
  const hasConfigs = Object.keys(configs).length > 0;

  // 注意：**只要要注入 config 就必须写 effective 文件**，
  // 不能像以前那样「没有缺失就直接用原补丁」—— 否则注入没地方落。
  if (missing.length === 0 && !hasConfigs) {
    // 全都解析得到且无需注入：直接用原补丁，不做任何改写（避免引入无谓差异）
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

  // 先剔除缺失行，再注入 config（顺序不能反：注入要基于剔除后的文本算缩进）
  const { lines: finalLines, injected } = hasConfigs
    ? injectConfigs(keep, configs)
    : { lines: keep, injected: [] };

  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, finalLines.join('\n'), 'utf8');
    const parts: string[] = [];
    if (missing.length) parts.push(`剔除 ${missing.length} 个未就绪插件（${missing.join('、')}）`);
    if (injected.length) parts.push(`注入 config（${injected.join('、')}）`);
    log(`桌面适配补丁已改写：${parts.join('；') || '无变化'} → 用 ${outFile}`);
    return { file: outFile, dropped: missing };
  } catch (err) {
    log(`写入生效补丁失败，回退原补丁：${String(err)}`);
    return { file: patchFile, dropped: [] };
  }
}
