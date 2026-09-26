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
exports.compareVersions = compareVersions;
exports.resolveHotShell = resolveHotShell;
exports.noteBootAttempt = noteBootAttempt;
exports.markShellHealthy = markShellHealthy;
exports.shellVersion = shellVersion;
exports.activeHotShell = activeHotShell;
exports.setLoadedHotShell = setLoadedHotShell;
exports.installHotShell = installHotShell;
exports.rollbackHotShell = rollbackHotShell;
exports.cleanupOldShells = cleanupOldShells;
exports.hotStagingDir = hotStagingDir;
exports.extractHotPackage = extractHotPackage;
const electron_1 = require("electron");
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logger_1 = require("./logger");
const paths_1 = require("./paths");
const MANIFEST = 'hot-manifest.json';
const ATTEMPT = '.attempt.json';
/** 连续多少次启动失败就判定这个壳是坏的 */
const MAX_BOOT_ATTEMPTS = 2;
/**
 * 生效壳目录名：`shell-<version>-<epoch>`。
 *
 * 为什么带时间戳：**绝不能重命名或覆盖正在运行的那份壳**——
 * 进程里的 __dirname 指向它，一改名运行的代码就被抽走了（父目录还会被清理删掉）。
 * 每次落位用全新目录，旧目录等下次启动清理，谁在跑就不动谁。
 */
const SHELL_DIR_RE = /^shell-(.+)-(\d+)$/;
/** 目录名 → 是否为本应用管理的生效壳目录（.prev/.broken/.rolled-back/.staging 都不算） */
function isShellDir(name) {
    return SHELL_DIR_RE.test(name);
}
/** 本进程实际加载的热壳（由引导器设置；注意跨模块实例不可见，见 selfHotShell） */
let loaded = null;
/**
 * 从**当前模块自身的位置**推断：本实例是不是跑在热更新壳里。
 *
 * 为什么需要它：热壳被加载后，`main/boot.js` 里的 `./hot-shell` 会解析到
 * **热壳目录里的那一份**，与引导器（app.asar 里那份）是两个不同的模块实例 ——
 * 模块级变量不共享。所以不能只靠 loaded，必须能从文件位置自证身份。
 */
function selfHotShell() {
    const dir = path.dirname(__dirname); // <shell 目录>/main → <shell 目录>
    const root = (0, paths_1.hotRoot)();
    let rel = '';
    try {
        rel = path.relative(root, dir);
    }
    catch {
        return null;
    }
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel))
        return null;
    if (rel.includes(path.sep) || !isShellDir(path.basename(dir)))
        return null;
    const manifest = readManifest(dir);
    if (!manifest)
        return null;
    return {
        dir,
        version: manifest.version,
        entry: path.join(dir, 'main', 'boot.js'),
        baseVersion: manifest.baseVersion,
        installedAt: manifest.builtAt ? Date.parse(manifest.builtAt) : undefined,
    };
}
// ---------------------------------------------------------------------------
// 版本比较（与 updater.ts 同规则，这里独立一份以避免引导阶段引入依赖）
// ---------------------------------------------------------------------------
function parseVersion(v) {
    const [core, ...rest] = String(v).trim().replace(/^v/i, '').split('-');
    return {
        nums: core.split('.').map((s) => {
            const n = parseInt(s.replace(/[^0-9]/g, ''), 10);
            return Number.isFinite(n) ? n : 0;
        }),
        pre: rest.join('-').split('.').filter(Boolean),
    };
}
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
        if (x !== y)
            return x > y ? 1 : -1;
    }
    return 0;
}
// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------
function readManifest(dir) {
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
        if (!raw?.version || !raw?.baseVersion)
            return null;
        return raw;
    }
    catch {
        return null;
    }
}
/** 壳目录里该有的东西都在吗 */
function hasShellFiles(dir) {
    return (fs.existsSync(path.join(dir, 'main', 'boot.js')) &&
        fs.existsSync(path.join(dir, 'preload', 'index.js')) &&
        fs.existsSync(path.join(dir, 'renderer', 'loading.html')));
}
function listShellDirs(root) {
    try {
        return fs
            .readdirSync(root, { withFileTypes: true })
            .filter((e) => e.isDirectory() && isShellDir(e.name))
            .map((e) => path.join(root, e.name));
    }
    catch {
        return [];
    }
}
function readAttempt(root) {
    try {
        return JSON.parse(fs.readFileSync(path.join(root, ATTEMPT), 'utf8'));
    }
    catch {
        return null;
    }
}
function writeAttempt(root, attempt) {
    try {
        fs.writeFileSync(path.join(root, ATTEMPT), JSON.stringify(attempt), 'utf8');
    }
    catch {
        /* ignore */
    }
}
// ---------------------------------------------------------------------------
// 选择与加载
// ---------------------------------------------------------------------------
/**
 * 选出生效的热壳。
 *
 * 约束：
 *   - baseVersion 必须等于当前安装版（app.getVersion()）→ 跨大版本不兼容就回退安装包
 *   - 取版本号最高的一个
 *   - 若上一次启动标记了「未健康启动」且已达上限 → 判为坏壳，改名禁用并回退
 */
