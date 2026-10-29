#!/usr/bin/env node
/**
 * 行为测试：`resources/dsh-plugins/dshmarket/lib/legacy-compat.js`
 *
 * ── 为什么要单独测它 ────────────────────────────────────────────────────────
 * 这个模块只在两种时刻起作用：市场列表里一个插件「看起来不兼容」、或者用户
 * 点了一次「安装」。两种情况都没法在 CI 里跑 —— 前者要连 npm 上看真实生态，
 * 后者要真的把包装进 profile。而它一旦判错，症状是**沉默**的：
 *
 *   · 判宽了 → 装上一个跑不起来的插件，用户看到的是插件报错，不是市场报错；
 *   · 判严了 → 能用的插件装不上，用户以为「这个插件坏了」。
 *
 * 所以把判据本身钉在测试里。`check-dshmarket-compat.mjs` 只保证「代码还在」，
 * 这个保证「代码还是那个意思」—— 上游同步后重放补丁时，patch 能打上不代表
 * 语义没被改坏。
 *
 * ── 为什么不用 node:test ────────────────────────────────────────────────────
 * 它要进 `.github/workflows/build-release.yml` 的回归列表，那里是逐个
 * `node scripts/<name>.mjs` 跑、看 $LASTEXITCODE。普通脚本最省事。
 *
 * 跑法：node scripts/dshmarket-legacy-compat.test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOD = path.join(ROOT, 'resources/dsh-plugins/dshmarket/lib/legacy-compat.js');

const { crossesLine, bridgeableDeclarations, isBridgeable, exemptionsFor, readExemptions, mergeExemptions, parseExactTarget } =
    await import(MOD);
// 直接用上游那套 semver 复核方向 —— 它就是 dsh gate 的镜像。
const { satisfiesRange } = await import(path.join(ROOT, 'resources/dsh-plugins/dshmarket/lib/check.js'));

const HOST = '0.2.1-rc.4';

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

/** 临时 profile 目录。 */
function tmpProfile() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-legacy-compat-'));
}

// ── crossesLine：什么算「跨版本线」 ──────────────────────────────────────────
// 这是整个模块的分界线。判错的后果两个方向都很糟，所以每种形态都列出来。

check('^0.1.5 遇上 0.2.x 宿主 → 跨线', () => {
    assert.equal(crossesLine(HOST, '^0.1.5'), true);
    // 0.1.2 也要算：用户的插件可能停得更早，不能只认 ^0.1.5 以上。
    assert.equal(crossesLine(HOST, '^0.1.2'), true);
});

check('~0.1.x 与 ^0.1.x 同等对待', () => {
    assert.equal(crossesLine(HOST, '~0.1.7'), true);
    // 带 rc 后缀的声明同样是 0.1 线。
    assert.equal(crossesLine(HOST, '^0.1.2-alpha.1'), true);
});

check('^0.2.0（同线）→ 不跨线', () => {
    // 这条**必须**是 false：它本来就满足，判成跨线会给一个正常插件写豁免，
    // 等于凭空绕过一次 gate。
    assert.equal(crossesLine(HOST, '^0.2.0'), false);
});

check('^0.3.0（更高的线）→ 不跨线', () => {
    // 声明比宿主新，那是插件太新，不是兼容层该管的事（该升级的是 dsh）。
    assert.equal(crossesLine(HOST, '^0.3.0'), false);
});

check('宽区间（>=0.1.0 <0.3.0）→ 不跨线', () => {
    // 这种声明在 0.2.1 上本来就满足，dsh 不会拒，兼容层不该插手。
    assert.equal(crossesLine(HOST, '>=0.1.5 <0.3.0'), false);
});

check('^0.0.x 也跨线（全版本，不再有 0.1 下限）', () => {
    // 旧实现有 `MIN_LINE = [0,1]`，把 0.0.x 排除在外，理由是「太老，连 API 都
    // 对不上，不该静默放行」。但那等于替作者断言他用了哪些 API —— 而 0.0.1
    // 时代就有的 ctx.effect / ctx.tools.register 今天一个都没变。真正的判断
    // 依据只能是插件源码（外壳侧干的事），不是它写在 package.json 里的号。
    assert.equal(crossesLine(HOST, '^0.0.9'), true);
    assert.equal(crossesLine(HOST, '^0.0.1'), true);
    assert.equal(crossesLine(HOST, '~0.0.5'), true);
});

