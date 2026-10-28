#!/usr/bin/env node
/**
 * `scripts/lib/local-patches.mjs` 的行为测试。
 *
 * ── 为什么必须测这件事 ──────────────────────────────────────────────────────
 * 这段代码是「兼容层被静默抹掉」的唯一防线：`mode: upstream` 的插件每次都从
 * npm 拉最新版、**整目录覆盖**本地目录，我们对 dshmarket 的三处改动就这样没了。
 * 没有冲突提示、没有报错，只是市场又开始把旧插件标成不兼容。
 *
 * 而它自己的失败方式同样是沉默的 —— 如果 `--reverse --check` 判错，它会以为
 * 「补丁已在」然后什么都不做，日志还会写「补丁已在」，看起来完全正常。
 * 所以这里用一个真的 git 仓库，把三种局面各走一遍：
 *
 *   1. 上游覆盖后（补丁没了）→ 必须重放；
 *   2. 已经应用过（本地重复跑）→ 必须认出来并跳过，不能报错；
 *   3. 上游改了补丁涉及的行 → 必须报 failure，且**不能**把打歪的内容写进去。
 *
 * 另外单独验 CRLF 工作区：Windows 上 `core.autocrlf=true` 时补丁明明正确却打
 * 不上，那种情况下要能靠 `--ignore-whitespace` 过去。
 *
 * 跑法：node scripts/local-patches.test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { gitApply, reapplyLocalPatches } from './lib/local-patches.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
let passed = 0;
function check(label, fn) {
    try {
        fn();
        passed += 1;
        console.log(`  PASS  ${label}`);
    } catch (error) {
        failed += 1;
        console.log(`  FAIL  ${label}`);
        console.log(`        ${error.message.split('\n').join('\n        ')}`);
    }
}

const git = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`);
    return r.stdout;
};

/** 造一个带提交的临时仓库，里面有一个插件目录和一个已应用的补丁。 */
function makeRepo({ patchName = 'demo-fix.patch' } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-local-patches-'));
    const dir = path.join(root, 'resources', 'dsh-plugins', 'demo');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(root, 'scripts', 'patches'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.js'), [
        'export function handle(x) {',
        '    return x + 1;',
        '}',
        '',
    ].join('\n'));
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'test');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'base');

    // 做一处改动 → 存成补丁 → 还原（= 上游原样）
    fs.writeFileSync(path.join(dir, 'index.js'), [
        'export function handle(x) {',
        '    if (x < 0) return 0;',
        '    return x + 1;',
        '}',
        '',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'helper.js'), 'export const FLAG = true;\n');
    git(root, 'add', '-A');
    const diff = git(root, 'diff', '--cached');
    fs.writeFileSync(path.join(root, 'scripts', 'patches', patchName), diff);
    git(root, 'reset', '-q');
    git(root, 'checkout', '--', '.');
    fs.rmSync(path.join(dir, 'helper.js'), { force: true });

    return { root, dir, patch: path.join(root, 'scripts', 'patches', patchName) };
}

check('补丁被上游覆盖后 → 重放回来', () => {
    const { root, dir } = makeRepo();
    // 前提确认：此刻是上游原样（补丁没应用）。
    assert.ok(!fs.readFileSync(path.join(dir, 'index.js'), 'utf8').includes('x < 0'));
    assert.equal(fs.existsSync(path.join(dir, 'helper.js')), false);

    const r = reapplyLocalPatches(root, 'demo');
    assert.deepEqual(r.failed, []);
    assert.deepEqual(r.applied, ['demo-fix.patch']);
    // 两处都要在：改的行、以及补丁新建的文件。
    assert.ok(fs.readFileSync(path.join(dir, 'index.js'), 'utf8').includes('x < 0'));
    assert.equal(fs.existsSync(path.join(dir, 'helper.js')), true);
});