function resolveHotShell() {
    const root = (0, paths_1.hotRoot)();
    if (!fs.existsSync(root))
        return null;
    const builtin = electron_1.app.getVersion();
    const attempt = readAttempt(root);
    const candidates = [];
    for (const dir of listShellDirs(root)) {
        if (!hasShellFiles(dir)) {
            (0, logger_1.log)(`热壳目录不完整，忽略：${dir}`);
            continue;
        }
        const manifest = readManifest(dir);
        if (!manifest)
            continue;
        if (manifest.baseVersion !== builtin) {
            (0, logger_1.log)(`热壳 ${manifest.version} 的 baseVersion=${manifest.baseVersion} 与安装版 ${builtin} 不一致，跳过`);
            continue;
        }
        candidates.push({
            key: manifest.version,
            manifest,
            info: {
                dir,
                version: manifest.version,
                entry: path.join(dir, 'main', 'boot.js'),
                baseVersion: manifest.baseVersion,
                installedAt: manifest.builtAt ? Date.parse(manifest.builtAt) : undefined,
            },
        });
    }
    if (candidates.length === 0)
        return null;
    // 版本高的优先；同版本取最近落位的那个
    candidates.sort((a, b) => {
        const v = compareVersions(a.key, b.key);
        if (v !== 0)
            return v;
        return (a.info.installedAt ?? 0) - (b.info.installedAt ?? 0);
    });
    const best = candidates[candidates.length - 1];
    // 坏壳保护：上次启动加载了同一个版本但没标记健康
    if (attempt && attempt.version === best.info.version && attempt.count >= MAX_BOOT_ATTEMPTS) {
        const broken = `${best.info.dir}.broken`;
        (0, logger_1.log)(`热壳 ${best.info.version} 连续 ${attempt.count} 次启动未成功，禁用并回退到内置壳`);
        try {
            fs.renameSync(best.info.dir, broken);
            fs.rmSync(path.join(root, ATTEMPT), { force: true });
        }
        catch (err) {
            (0, logger_1.log)(`禁用坏壳失败：${String(err)}`);
        }
        const rest = candidates.slice(0, -1);
        if (rest.length === 0)
            return null;
        const fallback = rest[rest.length - 1];
        loaded = fallback.info;
        return fallback.info;
    }
    loaded = best.info;
    return best.info;
}
/** 引导器在加载热壳前登记一次尝试（热壳跑起来后会调 markShellHealthy 清掉） */
function noteBootAttempt(info) {
    const root = (0, paths_1.hotRoot)();
    const prev = readAttempt(root);
    const count = prev && prev.version === info.version ? prev.count + 1 : 1;
    writeAttempt(root, { version: info.version, count, at: Date.now() });
    (0, logger_1.log)(`准备加载热壳 ${info.version}（第 ${count} 次尝试）`);
}
/**
 * 热壳已成功启动（窗口已创建）。
 * 由引导器调用：清掉尝试计数，表示这套壳是好的。
 */
function markShellHealthy() {
    const self = selfHotShell() ?? loaded;
    if (!self)
        return;
    const root = (0, paths_1.hotRoot)();
    const attempt = readAttempt(root);
    if (attempt && attempt.version === self.version) {
        try {
            fs.rmSync(path.join(root, ATTEMPT), { force: true });
            (0, logger_1.log)(`热壳 ${self.version} 启动正常，清除尝试计数`);
        }
        catch {
            /* ignore */
        }
    }
}
/** 当前生效的壳版本：热壳优先，否则内置 */
function shellVersion() {
    return selfHotShell()?.version ?? loaded?.version ?? electron_1.app.getVersion();
}
/** 当前生效的热壳信息（未启用则为 null） */
function activeHotShell() {
    const self = selfHotShell();
    if (self)
        return self;
    return loaded ? { ...loaded } : null;
}
/** 供引导器在 require 热壳入口前设置（同一进程内只调用一次） */
function setLoadedHotShell(info) {
    loaded = info;
}
// ---------------------------------------------------------------------------
// 落位 / 回滚 / 清理
// ---------------------------------------------------------------------------
/**
 * 把已解压的目录装成生效壳。
 *
 * @param stagingDir 已解压好的候选目录（内含 main/preload/renderer + hot-manifest.json）
 *
 * 关键：**每次落位都用全新的目录名**，绝不重命名/覆盖现有目录 ——
 * 因为正在运行的那个进程的 __dirname 就指向它，一改名运行的代码就被抽走。
 * 旧目录交给下次启动的 cleanupOldShells 清理（且不会删正在跑的那份）。
 */
