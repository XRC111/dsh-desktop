"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.Updater = void 0;
exports.compareVersions = compareVersions;
exports.loadUpdateConfig = loadUpdateConfig;
exports.pickFileForThisMachine = pickFileForThisMachine;
const electron_1 = require("electron");
const child_process_1 = require("child_process");
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const stream_1 = require("stream");
const stream_2 = require("stream");
const promises_1 = require("stream/promises");
const logger_1 = require("./logger");
const hot_shell_1 = require("./hot-shell");
const runtime_patch_1 = require("./runtime-patch");
const paths_1 = require("./paths");
const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);
/** 默认占位源：未配置时更新功能整体关闭（不会每次启动都去请求） */
const PLACEHOLDER_HOSTS = ['example.com', 'example.org', 'your-domain.com'];
const FETCH_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
/** 启动后延迟多久检查更新：别和 dsh 启动抢 I/O */
const STARTUP_DELAY_MS = 25_000;
// ---------------------------------------------------------------------------
// 版本比较（支持 1.0.10 > 1.0.9、1.1.0-rc.1 < 1.1.0）
// ---------------------------------------------------------------------------
function parseVersion(v) {
    const [core, ...rest] = String(v)
        .trim()
        .replace(/^v/i, '')
        .split('-');
    const nums = core.split('.').map((s) => {
        const n = parseInt(s.replace(/[^0-9]/g, ''), 10);
        return Number.isFinite(n) ? n : 0;
    });
    const pre = rest.join('-').split('.').filter(Boolean);
    return { nums, pre };
}
/** a > b → 正数；a < b → 负数；相等 → 0 */
function compareVersions(a, b) {
    const va = parseVersion(a);
    const vb = parseVersion(b);
    const len = Math.max(va.nums.length, vb.nums.length);
    for (let i = 0; i < len; i++) {
        const x = va.nums[i] ?? 0;
        const y = vb.nums[i] ?? 0;
        if (x !== y)
            return x > y ? 1 : -1;
    }
    // 正式版 > 预发布版（1.1.0 > 1.1.0-rc.1）
    if (va.pre.length === 0 && vb.pre.length > 0)
        return 1;
    if (va.pre.length > 0 && vb.pre.length === 0)
        return -1;
    for (let i = 0; i < Math.max(va.pre.length, vb.pre.length); i++) {
        const x = va.pre[i];
        const y = vb.pre[i];
        if (x === undefined)
            return -1;
        if (y === undefined)
            return 1;
        const nx = /^\d+$/.test(x);
        const ny = /^\d+$/.test(y);
        if (nx && ny) {
            const dx = parseInt(x, 10);
            const dy = parseInt(y, 10);
            if (dx !== dy)
                return dx > dy ? 1 : -1;
        }
        else if (x !== y) {
            return x > y ? 1 : -1;
        }
    }
    return 0;
}
// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
function isPlaceholder(url) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return PLACEHOLDER_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
    }
    catch {
        return true;
    }
}
function assertUrlAllowed(raw, allowHttp) {
    let u;
    try {
        u = new URL(raw);
    }
    catch {
        throw new Error(`更新源地址不合法：${raw}`);
    }
    const isLocal = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if (u.protocol === 'https:')
        return u.toString();
    if (u.protocol === 'http:' && (allowHttp || isLocal))
        return u.toString();
    throw new Error(`更新源必须使用 https（当前 ${u.protocol}//）`);
}
function loadUpdateConfig() {
    // 环境变量优先，便于联调与私有部署
    const envUrl = process.env.DSH_DESKTOP_UPDATE_URL?.trim();
    if (envUrl) {
        return {
            feedUrl: envUrl,
            checkOnStartup: true,
            checkIntervalHours: 6,
            allowInsecureHttp: true,
            // 联调方便：有更新就自动下载应用（配合 DSH_DESKTOP_UPDATE_DRYRUN=1 只到"已就位"为止）
            autoDownload: process.env.DSH_DESKTOP_UPDATE_AUTO === '1',
        };
    }
    const file = (0, paths_1.updateConfigFile)();
    if (!fs.existsSync(file)) {
        (0, logger_1.log)(`未找到更新配置 ${file}，热更新关闭`);
        return null;
    }
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const feedUrl = String(raw.feedUrl ?? '').trim();
        if (!feedUrl) {
            (0, logger_1.log)('更新配置里没有 feedUrl，热更新关闭');
            return null;
        }
        return {
            feedUrl,
            channel: raw.channel,
            checkOnStartup: raw.checkOnStartup !== false,
            checkIntervalHours: typeof raw.checkIntervalHours === 'number' && raw.checkIntervalHours > 0
                ? raw.checkIntervalHours
                : 6,
            autoDownload: raw.autoDownload === true,
            allowInsecureHttp: raw.allowInsecureHttp === true,
            disableHotUpdate: raw.disableHotUpdate === true,
            autoRestart: raw.autoRestart === true,
            restartDelaySeconds: typeof raw.restartDelaySeconds === 'number' && raw.restartDelaySeconds > 0
                ? raw.restartDelaySeconds
                : 60,
        };
    }
    catch (err) {
        (0, logger_1.log)(`解析更新配置失败：${String(err)}`);
        return null;
    }
}
// ---------------------------------------------------------------------------
// 更新器
// ---------------------------------------------------------------------------
class Updater {
    opts;
    state;
    config = null;
    persisted = {};
    timer = null;
    /** 检查中（与 applyUpdate 各自独立，否则 check 里派发的自动下载会被自己拦住） */
    checkBusy = false;
    /** 下载/应用中 */
    applyBusy = false;
    downloadedFilePath = null;
    downloadedVersion = null;
    /** 计划中的重启时间戳（毫秒），null = 没有计划 */
    pendingRestartAt = null;
    restartTimer = null;
    tickTimer = null;
    constructor(opts) {
        this.opts = opts;
        // 生效版本 = 热更新壳版本（若有）否则安装版：不这样比，热更新后会一直提示同一个版本
        this.state = { phase: 'idle', currentVersion: (0, hot_shell_1.shellVersion)() };
    }
    getState() {
        return { ...this.state };
    }
    init() {
        this.persisted = readPersisted();
        this.config = loadUpdateConfig();
        if (!this.config) {
            this.setState({ phase: 'disabled', message: '未配置更新源' });
            return;
        }
        let feedUrl;
        try {
            feedUrl = assertUrlAllowed(this.config.feedUrl, this.config.allowInsecureHttp === true);
        }
        catch (err) {
            this.setState({ phase: 'disabled', message: String(err.message ?? err) });
            (0, logger_1.log)(`更新源被拒绝：${this.state.message}`);
            return;
        }
        if (isPlaceholder(feedUrl)) {
            this.setState({ phase: 'disabled', feedUrl, message: '更新源仍是示例地址，请在 update-config.json 里改成真实地址' });
            (0, logger_1.log)('更新源仍是占位地址，热更新关闭');
            return;
        }
        this.setState({ phase: 'idle', feedUrl });
        if (this.config.checkOnStartup) {
            const t = setTimeout(() => {
                void this.check({ interactive: false });
            }, STARTUP_DELAY_MS);
            t.unref?.();
        }
        this.scheduleInterval();
    }
    /** 手动检查（托盘菜单 / IPC）。interactive=true 时会弹结果对话框 */
    async check(options) {
        const interactive = options.interactive;
        if (this.checkBusy) {
            if (interactive) {
                await electron_1.dialog.showMessageBox({
                    type: 'info',
                    title: '检查更新',
                    message: '正在处理上一个更新任务，请稍候。',
                    buttons: ['好'],
                });
            }
            return this.getState();
        }
        if (!this.config || this.state.phase === 'disabled') {
            if (interactive) {
                await electron_1.dialog.showMessageBox({
                    type: 'warning',
                    title: '检查更新',
                    message: '未配置更新源。',
                    detail: `请编辑 ${(0, paths_1.updateConfigFile)()} 填入云端 JSON 地址（feedUrl），\n` +
                        '或设置环境变量 DSH_DESKTOP_UPDATE_URL。',
                    buttons: ['好'],
                });
            }
            return this.getState();
        }
        this.checkBusy = true;
        this.setState({ phase: 'checking', message: '正在检查更新…' });
        try {
            const feed = await this.fetchFeed();
            this.persisted.lastCheckAt = Date.now();
            writePersisted(this.persisted);
            const current = (0, hot_shell_1.shellVersion)();
            const latest = String(feed.version ?? '').trim();
            if (!latest)
                throw new Error('云端 JSON 缺少 version 字段');
            const shellOutdated = compareVersions(latest, current) > 0;
            const skipped = this.persisted.skippedVersion === latest;
            const mandatory = feed.mandatory === true ||
                (!!feed.minSupportedVersion && compareVersions(current, feed.minSupportedVersion) < 0);
            const hot = this.pickHot(feed);
            // 关键：外壳已是最新时也要看其它通道（运行时/插件）——
            // 否则「只发运行时补丁」的那种版本会被判成"已是最新"而永远推不出去。
            const rt = this.pickRuntime(feed);
            const plugins = this.pickPlugins(feed);
            const available = shellOutdated || !!rt || !!plugins;
            (0, logger_1.log)(`更新检查：当前 ${current} / 云端 ${latest} → ${shellOutdated ? '有更新' : '已是最新'}` +
                `${hot ? '（可用热更新）' : ''}${rt ? `（有运行时更新 ${rt.version}）` : ''}${plugins ? `（有新插件 ${plugins.name ?? plugins.version}）` : ''}` +
                `${skipped ? '（该版本已被用户跳过）' : ''}`);
            // 插件：新增能力，静默后台安装（不该要求用户决策）。
            // 关键是**无论有没有其它更新都要装** —— 否则外壳已是最新时插件永远推不下去。
            if (plugins)
                this.installPluginsQuietly(plugins);
            if (!available) {
                this.setState({
                    phase: 'up-to-date',
                    latestVersion: latest,
                    checkedAt: this.persisted.lastCheckAt,
                    message: plugins ? '正在安装新插件…' : `已是最新版本（${current}）`,
                });
                if (interactive && !plugins) {
                    await electron_1.dialog.showMessageBox({
                        type: 'info',
                        title: '检查更新',
                        message: `已是最新版本（${current}）`,
                        buttons: ['好'],
                    });
                }
                return this.getState();
            }
            const pluginsOnly = !shellOutdated && !rt && !!plugins;
            this.setState({
                phase: 'available',
                latestVersion: latest,
                notes: feed.notes,
                mandatory,
                viaHot: !!hot,
                hotVersion: hot?.version,
                checkedAt: this.persisted.lastCheckAt,
                message: pluginsOnly
                    ? `正在安装新组件 ${plugins?.name ?? ''}…`
                    : !shellOutdated && rt
                        ? `发现运行时更新 ${rt.version}（外壳已是最新的 ${current}）`
                        : hot
                            ? `发现新版本 ${latest}（热更新，重启即生效）`
                            : `发现新版本 ${latest}`,
            });
            if (this.config.autoDownload) {
                void this.applyUpdate({ interactive: false });
            }
            else if (!skipped && !pluginsOnly) {
                // 仅插件待装时不发"有新版本"气泡：插件在后台静默装，装完托盘会提示重启
                this.opts.notify('DSH Desktop 有新版本', !shellOutdated && rt
                    ? `Harness 运行时 ${rt.version} 已发布，重启即可生效（托盘菜单可立即应用）。`
                    : hot
                        ? `${latest} 已发布，热更新只需重启即可生效（托盘菜单可立即安装）。`
                        : `${latest} 已发布，点击托盘菜单「检查更新」即可安装。`);
            }
            if (interactive)
                await this.promptAvailable(feed, mandatory, skipped, hot);
            return this.getState();
        }
        catch (err) {
            const message = String(err?.message ?? err);
            (0, logger_1.log)(`检查更新失败：${message}`);
            this.setState({ phase: 'error', message: `检查更新失败：${message}` });
            if (interactive) {
                await electron_1.dialog.showMessageBox({
                    type: 'error',
                    title: '检查更新',
                    message: '检查更新失败',
                    detail: `${message}\n\n更新源：${this.config.feedUrl}`,
                    buttons: ['好'],
                });
            }
            return this.getState();
        }
        finally {
            this.checkBusy = false;
        }
    }
    /**
     * 应用更新。
     *
     * mode:
     *   'auto'（默认）— 云端给了可用的热更新包就走热更新（重启即生效），否则走完整安装包
     *   'hot'         — 强制热更新（没有可用热更新包就报错）
     *   'installer'   — 强制完整安装包
     */
    async applyUpdate(options) {
        if (this.applyBusy) {
            (0, logger_1.log)('已有更新任务在进行中，忽略本次请求');
            return;
        }
        this.applyBusy = true;
        try {
            const feed = await this.fetchFeed();
            const mode = options.mode ?? 'auto';
            // 强制通道：只做那一件事
            if (mode === 'hot') {
                const hot = this.pickHot(feed);
                if (!hot)
                    throw new Error('云端没有可用的热更新包（或它的 baseVersion 与当前安装版不匹配）');
                const v = await this.stageHot(hot, hot.version || feed.version);
                await this.finalizeStaged(options.interactive, [`热更新 ${v}`]);
                return;
            }
            if (mode === 'runtime') {
                const rt = this.pickRuntime(feed);
                if (!rt)
                    throw new Error('云端没有可用的运行时补丁（或它的基线版本与当前运行时不匹配）');
                const v = await this.stageRuntime(rt);
                await this.finalizeStaged(options.interactive, [`运行时 ${v}`]);
                return;
            }
            if (mode === 'installer') {
                await this.applyInstaller(feed, options.interactive);
                return;
            }
            // auto：能热更的都热更（外壳 + 运行时可以一起落位，重启一次同时生效）
            const hot = this.pickHot(feed);
            const rt = this.pickRuntime(feed);
            const plugins = this.pickPlugins(feed);
            if (!hot && !rt && !plugins) {
                await this.applyInstaller(feed, options.interactive);
                return;
            }
            const labels = [];
            if (hot)
                labels.push(`热更新 ${await this.stageHot(hot, hot.version || feed.version)}`);
            if (rt)
                labels.push(`运行时 ${await this.stageRuntime(rt)}`);
            // 插件属于"新增能力"，不必让用户决策，自动落位后随其它更新一起提示重启
            if (plugins) {
                try {
                    await this.stagePlugins(plugins);
                    labels.push(`插件 ${plugins.name ?? plugins.version}`);
                }
                catch (err) {
                    (0, logger_1.log)(`插件安装失败（不阻断其它更新）：${String(err?.message ?? err)}`);
                }
            }
            await this.finalizeStaged(options.interactive, labels);
        }
        catch (err) {
            const message = String(err?.message ?? err);
            (0, logger_1.log)(`更新失败：${message}`);
            this.setState({ phase: 'error', message: `更新失败：${message}` });
            if (options.interactive) {
                await electron_1.dialog.showMessageBox({
                    type: 'error',
                    title: '更新失败',
                    message: '下载或应用更新失败',
                    detail: message,
                    buttons: ['好'],
                });
            }
        }
        finally {
            this.applyBusy = false;
        }
    }
    /** 兼容旧调用名 */
    async downloadAndInstall(options) {
        return this.applyUpdate(options);
    }
    /**
     * 挑出可用的热更新包（OTA 式）：
     *   - `hot` 可以是单个包或升级链（数组）
     *   - baseVersion 当作**最低**支持版本：`app.getVersion() >= baseVersion` 就可用
     *   - 在所有能用的里面挑**版本号最高**的 → 客户端每次都能直接爬到最新，
     *     发版时也不用再为每个旧版本单独配基线
     */
    pickHot(feed) {
        if (this.config?.disableHotUpdate)
            return null;
        const all = asArray(feed.hot).filter((h) => h?.url && h?.version);
        if (all.length === 0)
            return null;
        const installed = electron_1.app.getVersion();
        const usable = all.filter((h) => !h.baseVersion || compareVersions(installed, h.baseVersion) >= 0);
        if (usable.length === 0) {
            const floors = all.map((h) => `${h.version}(需≥${h.baseVersion})`).join('、');
            (0, logger_1.log)(`热更新包都不适用当前安装版 ${installed}：${floors} → 改用完整安装包`);
            return null;
        }
        // 能用的里面挑版本最高的
        usable.sort((a, b) => compareVersions(b.version, a.version));
        const best = usable[0];
        if (all.length > 1)
            (0, logger_1.log)(`热更新升级链里有 ${all.length} 档，当前安装版 ${installed} 可跳到 ${best.version}`);
        return best;
    }
    /**
     * 当前实际在用的运行时目录。
     * 统一走 `findRuntimeDir()`，别再用 `dshRuntimeDir()`（打包态它指向用户数据目录的兜底位置）。
     */
    currentRuntimeDir() {
        return (0, runtime_patch_1.findRuntimeDir)();
    }
    /**
     * 挑出需要安装/更新的插件包。
     *
     * 为什么需要这条通道：热更新只换 `out/`（外壳代码），**不包含 resources/**，
     * 所以随包内置在 `resources/dsh-plugins/` 的新插件**到不了已安装的用户**。
     * 插件只能单独下载到用户数据目录（`plugins/`），再由 plugin-installer 落位。
     */
    pickPlugins(feed) {
        const info = feed.plugins;
        if (!info?.url && !(info?.parts && info.parts.length))
            return null;
        // 判定「已安装」**只认 profile 落位**（profiles/node_modules/<name>）：
        // 用户数据目录里可能有历史残留（如解压到一半的 staging 里有带 package.json 的
        // 半成品），扫那里会把残缺目录误判成"已装好"→ 永远不再安装（实测踩过）。
        //
        // name 可能是独立字段，也可能合并在 version 里（"@scope/pkg@1.2.3"）——
        // gen-update-json 目前只发合并格式，所以要从 lastIndexOf('@') 拆出来。
        const raw = String(info.version ?? '');
        const at = raw.lastIndexOf('@');
        const name = info.name ?? (at > 0 ? raw.slice(0, at) : '');
        const expectedVersion = at > 0 ? raw.slice(at + 1) : raw;
        if (name) {
            const landed = path.join((0, paths_1.profilesModulesDir)(), ...name.split('/'), 'package.json');
            try {
                const pkg = JSON.parse(fs.readFileSync(landed, 'utf8'));
                if (String(pkg.version) === String(expectedVersion)) {
                    (0, logger_1.log)(`插件 ${name} 已落位且版本一致（${pkg.version}）`);
                    return null;
                }
                (0, logger_1.log)(`插件 ${name} profile 版本 ${pkg.version} → 需要 ${expectedVersion}`);
            }
            catch {
                (0, logger_1.log)(`插件 ${name} 未落位到 profile，准备下载安装`);
            }
            return info;
        }
        // 连 name 都解析不出来（异常 feed）：保守起见视为需要安装
        (0, logger_1.log)(`插件包待安装：${raw}`);
        return info;
    }
    /** 挑出可用的运行时差分补丁（dsh 本体升级，重启时套用） */
    pickRuntime(feed) {
        const all = asArray(feed.runtime).filter((r) => r?.url && r?.version);
        // 找运行时目录：必须用**实际在用**的那个。
        // 顺序：安装目录 → 用户数据目录解开的 → dshRuntimeDir() → 开发态
        const candidates = [this.currentRuntimeDir()];
        let cur = null;
        let curDir = '';
        for (const dir of candidates) {
            const v = (0, runtime_patch_1.runtimeVersionOf)(dir);
            if (v) {
                cur = v;
                curDir = dir;
                break;
            }
        }
        if (cur)
            this.setState({ runtimeVersion: cur });
        if (all.length === 0)
            return null;
        if (!cur) {
            (0, logger_1.log)(`读不到当前运行时版本，跳过运行时更新（找过：${candidates.join('、')}）`);
            return null;
        }
        // 已经比链里所有目标版本都新 → 不用升
        const newest = [...all].sort((a, b) => compareVersions(b.version, a.version))[0];
        if (compareVersions(cur, newest.version) >= 0) {
            (0, logger_1.log)(`运行时已是最新（${cur}）`);
            return null;
        }
        const step = all.find((r) => r.baseVersion === cur);
        if (!step) {
            (0, logger_1.log)(`运行时升级链里没有以当前版本 ${cur}（${curDir}）为基线的补丁` +
                `（链上基线：${all.map((r) => r.baseVersion ?? '?').join('、')}）→ 需要完整安装包或补一档补丁`);
            return null;
        }
        return step;
    }
    // -------------------------------------------------------------------------
    // 通道一：热更新壳（下载新壳代码 → 重启即生效）
    // -------------------------------------------------------------------------
    /** 只负责「下载 + 落位」，什么时候重启交给 finalizeStaged */
    async stageHot(hot, version) {
        if (this.state.hotReady && this.state.hotVersion === version) {
            (0, logger_1.log)(`热更新壳 ${version} 此前已就绪，跳过下载`);
            return version;
        }
        const target = await this.download(version, hot, `hot-${version}.tar`);
        this.setState({ phase: 'downloading', percent: 99, viaHot: true, message: '正在解压热更新包…' });
        const staging = (0, hot_shell_1.hotStagingDir)(version);
        await (0, hot_shell_1.extractHotPackage)(target, staging);
        ensureHotManifest(staging, { ...hot, version }, electron_1.app.getVersion());
        const info = (0, hot_shell_1.installHotShell)(staging);
        this.setState({
            phase: 'downloaded',
            percent: 100,
            viaHot: true,
            hotReady: true,
            hotVersion: info.version,
            setupPath: target,
            message: `热更新 ${info.version} 已就绪，重启即生效`,
        });
        (0, logger_1.log)(`热更新壳 ${info.version} 已就位（重启生效）→ ${info.dir}`);
        return info.version;
    }
    // -------------------------------------------------------------------------
    // 通道二：运行时差分补丁（dsh 本体升级 → 重启时套用）
    // -------------------------------------------------------------------------
    async stageRuntime(rt) {
        const version = rt.version;
        if (this.state.runtimeReady && this.state.runtimeTarget === version) {
            (0, logger_1.log)(`运行时补丁 ${version} 此前已就绪，跳过下载`);
            return version;
        }
        const target = await this.download(version, rt, `dsh-runtime-patch-${version}.tar.gz`);
        this.setState({
            phase: 'downloading',
            percent: 99,
            runtimeTarget: version,
            message: '正在解压运行时补丁…',
        });
        const dir = path.join((0, paths_1.updatesDir)(), `runtime-patch-${version}`);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        await (0, runtime_patch_1.extractRuntimePatch)(target, dir);
        const manifest = (0, runtime_patch_1.readManifest)(dir);
        const cur = (0, runtime_patch_1.runtimeVersionOf)(this.currentRuntimeDir()) ?? '';
        if (manifest.baseVersion !== cur) {
            throw new Error(`补丁基线 ${manifest.baseVersion} 与当前运行时 ${cur} 不一致，已放弃`);
        }
        (0, runtime_patch_1.writePendingPatch)({
            version: manifest.version,
            baseVersion: manifest.baseVersion,
            dir,
            url: rt.url,
            at: Date.now(),
        });
        this.setState({
            phase: 'downloaded',
            percent: 100,
            runtimeReady: true,
            runtimeTarget: manifest.version,
            message: `运行时 ${manifest.version} 已就绪，重启时套用`,
        });
        (0, logger_1.log)(`运行时补丁 ${manifest.version} 已就绪（重启时套用）：覆盖 ${manifest.files.length} 个文件、删除 ${manifest.deletes.length} 个`);
        return manifest.version;
    }
    /** 所有通道都落位完，统一决定「什么时候重启」 */
    async finalizeStaged(interactive, labels) {
        const what = labels.filter(Boolean).join(' + ');
        // 只有显式打开 autoRestart（无人值守 / 企业批量部署）才自动重启
        if (this.config?.autoRestart) {
            (0, logger_1.log)(`配置里打开了 autoRestart，直接重启以应用：${what}`);
            await this.restartToApply(this.state.hotVersion ?? this.state.runtimeTarget ?? what);
            return;
        }
        if (!interactive) {
            // 后台检查到更新：只提示 + 托盘留入口。
            // 「稍后」不是「放弃」——都已落位，下次启动应用时自动生效。
            this.opts.notify('更新已就绪', `${what} 已下载完成。重启应用（几秒）即可生效，也可以下次启动时自动生效。`);
            return;
        }
        await this.promptRestart(what);
    }
    /**
     * 后台静默安装插件：不打扰、不弹窗、不阻塞检查流程。
     * 插件是"新增能力"，没必要让用户决策；装完只把状态置为「已就绪，重启生效」。
     */
    installPluginsQuietly(info) {
        void (async () => {
            try {
                await this.stagePlugins(info);
                // 明确标记：有东西等着重启动应用（哪怕外壳/运行时都已是最新）
                this.setState({
                    phase: 'downloaded',
                    percent: 100,
                    pluginsReady: true,
                    pluginsTarget: info.name ?? info.version,
                    message: '新插件已就绪，重启应用后生效',
                });
                (0, logger_1.log)(`插件 ${info.name ?? info.version} 已静默安装完成，等待重启生效`);
            }
            catch (err) {
                const msg = String(err?.message ?? err);
                (0, logger_1.log)(`插件安装失败（不影响其它更新）：${msg}`);
                // 关键：状态必须复位，否则托盘会永远停在"正在下载 99%"
                this.setState({
                    phase: 'error',
                    percent: 0,
                    message: `插件安装失败：${msg}`,
                });
            }
        })();
    }
    /**
     * 下载插件包并落到用户数据目录（`%APPDATA%\DSH-Desktop\plugins/`）。
     * 落位后由 plugin-installer 在**下次启动**时复制到 profiles/node_modules → dsh 加载。
     */
    async stagePlugins(info) {
        // 暂存目录**必须放在 plugins 之外**：plugin-installer 会把 plugins 下每个子目录
        // 当插件扫描（没有 package.json 的会兜底成一个错误包名），残留的 staging 会被误装。
        const target = path.join((0, paths_1.updatesDir)(), 'plugins-staging');
        fs.rmSync(target, { recursive: true, force: true });
        fs.mkdirSync(target, { recursive: true });
        const downloaded = await this.download(info.version, info, `plugins-${String(info.version).replace(/[^\w.-]+/g, '_')}.tar.gz`);
        this.setState({ phase: 'downloading', percent: 99, message: '正在解压插件包…' });
        await (0, runtime_patch_1.extractTarGz)(downloaded, target);
        // 解出来应该是一个（或几个）插件目录：逐个搬到 plugins/<目录名>
        // 关键：**先确保 plugins/ 存在**——renameSync 不会自动建父目录，
        // 全新机器上 plugins/ 不存在时 rename 会 ENOENT（实测踩过：本机有这目录
        // 所以永远复现不了，用户机器上没有）。
        fs.mkdirSync((0, paths_1.userPluginsDir)(), { recursive: true });
        const entries = fs.readdirSync(target, { withFileTypes: true });
        for (const e of entries) {
            if (!e.isDirectory())
                continue;
            const from = path.join(target, e.name);
            const to = path.join((0, paths_1.userPluginsDir)(), e.name);
            fs.rmSync(to, { recursive: true, force: true });
            fs.renameSync(from, to);
            (0, logger_1.log)(`插件已落位：${to}`);
        }
        fs.rmSync(target, { recursive: true, force: true });
        // 清理 plugins/ 下的垃圾：没有 package.json 的目录不可能是插件
        //（一般是历史版本解压中断留下的残留，如 staging/）
        try {
            for (const e of fs.readdirSync((0, paths_1.userPluginsDir)(), { withFileTypes: true })) {
                if (!e.isDirectory())
                    continue;
                const dir = path.join((0, paths_1.userPluginsDir)(), e.name);
                if (!fs.existsSync(path.join(dir, 'package.json'))) {
                    fs.rmSync(dir, { recursive: true, force: true });
                    (0, logger_1.log)(`清理非插件残留目录：${dir}`);
                }
            }
        }
        catch {
            /* 清理失败不阻断 */
        }
        this.setState({
            phase: 'downloaded',
            percent: 100,
            pluginsReady: true,
            message: '新插件已就绪，重启应用后生效',
        });
    }
    /** 手动「立即应用」入口（托盘菜单） */
    async applyStagedNow() {
        const what = [this.state.hotReady ? `热更新 ${this.state.hotVersion ?? ''}` : '', this.state.runtimeReady ? `运行时 ${this.state.runtimeTarget ?? ''}` : '']
            .filter(Boolean)
            .join(' + ');
        this.cancelScheduledRestart(true);
        (0, logger_1.log)(`重启应用以应用：${what || '已就绪的更新'}`);
        await this.restartToApply(what || '更新');
    }
    /** 「更新已就绪」之后，让用户决定什么时候重启（默认不重启） */
    async promptRestart(what) {
        const delaySec = this.config?.restartDelaySeconds ?? 60;
        const minutes = Math.max(1, Math.round(delaySec / 60));
        const { response } = await electron_1.dialog.showMessageBox({
            type: 'question',
            title: '更新已就绪',
            message: `${what} 已下载完成，重启应用即可生效。`,
            detail: '无需运行安装程序，重启只要几秒；外壳改动重启即生效，运行时改动会在启动时套用（多花几秒）。\n\n' +
                '· 稍后：不影响你现在的工作，下次启动应用时自动生效\n' +
                `· ${minutes} 分钟后自动重启：期间可在托盘菜单里取消\n` +
                '· 立即重启：马上切到新版本',
            buttons: ['稍后（下次启动生效）', `${minutes} 分钟后自动重启`, '立即重启'],
            defaultId: 0,
            cancelId: 0,
        });
        if (response === 1) {
            this.scheduleRestartAfter(delaySec);
        }
        else if (response === 2) {
            await this.restartToApply(what);
        }
        else {
            this.opts.notify('更新已就绪', '重启应用即可生效（托盘菜单里随时能重启）。');
        }
    }
    /**
     * 计划 N 秒后重启应用（期间可在托盘菜单取消）。
     * 用于「N 分钟后自动重启」这个选项 —— 给用户留出保存工作的时间。
     */
    scheduleRestartAfter(seconds) {
        this.cancelScheduledRestart(true);
        this.pendingRestartAt = Date.now() + seconds * 1000;
        (0, logger_1.log)(`已计划 ${seconds}s 后重启以应用热更新（可在托盘取消）`);
        this.restartTimer = setTimeout(() => {
            void this.restartToApply(this.state.hotVersion ?? '热更新');
        }, seconds * 1000);
        this.restartTimer.unref?.();
        this.tickTimer = setInterval(() => this.emitRestartCountdown(), 1000);
        this.tickTimer.unref?.();
        this.emitRestartCountdown();
    }
    /** 取消计划中的重启（用户改主意了） */
    cancelScheduledRestart(silent = false) {
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        if (this.tickTimer) {
            clearInterval(this.tickTimer);
            this.tickTimer = null;
        }
        if (this.pendingRestartAt) {
            this.pendingRestartAt = null;
            if (!silent) {
                (0, logger_1.log)('已取消计划中的重启');
                this.opts.notify('已取消自动重启', '热更新仍然就绪，你可以随时从托盘菜单重启应用。');
            }
            this.setState({
                restartAt: undefined,
                restartIn: undefined,
                message: this.state.hotReady
                    ? `热更新 ${this.state.hotVersion ?? ''} 已就绪（重启生效）`
                    : this.state.message,
            });
        }
    }
    /** 立刻重启并应用已就绪的更新（托盘菜单入口） */
    async restartNow(reason = '手动应用更新') {
        this.cancelScheduledRestart(true);
        (0, logger_1.log)(`重启应用：${reason}`);
        await this.restartToApply(this.state.hotVersion ?? this.state.runtimeTarget ?? '更新');
    }
    emitRestartCountdown() {
        if (!this.pendingRestartAt)
            return;
        const left = Math.max(0, Math.ceil((this.pendingRestartAt - Date.now()) / 1000));
        this.setState({
            restartAt: this.pendingRestartAt,
            restartIn: left,
            message: `将在 ${left} 秒后重启以应用热更新（托盘可取消）`,
        });
    }
    async restartToApply(version) {
        this.setState({
            phase: 'applying',
            viaHot: this.state.hotReady,
            hotReady: this.state.hotReady,
            message: `正在重启以应用 ${version}…`,
        });
        this.persisted.lastInstallAt = Date.now();
        writePersisted(this.persisted);
        if (process.env.DSH_DESKTOP_UPDATE_DRYRUN === '1') {
            (0, logger_1.log)(`试运行：跳过重启（本应重启以应用热更新 ${version}）`);
            this.setState({ phase: 'downloaded', message: '试运行：热更新壳已落位，未重启' });
            return;
        }
        await this.opts.onBeforeInstall();
        // 稍微延迟一点，让托盘/服务收尾完成
        setTimeout(() => this.opts.onRestart(), 600);
    }
    // -------------------------------------------------------------------------
    // 通道二：完整安装包（静默覆盖安装）
    // -------------------------------------------------------------------------
    async applyInstaller(feed, interactive) {
        if (this.downloadedFilePath && fs.existsSync(this.downloadedFilePath)) {
            await this.applyDownloaded(interactive);
            return;
        }
        const file = pickFileForThisMachine(feed);
        if (!file)
            throw new Error('云端 JSON 里没有适配当前平台/架构的安装包');
        const target = await this.download(feed.version, file);
        this.downloadedFilePath = target;
        this.downloadedVersion = feed.version;
        this.setState({
            phase: 'downloaded',
            percent: 100,
            setupPath: target,
            message: `已下载 ${feed.version}`,
        });
        await this.applyDownloaded(interactive);
    }
    async applyDownloaded(interactive) {
        const setup = this.downloadedFilePath;
        const version = this.downloadedVersion ?? this.state.latestVersion ?? '新版本';
        if (!setup)
            throw new Error('尚未下载安装包');
        if (interactive) {
            const { response } = await electron_1.dialog.showMessageBox({
                type: 'question',
                title: '安装更新',
                message: `已下载 ${version}，要现在安装吗？`,
                detail: '安装过程会关闭应用约 1 分钟，装完会自动重新打开。\n可以选「稍后」，等你方便的时候再从托盘菜单安装。',
                buttons: ['立即安装', '稍后'],
                defaultId: 1,
                cancelId: 1,
            });
            if (response !== 0) {
                this.opts.notify('安装包已就绪', `${version} 已下载，可随时在托盘菜单里安装。`);
                return;
            }
        }
        this.setState({ phase: 'applying', message: '正在关闭应用并安装更新…' });
        this.persisted.lastInstallAt = Date.now();
        writePersisted(this.persisted);
        const dir = (0, paths_1.installedAppDir)();
        // 试运行：只验证「下载 + 校验 + 参数拼装」，不真的执行安装程序。
        // 用于联调更新源 / 排障：DSH_DESKTOP_UPDATE_DRYRUN=1
        if (process.env.DSH_DESKTOP_UPDATE_DRYRUN === '1') {
            const args = ['/S', `/D=${dir}`].join(' ');
            (0, logger_1.log)(`试运行：跳过安装，命令行本应为 "${setup}" ${args}`);
            this.setState({
                phase: 'downloaded',
                setupPath: setup,
                message: '试运行：安装包已下载并通过校验，未执行安装',
            });
            return;
        }
        // 先释放文件占用（停 dsh 子进程、销毁托盘），再拉起安装包，
        // 否则安装程序无法覆盖被运行中进程锁住的 exe。
        await this.opts.onBeforeInstall();
        // windowsVerbatimArguments：/D= 的路径不能加引号（NSIS 规定），即使含空格。
        // 安装器侧已把 isForceRun 打开，所以 /S 静默装完会自动重启应用。
        const child = (0, child_process_1.spawn)(setup, ['/S', `/D=${dir}`], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            windowsVerbatimArguments: true,
        });
        child.unref();
        (0, logger_1.log)(`已启动更新安装程序：${setup} /S /D=${dir}`);
        // 给安装程序一点时间起来，再退出本进程
        setTimeout(() => this.opts.onExit(), 1200);
    }
    // -------------------------------------------------------------------------
    // 网络
    // -------------------------------------------------------------------------
    async fetchFeed() {
        if (!this.config)
            throw new Error('未配置更新源');
        const url = new URL(this.config.feedUrl);
        // 带上渠道与当前版本，便于服务端分渠道/灰度下发
        url.searchParams.set('platform', process.platform);
        url.searchParams.set('arch', process.arch);
        url.searchParams.set('version', electron_1.app.getVersion());
        if (this.config.channel)
            url.searchParams.set('channel', this.config.channel);
        const res = await fetch(url, {
            headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok)
            throw new Error(`更新源返回 HTTP ${res.status}`);
        const text = await res.text();
        let feed;
        try {
            feed = JSON.parse(text);
        }
        catch {
            throw new Error('更新源返回的不是合法 JSON');
        }
        if (!feed || typeof feed !== 'object')
            throw new Error('更新源返回内容为空');
        return feed;
    }
    async download(version, file, fileName) {
        const dir = (0, paths_1.updatesDir)();
        fs.mkdirSync(dir, { recursive: true });
        const name = fileName ||
            decodeURIComponent(path.basename(new URL(file.url).pathname)) ||
            `DSH-Desktop-Setup-${version}.exe`;
        const finalPath = path.join(dir, name);
        const partPath = `${finalPath}.part`;
        this.setState({ phase: 'downloading', percent: 0, message: `正在下载 ${version}…` });
        (0, logger_1.log)(`开始下载更新：${file.url}`);
        const res = await fetch(file.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!res.ok || !res.body)
            throw new Error(`下载失败：HTTP ${res.status}`);
        const total = Number(res.headers.get('content-length') ?? 0) || file.size || 0;
        const hash = crypto.createHash('sha256');
        let received = 0;
        let lastReport = 0;
        await (0, promises_1.pipeline)(stream_1.Readable.fromWeb(res.body), new stream_2.Transform({
            transform: (chunk, _enc, cb) => {
                received += chunk.length;
                hash.update(chunk);
                const now = Date.now();
                if (now - lastReport > 300) {
                    lastReport = now;
                    const percent = total > 0 ? Math.min(99, Math.round((received / total) * 100)) : 0;
                    this.setState({ phase: 'downloading', percent, message: `正在下载 ${version}… ${percent}%` });
                }
                cb(null, chunk);
            },
        }), fs.createWriteStream(partPath));
        const digest = hash.digest('hex');
        if (file.sha256 && digest.toLowerCase() !== file.sha256.trim().toLowerCase()) {
            try {
                fs.rmSync(partPath, { force: true });
            }
            catch {
                /* ignore */
            }
            throw new Error(`安装包校验失败（sha256 不匹配）：期望 ${file.sha256}，实际 ${digest}`);
        }
        if (file.size && received !== file.size) {
            try {
                fs.rmSync(partPath, { force: true });
            }
            catch {
                /* ignore */
            }
            throw new Error(`安装包大小不符：期望 ${file.size}，实际 ${received}`);
        }
        if (!file.sha256) {
            (0, logger_1.log)('提示：云端 JSON 未提供 sha256，已跳过完整性校验（建议补上）');
        }
        fs.rmSync(finalPath, { force: true });
        fs.renameSync(partPath, finalPath);
        const mb = (fs.statSync(finalPath).size / 1024 / 1024).toFixed(1);
        (0, logger_1.log)(`下载完成：${finalPath}（${mb} MB，sha256=${digest.slice(0, 12)}…）`);
        return finalPath;
    }
    // -------------------------------------------------------------------------
    // 交互
    // -------------------------------------------------------------------------
    async promptAvailable(feed, mandatory, skipped, hot) {
        const rt = this.pickRuntime(feed);
        const plugins = this.pickPlugins(feed);
        const curRuntime = (0, runtime_patch_1.runtimeVersionOf)(this.currentRuntimeDir());
        const shellOutdated = compareVersions(String(feed.version), (0, hot_shell_1.shellVersion)()) > 0;
        // 外壳已是最新、也没有运行时更新，只是插件还没装上：
        // 插件已经在后台静默安装了，此时弹"发现新版本"只会让人困惑（当前 1.1.10 / 最新 1.1.10）。
        // 给一句轻量说明就够了，装完托盘自然会提示重启。
        if (!shellOutdated && !hot && !rt && plugins) {
            (0, logger_1.log)('外壳与运行时均已最新，仅插件待安装（后台进行中）→ 轻提示，不弹更新框');
            this.opts.notify('DSH Desktop', '正在安装新组件（桌面更新面板），完成后托盘会提示重启。');
            return;
        }
        const detailLines = [
            `当前版本：${(0, hot_shell_1.shellVersion)()}${(0, hot_shell_1.activeHotShell)() ? '（热更新）' : ''}`,
            `最新版本：${feed.version}`,
            curRuntime ? `当前 Harness 运行时：dsh ${curRuntime}` : '',
            feed.releaseDate ? `发布日期：${feed.releaseDate}` : '',
            hot ? '有热更新包：只需重启即可生效，不必运行安装程序。' : '',
            rt ? `有运行时更新：dsh ${curRuntime} → ${rt.version}（重启时套用，多花几秒）` : '',
            plugins ? `有新组件：${plugins.name ?? plugins.version}（已自动下载，重启后生效）` : '',
            mandatory ? '这是一个重要更新，建议尽快安装。' : '',
            skipped ? '（该版本此前被你跳过）' : '',
            feed.notes ? `\n更新内容：\n${feed.notes}` : '',
        ].filter(Boolean);
        const hasInstaller = !!pickFileForThisMachine(feed);
        // 什么通道都用不了（例如纯热更新 feed 但基线不匹配）
        if (!hasInstaller && !hot && !rt) {
            (0, logger_1.log)('云端有更新，但当前设备没有可用的更新通道');
            this.opts.notify('DSH Desktop 有新版本', `${feed.version} 已发布，但当前通道不可用，请稍后再试。`);
            await electron_1.dialog.showMessageBox({
                type: 'warning',
                title: '发现新版本',
                message: `DSH Desktop ${feed.version} 可用，但当前设备没有可用的更新文件。`,
                detail: detailLines.join('\n'),
                buttons: ['好'],
            });
            return;
        }
        // 按钮只给「真的能用」的通道，避免出现点了会失败的选项
        const buttons = [];
        if (hot)
            buttons.push('立即热更新（只需重启）');
        if (rt)
            buttons.push(`应用运行时更新（dsh ${rt.version}）`);
        if (hasInstaller)
            buttons.push('下载完整安装包');
        buttons.push('跳过此版本');
        const skipIdx = buttons.length - 1;
        const { response } = await electron_1.dialog.showMessageBox({
            type: 'info',
            title: '发现新版本',
            message: `DSH Desktop ${feed.version} 可用${hot ? '（热更新）' : ''}`,
            detail: detailLines.join('\n'),
            buttons,
            defaultId: 0,
            cancelId: skipIdx,
        });
        const chosen = buttons[response] ?? '';
        if (chosen.startsWith('立即热更新'))
            await this.applyUpdate({ interactive: true, mode: 'hot' });
        else if (chosen.startsWith('应用运行时更新'))
            await this.applyUpdate({ interactive: true, mode: 'runtime' });
        else if (chosen === '下载完整安装包')
            await this.applyUpdate({ interactive: true, mode: 'installer' });
        else if (response === skipIdx)
            this.skipVersion(feed.version);
    }
    skipVersion(version) {
        this.persisted.skippedVersion = String(version);
        writePersisted(this.persisted);
        (0, logger_1.log)(`用户跳过版本 ${version}`);
    }
    scheduleInterval() {
        if (this.timer)
            clearInterval(this.timer);
        const hours = this.config?.checkIntervalHours ?? 6;
        this.timer = setInterval(() => void this.check({ interactive: false }), Math.max(1, hours) * 3600_000);
        this.timer.unref?.();
    }
    setState(patch) {
        this.state = { ...this.state, ...patch };
        try {
            this.opts.onState(this.getState());
        }
        catch {
            /* 状态回调不能影响更新流程本身 */
        }
    }
    dispose() {
        if (this.timer)
            clearInterval(this.timer);
        this.timer = null;
        if (this.restartTimer)
            clearTimeout(this.restartTimer);
        this.restartTimer = null;
        if (this.tickTimer)
            clearInterval(this.tickTimer);
        this.tickTimer = null;
    }
}
exports.Updater = Updater;
// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
/** 选出适配当前平台/架构的安装包：优先 "win32-x64"，其次顶层 url */
function pickFileForThisMachine(feed) {
    const key = `${process.platform}-${process.arch}`;
    const files = feed.files ?? {};
    const candidate = files[key] ?? files[`${process.platform}`] ?? null;
    if (candidate?.url)
        return candidate;
    if (feed.url)
        return { url: feed.url, sha256: feed.sha256, size: feed.size };
    return null;
}
/**
 * 确保解压出来的热更新目录里有 hot-manifest.json。
 *
 * 正规流程由 `scripts/pack-hot.mjs` 打进包里；这里兜底：万一没带，
 * 就用云端 JSON 的信息 + 当前安装版版本补一个（方便手搓包与联调）。
 */
function ensureHotManifest(dir, hot, baseVersion) {
    const file = path.join(dir, 'hot-manifest.json');
    if (fs.existsSync(file)) {
        try {
            const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (raw.version && raw.baseVersion)
                return;
        }
        catch {
            /* 内容坏了就重写 */
        }
    }
    const manifest = {
        version: hot.version,
        baseVersion: hot.baseVersion ?? baseVersion,
        sha256: hot.sha256,
        size: hot.size,
        source: hot.url,
        builtAt: new Date().toISOString(),
    };
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2), 'utf8');
    (0, logger_1.log)(`热更新包未带 hot-manifest.json，已按云端信息补写（${hot.version}）`);
}
function readPersisted() {
    try {
        return JSON.parse(fs.readFileSync((0, paths_1.updateStateFile)(), 'utf8'));
    }
    catch {
        return {};
    }
}
function writePersisted(state) {
    try {
        fs.writeFileSync((0, paths_1.updateStateFile)(), JSON.stringify(state, null, 2), 'utf8');
    }
    catch (err) {
        (0, logger_1.log)(`写入更新状态失败：${String(err)}`);
    }
}