check('不含 ^ / ~ 的老声明同样跨线', () => {
    // 旧实现只从 `^` / `~` 里提版本线，注释里假设「宽区间本来就不会被判不
    // 兼容」。这个假设是错的：下面每一条都把 0.2.1 排除在外，而它们一条都
    // 不含 caret/tilde —— 于是市场照旧判死，用户点不了安装。
    assert.equal(crossesLine(HOST, '>=0.0.1 <0.1.0'), true);
    assert.equal(crossesLine(HOST, '<=0.1.9'), true);
    assert.equal(crossesLine(HOST, '<0.1.0'), true);
    assert.equal(crossesLine(HOST, '0.1.5'), true); // 精确钉在旧版本上
    assert.equal(crossesLine(HOST, '>0.1.0 <0.2.0'), true);
});

check('通配形式的旧线也跨线', () => {
    // registry 上大量 `0.1.x` / `0.x`。`satisfiesRange` 对它们返回 null（它
    // 只认精确的目标版本），所以这条走的是 floorOf 的通配展开分支。
    assert.equal(crossesLine(HOST, '0.1.x'), true);
    assert.equal(crossesLine(HOST, '0.1.*'), true);
});

check('要求更高版本 → 不跨线（该升级的是 dsh，不是兼容层）', () => {
    // 方向判定：下界高于宿主 = 插件要的是未来版本，宿主确实没有那些 API。
    // 把它判成跨线会让用户装上一个必然跑不起来的插件。
    assert.equal(crossesLine(HOST, '>=0.2.2'), false);
    assert.equal(crossesLine(HOST, '>0.2.1'), false);
    assert.equal(crossesLine(HOST, '^1.0.0'), false);
    assert.equal(crossesLine(HOST, '>=0.3.0 <0.4.0'), false);
});

check('区间里只要有一条落在宿主线或更高 → 不跨线', () => {
    // `^0.1.5 || ^0.2.0` 这种「新旧都支持」的声明，dsh 会因 ^0.2.0 满足而放行。
    assert.equal(crossesLine(HOST, '^0.1.5 || ^0.2.0'), false);
});

check('判据不写死任何一条线：宿主升到 0.3 / 1.0 时同样成立', () => {
    // 「全版本」的另一个方向是未来。只要插件声明的是更早的线，结论就一样 ——
    // 实现里没有任何 `0.1` / `0.2` 的字面量，这条断言就是钉住这一点。
    assert.equal(crossesLine('0.3.0-rc.1', '^0.2.0'), true);
    assert.equal(crossesLine('0.3.0-rc.1', '^0.1.5'), true);
    assert.equal(crossesLine('1.0.0', '^0.2.0'), true);
    assert.equal(crossesLine('0.3.0-rc.1', '^0.3.0'), false);
    assert.equal(crossesLine('0.3.0-rc.1', '^0.4.0'), false);
});

check('无法解析的宿主版本 → 一律不跨线（保守）', () => {
    assert.equal(crossesLine('not-a-version', '^0.1.5'), false);
    assert.equal(crossesLine(null, '^0.1.5'), false);
});

check('判跨线的声明，一定是 gate 会拒的（否则等于凭空绕过一次 gate）', () => {
    // 这是整件事的安全底线：市场判「跨线」→ 安装前写豁免 → gate 放行。
    // 如果那条声明其实是满足的，这一步就是给一个正常插件白送一条豁免。
    //
    // 用同一套 satisfiesRange 复核（它跟 dsh gate 是同一份 node-semver 语义）。
    // 允许 null：`0.1.x` 这种通配 check.js 解析不了，但它在旧宿主上确实不满足 ——
    // crossesLine 走的是版本线比较那条路，不是「确定不满足」那条。
    const forms = [
        '^0.0.1', '^0.0.5', '~0.0.1', '^0.1.2', '^0.1.5', '~0.1.7', '^0.1.2-alpha.1',
        '^0.1.5 || ^0.2.0', '^0.2.0', '^0.3.0', '>=0.1.5 <0.3.0', '>=0.2.2', '*',
        '>=0.0.1 <0.1.0', '<=0.1.9', '<0.1.0', '0.1.5', '0.1.x', '0.1.*',
        '>0.1.0 <0.2.0', '^1.0.0', '>=0.3.0 <0.4.0', '0.2.x', '<=0.0.9',
    ];
    for (const range of forms) {
        if (!crossesLine(HOST, range)) continue;
        assert.notEqual(satisfiesRange(HOST, range, { includePrerelease: true }), true,
            `${range} 被判跨线，但 gate 认为它满足`);
    }
});

check('同线通配不会误伤（0.1.x 在 0.1.5 上本来就满足）', () => {
    // 这条是上面那个「退到版本线比较」分支的反面：check.js 解析不了 `0.1.x`，
    // 如果直接按下界比，0.1.0 ≤ 0.1.5 就会被判跨线 —— 而它明明满足。
    assert.equal(crossesLine('0.1.5-rc.3', '0.1.x'), false);
    assert.equal(crossesLine('0.2.1-rc.4', '0.2.x'), false);
    assert.equal(crossesLine('0.1.5-rc.3', '0.1.*'), false);
});

