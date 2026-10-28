/**
 * 重放我们对 vendored 插件做的本地改动。
 *
 * ── 为什么这是一个独立模块 ──────────────────────────────────────────────────
 * `mode: upstream` 的插件（dshmarket）会在打包前从 npm 拉最新版，**整目录覆盖**
 * `resources/dsh-plugins/<name>`。我们对它做的改动（旧插件兼容层）就这样被抹掉：
 * 没有冲突、没有报错，只是「市场又开始把旧插件标成不兼容」。
 *
 * 这类静默失效只有靠「重放 + 打不上就失败」来兜。而它偏偏只在非 dry-run 的
 * upstream 分支里才跑得到 —— 藏在一个 300 行的构建脚本中间，等于没法测。
 * 所以抽出来：逻辑留在这里，调用方只负责决定跳不跳过。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * `git apply` 的一层薄封装：先按原样试，失败再只放宽空白差异。
 *
 * ── 为什么需要放宽 ──────────────────────────────────────────────────────────
 * 打包流水线跑在 Windows runner 上。仓库没有 `.gitattributes`，而
 * `core.autocrlf` 在 Windows 上常常是 true —— 那样工作区里是 CRLF、补丁里是
 * LF，上下文行逐字节比不相等，`git apply` 直接报 `patch does not apply`。
 * 补丁本身完全正确。
 *
 * 只在**第一次真的失败**时才放宽：真冲突（上游改了补丁涉及的行）必须照旧
 * 报错。把打歪的补丁放过去比不打更糟 —— 那会产出一个半截的兼容层。
 *
 * @param {string} root 仓库根（`git apply` 的 cwd）
 * @param {string[]} args
 * @returns {{ok: boolean, relaxed: boolean, output: string}}
 */
export function gitApply(root, args) {
    const run = (extra) => spawnSync('git', ['apply', ...extra, ...args], { cwd: root, encoding: 'utf8' });
    const first = run([]);
    if (first.status === 0) return { ok: true, relaxed: false, output: '' };
    const relaxed = run(['--ignore-whitespace']);
    if (relaxed.status === 0) return { ok: true, relaxed: true, output: '' };
    return { ok: false, relaxed: false, output: (first.stderr || first.stdout || '').trim() };
}

/**
 * 把 `scripts/patches/<name>-*.patch` 全部重放到工作区。
 *
 * 幂等：已经应用过的用 `git apply --reverse --check` 认出来并跳过，所以本地
 * 反复跑也不会因「补丁已在」而报错。
 *
 * @param {string} root 仓库根
 * @param {string} name 插件名
 * @returns {{applied: string[], already: string[], failed: Array<{file: string, output: string}>}}
 */
export function reapplyLocalPatches(root, name) {
    const dir = path.join(root, 'scripts', 'patches');
    const result = { applied: [], already: [], failed: [] };
    if (!fs.existsSync(dir)) return result;
    const patches = fs.readdirSync(dir)
        .filter((f) => f.startsWith(name + '-') && f.endsWith('.patch'))
        .sort();
    for (const file of patches) {
        const abs = path.join(dir, file);
        if (gitApply(root, ['--reverse', '--check', abs]).ok) {
            result.already.push(file);
            continue;
        }
        const applied = gitApply(root, [abs]);
        if (!applied.ok) {
            result.failed.push({ file, output: applied.output });
            continue;
        }
        if (applied.relaxed) result.relaxed = [...(result.relaxed ?? []), file];
        result.applied.push(file);
    }
    return result;
}
