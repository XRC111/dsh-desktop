/**
 * 旧插件兼容层 —— dsh-market 侧接入。
 *
 * ── 这个文件解决什么 ────────────────────────────────────────────────────────
 * dsh 0.2 起有一道安装前 gate：插件的 `engines.dsh` / `@deepseek-ai/dsh*` peer
 * 只要有一条不满足，`dsh plugin add` 会直接以
 *   `dsh: installation rejected: Plugin … is incompatible with dsh …`
 * 退出，而且**什么都没装**。唯一放行通道是 profile 目录下 `compatibility.json`
 * 里的精确豁免（`"包名@版本": ["0.2.1-rc.4"]`）。
 *
 * 生态里大量插件声明的是 `^0.1.5` 这类 0.1 线区间 —— 上界是 `0.2.0-0`，
 * 于是在 0.2.x 上必然不满足。但其中很多插件**实际能跑**：它们只用了
 * `ctx.effect`、`ctx.tools.register` 这类从未变过的 API。
 *
 * 本模块的立场：
 *   · 版本线跨线（0.1.x 声明 / 0.2.x 宿主）**不再直接判死**，标为"经兼容层"；
 *   · 但放行前必须**精确**写豁免，且每个豁免都只在精确版本对上生效 ——
 *     插件发了新版本要重新判，不会出现"一次放行、永久放行"；
 *   · 真正的静态校验（import 的包与符号还在不在）由桌面外壳在插件落位后做，
 *     因为只有那时才有源码。市场列表阶段只有 manifest，做不了。
 *
 * ── 为什么不在这里读插件源码 ────────────────────────────────────────────────
 * 列表阶段拿的是 npm manifest，没有 tarball。为每个候选下载解包会把一次
 * 列表请求变成上千次网络往返（上游 discovery-compatibility 的注释里也写了
 * 同样的顾虑）。所以这里只做**版本线**判断，源码判断交给外壳。
 *
 * ⚠️ 这个文件是**我们加的**，不在上游的 `src/` 里（同目录的其它 `lib/*.js`
 *    都是 `tsc` 从 `src/*.ts` 编译出来的）。后果有两层：
 *      · 同步上游会整目录覆盖它 → `pack-all-plugins.mjs` 会自动重放
 *        `scripts/patches/dshmarket-legacy-compat.patch`，打不上就构建失败；
 *      · 在这个目录里跑一次 `npm run build`（`prepare` 也会触发）→ tsc 只认
 *        `src/`，本文件会被**删掉**，另外两处改动也会被编译回上游版本。
 *        仓库里没有任何流程会跑它，但手工调试时别跑。CI 的
 *        `check-dshmarket-compat` 会在下一次构建时把这个状态打红。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/** dsh 认的豁免文件名（见 @deepseek-ai/dsh-app-boot 的 PROFILE_COMPATIBILITY_FILENAME）。 */
export const COMPATIBILITY_FILENAME = 'compatibility.json';

/** 兼容层仅覆盖 0.1.x 起的插件；更早的（0.0.x）不在承诺范围内。 */
const MIN_LINE = [0, 1];

/**
 * 从区间里取出它声明的版本线（`major.minor` 数组）。
 * 只看 `^` / `~` —— `>=0.1.0 <0.3.0` 这种宽区间本来就不会被判不兼容。
 *
 * @param {string} range
 * @returns {Array<[number, number]>}
 */
function declaredLines(range) {
    const lines = [];
    if (typeof range !== 'string') return lines;
    for (const alternative of range.split('||')) {
        for (const raw of alternative.trim().split(/\s+/).filter(Boolean)) {
            const m = /^(\^|~)\s*(\d+)\.(\d+)\./.exec(raw);
            if (m !== null) {
                const line = [Number(m[2]), Number(m[3])];
                if (!lines.some((x) => x[0] === line[0] && x[1] === line[1])) lines.push(line);
            }
        }
    }
    return lines;
}