// ── bridgeableDeclarations ──────────────────────────────────────────────────

check('有 engines.dsh 就只看它，peer 一概不看', () => {
    // dsh 自己的规则（见 dsh-app-boot 的 evaluatePluginCompatibility）：
    // engines.dsh 存在时 peer 不参与判定。这里必须复现同一个规则，
    // 否则会给一个「engines 满足但 peer 跨线」的插件发豁免，而 dsh 根本不会拒它 ——
    // 豁免写了也没用，只会让 compatibility.json 长出无法解释的条目。
    const d = bridgeableDeclarations({
        engines: { dsh: '^0.2.0' },
        peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.5' },
    }, HOST);
    assert.equal(d.engine, null);
    assert.deepEqual(d.peers, {});
});

check('engines.dsh 跨线 → 记 engine', () => {
    const d = bridgeableDeclarations({ engines: { dsh: '^0.1.5' } }, HOST);
    assert.equal(d.engine, '^0.1.5');
});

check('没有 engines 时，跨线的 dsh* peer 逐条记下', () => {
    const d = bridgeableDeclarations({
        peerDependencies: {
            '@deepseek-ai/dsh-tools': '^0.1.5',
            '@deepseek-ai/dsh-session': '^0.2.0',
            'some-other-pkg': '^0.1.0',
        },
    }, HOST);
    assert.deepEqual(d.peers, { '@deepseek-ai/dsh-tools': '^0.1.5' });
});

check('不声明任何版本 → 不需要兼容层', () => {
    assert.equal(isBridgeable({}, HOST), false);
    assert.equal(isBridgeable({ peerDependencies: { lodash: '^1.0.0' } }, HOST), false);
});

// ── exemptionsFor：豁免长什么样 ─────────────────────────────────────────────

check('豁免键是精确 name@version，值是精确宿主版本', () => {
    const out = exemptionsFor({ name: '@x/old', version: '1.2.3', engines: { dsh: '^0.1.5' } }, HOST);
    // 少一个字符 dsh 的 readProfileCompatibility 就把整条丢掉，还不报错。
    assert.deepEqual(out, { '@x/old@1.2.3': [HOST] });
});

check('版本本来就满足 → 不产生豁免', () => {
    assert.deepEqual(exemptionsFor({ name: '@x/new', version: '2.0.0', engines: { dsh: '^0.2.0' } }, HOST), {});
});

check('manifest 缺 name 或 version → 不产生豁免（写不出合法键）', () => {
    assert.deepEqual(exemptionsFor({ engines: { dsh: '^0.1.5' } }, HOST), {});
    assert.deepEqual(exemptionsFor({ name: '@x/old', engines: { dsh: '^0.1.5' } }, HOST), {});
});

// ── parseExactTarget：安装目标里能不能取出精确版本 ──────────────────────────
// 这一步判错的表现是「一条豁免都不写」：安装照旧被 gate 拒绝，用户看到原来
// 那句 incompatible，而市场这边不报错、不告警，没有任何线索指向这里。

check('常规安装目标 @scope/name@1.2.3 → 拆得开', () => {
    assert.deepEqual(parseExactTarget('@linxin/dsh-foo@1.2.3'), { name: '@linxin/dsh-foo', version: '1.2.3' });
    assert.deepEqual(parseExactTarget('dsh-foo@1.2.3'), { name: 'dsh-foo', version: '1.2.3' });
});

check('预发布与 build 元数据保留原样', () => {
    // 去掉 `-rc.1` 会写出一个指向不存在版本的豁免 —— dsh 会照常拒绝。
    assert.deepEqual(parseExactTarget('@x/y@0.1.5-rc.1'), { name: '@x/y', version: '0.1.5-rc.1' });
    assert.deepEqual(parseExactTarget('@x/y@1.2.3+build.7'), { name: '@x/y', version: '1.2.3+build.7' });
});

check('标签 / 裸名 / 区间 → null（拿不到确切的版本）', () => {
    for (const t of ['@x/y', '@x/y@latest', '@x/y@next', '@x/y@^1.2.3', '@x/y@~1.2', '@x/y@>=1.0.0']) {
        assert.equal(parseExactTarget(t), null, `应当判 null：${t}`);
    }
});

check('git / https / file 目标 → null（含 @ 的也不能误判）', () => {
    // `git+https://…@1.2.3` 里的 @ 是 URL 的一部分，不是版本。
    // 误判会把仓库名当包名写进豁免，dsh 读到一条无关键，什么都不发生。
    assert.equal(parseExactTarget('github:owner/repo#abc123'), null);
    assert.equal(parseExactTarget('git+https://github.com/o/r.git@1.2.3'), null);
    assert.equal(parseExactTarget('https://example.com/x.tgz'), null);
    assert.equal(parseExactTarget('file:../local-plugin'), null);
    assert.equal(parseExactTarget('link:../local-plugin'), null);
});