check('已经应用过 → 认出来并跳过，不报错也不重复打', () => {
    const { root, dir } = makeRepo();
    reapplyLocalPatches(root, 'demo');
    const second = reapplyLocalPatches(root, 'demo');
    assert.deepEqual(second.already, ['demo-fix.patch']);
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.failed, []);
    // 重复应用会把新增文件写两遍或报「已存在」，这里顺带钉住它的幂等。
    assert.equal(fs.readFileSync(path.join(dir, 'index.js'), 'utf8').includes('x < 0'), true);
});

check('上游改了补丁涉及的行 → 报 failure，且不写入半截内容', () => {
    const { root, dir } = makeRepo();
    // 模拟上游把上下文改掉：`x + 1` 变成 `x + 2`。
    fs.writeFileSync(path.join(dir, 'index.js'), [
        'export function handle(x) {',
        '    return x + 2;',
        '}',
        '',
    ].join('\n'));

    const r = reapplyLocalPatches(root, 'demo');
    assert.equal(r.applied.length, 0);
    assert.equal(r.already.length, 0);
    assert.equal(r.failed.length, 1, '必须报 failure —— 否则调用方以为补丁打上了');
    assert.equal(r.failed[0].file, 'demo-fix.patch');
    // 内容必须保持上游原样：宁可失败，也不能留一个打歪的兼容层。
    assert.ok(!fs.readFileSync(path.join(dir, 'index.js'), 'utf8').includes('x < 0'));
    assert.equal(fs.existsSync(path.join(dir, 'helper.js')), false);
});

check('CRLF 工作区（Windows autocrlf）→ 靠忽略空白差异打上', () => {
    const { root, dir } = makeRepo();
    // 把工作区文件改成 CRLF：补丁是 LF，上下文行逐字节比不相等。
    const crlf = fs.readFileSync(path.join(dir, 'index.js'), 'utf8').replace(/\n/g, '\r\n');
    fs.writeFileSync(path.join(dir, 'index.js'), crlf);

    // 先确认「严格模式」确实打不上 —— 否则这个测试什么都没证明。
    const strict = gitApply(root, ['--check', path.join(root, 'scripts', 'patches', 'demo-fix.patch')]);
    // 打得上也无妨（git 版本差异），但真正要验的是最终结果。
    const r = reapplyLocalPatches(root, 'demo');
    assert.deepEqual(r.failed, [], 'CRLF 不该被当成真冲突');
    assert.deepEqual(r.applied, ['demo-fix.patch']);
    assert.ok(fs.readFileSync(path.join(dir, 'index.js'), 'utf8').includes('x < 0'));
    if (!strict.ok) {
        assert.deepEqual(r.relaxed, ['demo-fix.patch'], '严格模式失败时，必须是用放宽模式才打上的');
    }
});

check('没有 patches 目录 → 安静返回空结果', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-local-patches-none-'));
    const r = reapplyLocalPatches(root, 'demo');
    assert.deepEqual(r, { applied: [], already: [], failed: [] });
});

check('补丁只匹配同一个插件名（不会把别人的补丁打进来）', () => {
    const { root } = makeRepo();
    const r = reapplyLocalPatches(root, 'other');
    assert.deepEqual(r, { applied: [], already: [], failed: [] });
});

check('当前仓库的 dshmarket 补丁已应用（防止提交前忘了重放）', () => {
    // 这条不是形式主义：改了 dshmarket 却没重新生成补丁时，CI 的
    // pack-all 会在上游同步后按**旧**补丁重放 —— 结果是把新代码打回旧版本。
    const r = reapplyLocalPatches(ROOT, 'dshmarket');
    assert.deepEqual(r.applied, [], '补丁未应用或与工作区不一致：先 git apply 或重新生成补丁');
    assert.deepEqual(r.failed, [], '补丁与工作区不一致：重新生成 scripts/patches/dshmarket-legacy-compat.patch');
    assert.deepEqual(r.already, ['dshmarket-legacy-compat.patch'], '应当正好一个补丁，且已在工作区生效');
});

if (failed > 0) {
    console.error('');
    console.error(`${failed} 项失败 / ${passed + failed} 项。`);
    process.exit(1);
}
console.log(`\n${passed} 项全部通过。`);