/** 宿主所在的版本线。 */
function hostLine(hostVersion) {
    const m = /^(\d+)\.(\d+)\./.exec(String(hostVersion ?? ''));
    if (m === null) return null;
    return [Number(m[1]), Number(m[2])];
}

/** a 严格早于 b。 */
const before = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
const atLeast = (a, b) => !before(a, b);

/**
 * 这条声明是否属于「跨了版本线、但可能仍能跑」的情形。
 *
 * 判据：声明的 line 全部**早于**宿主所在线，且至少一条落在 0.1.x 及以后。
 * 与上游 `crossesImplicitCeiling` 的方向一致，但把「更老的线」也算进来 ——
 * 用户的插件可能还停在 0.1.2。
 *
 * @param {string} hostVersion 当前 dsh 版本
 * @param {string} range 插件声明的区间
 * @returns {boolean}
 */
export function crossesLine(hostVersion, range) {
    const host = hostLine(hostVersion);
    if (host === null) return false;
    const lines = declaredLines(range);
    if (lines.length === 0) return false;
    if (!lines.every((line) => before(line, host))) return false;
    return lines.some((line) => atLeast(line, MIN_LINE));
}

/**
 * 一个插件的哪些声明需要走兼容层。
 *
 * @param {object} manifest 插件 package.json
 * @param {string} hostVersion
 * @returns {{engine: string|null, peers: Record<string,string>}}
 *   `engine` 是 `engines.dsh` 的区间（若有）；`peers` 是跨线的那些 peer。
 *   两者都为空表示不需要兼容层。
 */
export function bridgeableDeclarations(manifest, hostVersion) {
    const out = { engine: null, peers: {} };
    const engines = manifest?.engines;
    if (engines !== null && typeof engines === 'object' && typeof engines.dsh === 'string') {
        // dsh 的规则：有 engines.dsh 就只看它，peer 一概不看。
        if (crossesLine(hostVersion, engines.dsh)) out.engine = engines.dsh;
        return out;
    }
    const peers = manifest?.peerDependencies;
    if (peers === null || typeof peers !== 'object') return out;
    for (const [name, range] of Object.entries(peers)) {
        if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue;
        if (typeof range !== 'string') continue;
        if (crossesLine(hostVersion, range)) out.peers[name] = range;
    }
    return out;
}

/** 该插件是否值得走兼容层（至少有一条跨线声明）。 */
export function isBridgeable(manifest, hostVersion) {
    const d = bridgeableDeclarations(manifest, hostVersion);
    return d.engine !== null || Object.keys(d.peers).length > 0;
}

/**
 * 读 profile 现有的豁免。
 *
 * 容错策略与 dsh 自己一致：读不动就当没有，坏文件不能把 profile 变砖。
 * 但**不吞掉**「文件存在且非法」这件事 —— 那样会静默覆盖用户手写的豁免。
 *
 * @param {string} dir profile 目录
 * @returns {{exemptions: Record<string,string[]>, rewritable: boolean}}
 */
export function readExemptions(dir) {
    const file = join(dir, COMPATIBILITY_FILENAME);
    if (!existsSync(file)) return { exemptions: {}, rewritable: true };
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return { exemptions: {}, rewritable: false };
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { exemptions: {}, rewritable: false };
    }
    const exemptions = {};
    for (const [key, value] of Object.entries(parsed)) {
        if (Array.isArray(value) && value.every((v) => typeof v === 'string')) exemptions[key] = value;
    }
    return { exemptions, rewritable: true };
}

/**
 * 把一批豁免合并进 profile 的 compatibility.json。
 *
 * ⚠️ 为什么必须合并而不是覆盖：这个文件里可能已经有用户手动
 *    `dsh plugin allow-version` 写的条目，覆盖等于把人家的授权删了。
 *
 * ⚠️ 为什么要原子写：dsh 在启动时会读它，半截文件会让 readProfileCompatibility
 *    走「不可读 → 当作没有豁免」的分支，表现是「明明授权过，重启又装不上」。
 *
 * @param {string} dir profile 目录
 * @param {Record<string,string[]>} additions 形如 `{"pkg@1.0.0": ["0.2.1-rc.4"]}`
 * @returns {{written: boolean, added: string[], skipped: string[]}}
 */