function installHotShell(stagingDir) {
    const manifest = readManifest(stagingDir);
    if (!manifest)
        throw new Error('热更新包缺少可用的 hot-manifest.json');
    if (!hasShellFiles(stagingDir))
        throw new Error('热更新包内容不完整（缺 main/preload/renderer）');
    const builtin = electron_1.app.getVersion();
    if (manifest.baseVersion !== builtin) {
        throw new Error(`热更新包基于 ${manifest.baseVersion} 构建，当前安装版为 ${builtin}，只能走完整安装包`);
    }
    const root = (0, paths_1.hotRoot)();
    fs.mkdirSync(root, { recursive: true });
    const target = path.join(root, `shell-${manifest.version}-${Date.now()}`);
    try {
        fs.renameSync(stagingDir, target);
    }
    catch {
        // 跨卷时 rename 会失败，退回递归复制
        copyDir(stagingDir, target);
    }
    const info = {
        dir: target,
        version: manifest.version,
        entry: path.join(target, 'main', 'boot.js'),
        baseVersion: manifest.baseVersion,
        installedAt: Date.now(),
    };
    (0, logger_1.log)(`热壳已就位：${info.version} → ${target}`);
    return info;
}
/** 停用当前热壳（下次启动回到内置壳） */
function rollbackHotShell(reason) {
    const root = (0, paths_1.hotRoot)();
    const current = selfHotShell() ?? loaded;
    const targets = current
        ? [current.dir]
        : listShellDirs(root)
            .map((dir) => ({ dir, m: readManifest(dir) }))
            .sort((a, b) => compareVersions(a.m?.version ?? '', b.m?.version ?? ''))
            .slice(-1)
            .map((x) => x.dir);
    for (const dir of targets) {
        try {
            fs.renameSync(dir, `${dir}.rolled-back`);
            (0, logger_1.log)(`已停用热壳（${reason}）：${dir}`);
        }
        catch (err) {
            (0, logger_1.log)(`停用热壳失败：${String(err)}`);
        }
    }
    try {
        fs.rmSync(path.join(root, ATTEMPT), { force: true });
    }
    catch {
        /* ignore */
    }
}
/** 清理临时目录与过老的热壳（保留版本最高的 keep 个） */
function cleanupOldShells(keep = 2) {
    const root = (0, paths_1.hotRoot)();
    if (!fs.existsSync(root))
        return;
    let entries;
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const e of entries) {
        if (e.isDirectory() && e.name.startsWith('.staging-')) {
            try {
                fs.rmSync(path.join(root, e.name), { recursive: true, force: true });
            }
            catch {
                /* ignore */
            }
        }
    }
    // 正在运行的那份绝对不能删（进程还在从里面读代码）
    const runningDir = selfHotShell()?.dir ?? loaded?.dir ?? null;
    const shells = entries
        .filter((e) => e.isDirectory() && isShellDir(e.name))
        .map((e) => {
        const dir = path.join(root, e.name);
        const m = readManifest(dir);
        return {
            dir,
            version: m?.version ?? '0',
            installedAt: m?.builtAt ? Date.parse(m.builtAt) : safeMtime(dir),
        };
    })
        .sort((a, b) => {
        const byVersion = compareVersions(a.version, b.version);
        return byVersion !== 0 ? byVersion : a.installedAt - b.installedAt;
    });
    for (const old of shells.slice(0, Math.max(0, shells.length - keep))) {
        if (runningDir && path.resolve(old.dir) === path.resolve(runningDir)) {
            (0, logger_1.log)(`跳过清理正在运行的热壳 ${old.version}`);
            continue;
        }
        try {
            fs.rmSync(old.dir, { recursive: true, force: true });
            (0, logger_1.log)(`清理旧热壳 ${old.version}`);
        }
        catch {
            /* ignore */
        }
    }
}
function safeMtime(dir) {
    try {
        return fs.statSync(dir).mtimeMs;
    }
    catch {
        return 0;
    }
}
// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function hotStagingDir(version) {
    const root = (0, paths_1.hotRoot)();
    fs.mkdirSync(root, { recursive: true });
    const dir = path.join(root, `.staging-${version}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
/** 用系统自带 bsdtar 解压热更新包（不额外分发解压器） */
function extractHotPackage(tarFile, destDir) {
    const tarExe = process.platform === 'win32'
        ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
        : 'tar';
    return new Promise((resolve, reject) => {
        const child = (0, child_process_1.spawn)(tarExe, ['-xf', tarFile, '-C', destDir], {
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr?.on('data', (c) => {
            stderr += c.toString('utf8');
        });
        child.once('error', (err) => reject(err));
        child.once('exit', (code) => {
            if (code === 0)
                resolve();
            else
                reject(new Error(`解压热更新包失败（tar 退出码 ${code}）：${stderr.slice(-300)}`));
        });
    });
}
function copyDir(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const src = path.join(from, entry.name);
        const dst = path.join(to, entry.name);
        if (entry.isDirectory())
            copyDir(src, dst);
        else
            fs.copyFileSync(src, dst);
    }
}