check('前缀 v 的版本号不算精确版本（Docker 式写法，npm 不认）', () => {
    assert.equal(parseExactTarget('@x/y@v1.2.3'), null);
});

check('非字符串 / 空值 → null', () => {
    assert.equal(parseExactTarget(null), null);
    assert.equal(parseExactTarget(undefined), null);
    assert.equal(parseExactTarget(''), null);
});

check('首尾空白被清掉（Windows 剪贴板会带 \\r）', () => {
    assert.deepEqual(parseExactTarget(' @x/y@1.2.3\r'), { name: '@x/y', version: '1.2.3' });
});

// ── mergeExemptions：写盘 ───────────────────────────────────────────────────

check('合并写入不会删掉用户手写的条目', () => {
    // 这是最容易写错、后果也最重的一条：整体覆盖等于把用户的
    // `dsh plugin allow-version` 授权删了，表现是「授权过，重启又装不上」。
    const dir = tmpProfile();
    fs.writeFileSync(path.join(dir, 'compatibility.json'), JSON.stringify({ 'user/manual@0.0.1': ['0.2.1'] }));
    const r = mergeExemptions(dir, { '@x/old@1.2.3': [HOST] });
    assert.equal(r.written, true);
    assert.deepEqual(r.added, ['@x/old@1.2.3']);
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'compatibility.json'), 'utf8'));
    assert.deepEqual(after, { 'user/manual@0.0.1': ['0.2.1'], '@x/old@1.2.3': [HOST] });
});

check('重复写同一条是幂等的', () => {
    const dir = tmpProfile();
    mergeExemptions(dir, { '@x/old@1.2.3': [HOST] });
    const again = mergeExemptions(dir, { '@x/old@1.2.3': [HOST] });
    assert.equal(again.written, false, '第二次不应再写盘');
});

check('文件存在但坏了 → 拒绝覆盖', () => {
    // 读不动就整份不动。覆盖的代价是用户已有的授权全部消失，而用户完全
    // 不知道发生过什么。
    const dir = tmpProfile();
    fs.writeFileSync(path.join(dir, 'compatibility.json'), '{ not json');
    const r = mergeExemptions(dir, { '@x/old@1.2.3': [HOST] });
    assert.equal(r.written, false);
    assert.equal(r.reason, 'unreadable');
    assert.equal(fs.readFileSync(path.join(dir, 'compatibility.json'), 'utf8'), '{ not json');
});

check('数组形态的 JSON 也算坏文件（dsh 只接受 map）', () => {
    const dir = tmpProfile();
    fs.writeFileSync(path.join(dir, 'compatibility.json'), '[]');
    const r = mergeExemptions(dir, { '@x/old@1.2.3': [HOST] });
    assert.equal(r.written, false);
    assert.equal(r.reason, 'unreadable');
});

check('目录不存在时会建出来', () => {
    const base = tmpProfile();
    const dir = path.join(base, 'profiles', 'web');
    const r = mergeExemptions(dir, { '@x/old@1.2.3': [HOST] });
    assert.equal(r.written, true);
    assert.deepEqual(readExemptions(dir).exemptions, { '@x/old@1.2.3': [HOST] });
});

check('写入过程不留 .tmp 残留', () => {
    // 原子写是 `写 .tmp → rename`。留下 .tmp 说明 rename 没走到，
    // 而 dsh 启动时读的是正式文件 —— 那种情况下写盘等于没写。
    const dir = tmpProfile();
    mergeExemptions(dir, { '@x/old@1.2.3': [HOST] });
    assert.deepEqual(fs.readdirSync(dir), ['compatibility.json']);
});

check('坏条目（值不是字符串数组）被忽略，不传染整份文件', () => {
    const dir = tmpProfile();
    fs.writeFileSync(path.join(dir, 'compatibility.json'), JSON.stringify({
        'good@1.0.0': ['0.2.1'],
        'bad@1.0.0': 'not-an-array',
        'worse@1.0.0': [1, 2],
    }));
    assert.deepEqual(readExemptions(dir).exemptions, { 'good@1.0.0': ['0.2.1'] });
});

if (failed > 0) {
    console.error('');
    console.error(`${failed} 项失败 / ${passed + failed} 项。`);
    console.error('这个模块判错的症状是沉默的（装不上能用的插件，或装上跑不起来的插件），');
    console.error('所以这些断言不是形式主义 —— 改判据前先确认改的是想要的方向。');
    process.exit(1);
}
console.log(`\n${passed} 项全部通过。`);