export function mergeExemptions(dir, additions) {
    const existing = readExemptions(dir);
    // 文件存在但读不了：不覆盖。宁可这次不放行，也不能把人家的授权抹掉。
    if (!existing.rewritable) {
        return { written: false, added: [], skipped: Object.keys(additions), reason: 'unreadable' };
    }
    const merged = { ...existing.exemptions };
    const added = [];
    for (const [key, versions] of Object.entries(additions)) {
        const current = merged[key] ?? [];
        const next = [...current];
        for (const version of versions) if (!next.includes(version)) next.push(version);
        if (next.length !== current.length) added.push(key);
        merged[key] = next;
    }
    if (added.length === 0) return { written: false, added: [], skipped: [] };

    mkdirSync(dir, { recursive: true });
    const file = join(dir, COMPATIBILITY_FILENAME);
    const temp = `${file}.tmp`;
    const sorted = {};
    for (const key of Object.keys(merged).sort()) sorted[key] = merged[key];
    writeFileSync(temp, JSON.stringify(sorted, null, 2) + '\n', { mode: 0o600 });
    renameSync(temp, file);
    return { written: true, added, skipped: [] };
}

/**
 * 从 `dsh plugin add` 的目标里取出「精确的 name@version」。
 *
 * ── 为什么这一步决定整个功能是否生效 ────────────────────────────────────────
 * 只有精确版本才写得出一条合法豁免（dsh 只认 `包名@1.2.3`）。如果这里判错，
 * 结果不是报错，而是**一条豁免都不写** —— 安装照常被 gate 拒绝，用户看到的
 * 是原来那句 incompatible，而我们这边静默什么都不做。
 *
 * 市场点安装时实际传入的目标形态（见 routes.js 的 pinnedTarget）：
 *   `@scope/name@1.2.3`   常规路径，registry latest 解析成功时必然是这个形态
 *   `@scope/name@1.2.3-rc.1` / `...@1.2.3+build`  预发布与 build 元数据要保留
 *   `@scope/name`         registry 读不到时的退路 —— 拿不到版本，写不了豁免
 *   `@scope/name@latest`  标签，同理
 *   `github:owner/repo#sha` / `https://…` / `file:…`  不是 npm 版本
 *
 * @param {string} target
 * @returns {{name: string, version: string}|null}
 */
export function parseExactTarget(target) {
    if (typeof target !== 'string') return null;
    // 前后空白、`\r`（从 Windows 剪贴板粘来的目标）都先清掉：留着会让正则
    // 在 `$` 处失配，然后整条豁免静默消失。
    const trimmed = target.trim();
    // 协议前缀的目标（git/https/file/link）一律不认。`git+https://…@1.2.3`
    // 这种形态虽然含 `@`，但那是 URL 的一部分，不是版本。
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) return null;
    const m = /^(@?[^@]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(trimmed);
    if (m === null) return null;
    return { name: m[1], version: m[2] };
}

/**
 * 给一次安装准备豁免：manifest 里跨线的声明 → 精确豁免条目。
 *
 * 返回空对象表示「这条插件不需要兼容层」（版本本来就满足，或者不是跨线情形）。
 *
 * @param {object} manifest
 * @param {string} hostVersion
 * @returns {Record<string,string[]>}
 */
export function exemptionsFor(manifest, hostVersion) {
    if (!isBridgeable(manifest, hostVersion)) return {};
    const name = manifest?.name;
    const version = manifest?.version;
    // 没有精确版本就没法写豁免 —— dsh 只认 name@version。
    if (typeof name !== 'string' || typeof version !== 'string') return {};
    return { [`${name}@${version}`]: [hostVersion] };
}
