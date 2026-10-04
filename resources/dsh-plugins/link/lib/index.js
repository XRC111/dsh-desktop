/**
 * @dsh-desktop/link —— DSH 远程联动（桌面侧）。
 *
 * ── 它在整条链路里的位置 ────────────────────────────────────────────────────
 * 桌面是**监听方**：在局域网上开一个端口，等手机拨进来。手机拨号而不是桌面
 * 反向连手机，原因是手机没有稳定的可达地址、也不该为了这个功能开入站端口。
 *
 * 配对流程：
 *   1. 桌面生成一个 6 位**配对码**（给人念的，一次性，默认 5 分钟有效）
 *   2. 用户在手机输入该码 → 手机用 code 握手
 *   3. 校验通过后桌面**发放长期令牌**，手机存下来用于以后重连
 *   4. 之后用户不必再输码
 *
 * ⚠️ 安全边界（UI 文案不要吹）：
 *   · 链路是局域网明文 TCP，配对码是唯一门禁，默认 5 分钟有效；
 *   · 凭据类字段（API Key 等）用握手时 ECDH 派生的会话密钥 AES-256-GCM 封装后
 *     才进帧，所以**被动嗅探拿不到 Key**；
 *   · 但**不防中间人** —— 要挡它需要带外校验指纹，对「自己局域网内的两台设备」
 *     不划算。所以准确说法是「凭据加密传输」，不是「端到端加密」。
 *
 * ── 桌面能力从哪来 ──────────────────────────────────────────────────────────
 * computer.* 直接复用 @dsh-desktop/computer-use 的 lib/win32.js。为什么不用
 * ctx.tools.execute 去调它注册的工具：那是给模型用的分发入口，插件之间调用
 * 会绕开它自己的前置检查（而且 PTC 模式下无 parent 的调用会被判 UNKNOWN_TOOL）。
 * 直接 import 它的实现层更直白，也更容易在缺它时优雅降级。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { startLinkServer } from './link-protocol/endpoint.js';
import { DESKTOP_METHODS, COMMON_METHODS, DEFAULT_PORT, makePairingCode, makeToken, fileChunks } from './link-protocol/protocol.js';
import { seal, open } from './link-protocol/secret.js';
import { registerRoutes } from './link-protocol/routes.js';

/** 配对码有效期。短一点更安全，长了用户也记不住。 */
const CODE_TTL_MS = 5 * 60 * 1000;

/** 文本输出 schema 的样板。 */
const textOut = (props) => ({
    schema: { type: 'object', additionalProperties: false, properties: props },
    render: (_args, value) => [
        { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
    ],
});

/**
 * 取出本机所有非回环 IPv4 地址 —— 手机要连的就是其中之一，直接告诉用户省得他找。
 * @returns {string[]} 地址列表。
 */
function lanAddresses() {
    const out = [];
    for (const list of Object.values(os.networkInterfaces())) {
        for (const ni of list ?? []) {
            if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
        }
    }
    return out;
}

/**
 * 插件主体。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} [config] - 配置。
 */
function apply(ctx, config = {}) {
    const log = (msg) => ctx.logger?.info?.('[link] ' + msg) ?? console.log('[link] ' + msg);
    const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
    const stateFile = path.join(home, 'link', 'host.json');

    /** @type {{server: any, code: string|null, codeExpiresAt: number, token: string, conn: any}} */
    const state = { server: null, code: null, codeExpiresAt: 0, token: null, conn: null };

    /**
     * 载入或生成长期令牌。
     * ⚠️ 令牌落盘是必要的（不然每次重启手机都要重新配对），但它是明文存放的 ——
     *    这意味着能读这个文件的人本来就能读 ~/.dsh 下的会话与凭据，不额外扩大面。
     * @returns {Promise<string>} 令牌。
     */
    async function ensureToken() {
        if (state.token) return state.token;
        try {
            const saved = JSON.parse(await fs.readFile(stateFile, 'utf8'));
            if (saved?.token) { state.token = saved.token; return state.token; }
        } catch { /* 首次运行 */ }
        state.token = makeToken();
        await fs.mkdir(path.dirname(stateFile), { recursive: true });
        await fs.writeFile(stateFile, JSON.stringify({ token: state.token }, null, 2), 'utf8');
        return state.token;
    }

    /** 生成新的配对码（旧的立即失效）。 */
    function newCode() {
        state.code = makePairingCode();
        state.codeExpiresAt = Date.now() + CODE_TTL_MS;
        return state.code;
    }

    /**
     * 裁决一个配对请求。
     * @param {object} hello - 对端 hello。
     * @returns {{ok: boolean, token?: string, reason?: string}} 裁决。
     */
    function authorize(hello) {
        // 1) 已有令牌：直接放行（手机重连走这条）。
        if (hello.token && hello.token === state.token) return { ok: true };
        // 2) 配对码：一次性，用过即废。
        if (hello.code && state.code && Date.now() <= state.codeExpiresAt && hello.code === state.code) {
            state.code = null;
            state.codeExpiresAt = 0;
            log('配对码已使用并作废，已发放长期令牌');
            return { ok: true, token: state.token };
        }
        return { ok: false, reason: hello.code ? 'bad or expired code' : 'bad token' };
    }

    /** 桌面侧的 computer.* 实现，按需加载 computer-use 的 win32 层。 */
    const win32 = { mod: null, error: null };
    async function loadWin32() {
        if (win32.mod || win32.error) return win32.mod;
        try {
            // ⚠️ 相对路径要**从 lib/ 往上两级**才到 @dsh-desktop/：
            //    link/lib/index.js → ../  = link/ → ../../ = @dsh-desktop/
            //    写成 '../computer-use/...' 会解析成 link/computer-use/... 而失败
            //    （我在真实安装目录下用探针验证过，见 install-desktop-link 的自检思路）。
            // 缺它时整个联动仍可用，只是 computer.* 明确报错 —— 刻意的降级。
            win32.mod = await import('../../computer-use/lib/win32.js');
        } catch (error) {
            win32.error = '桌面 computer-use 插件不可用：' + (error?.message ?? error);
        }
        return win32.mod;
    }

    /** 注册对端可调用的方法。 */
    function registerHostMethods(conn) {
        conn.handle('computer.status', async () => {
            const w = await loadWin32();
            if (!w) throw new Error(win32.error);
            return { supported: w.isSupported(), screen: w.screenSize(), foreground: w.foregroundWindow(), cursor: w.cursorPos() };
        });
        conn.handle('computer.screen_shot', async ({ hwnd } = {}) => {
            const w = await loadWin32();
            if (!w) throw new Error(win32.error);
            // ⚠️ capture() 的确切返回形状是 { png: Buffer, width, height, origin, grid }
            //    —— 已核对 computer-use 的源码，不要凭猜。
            const shot = w.capture(hwnd ? { hwnd } : {});
            // 链路是 JSON，二进制只能走 base64。
            return { width: shot.width, height: shot.height, png: shot.png.toString('base64') };
        });
        conn.handle('computer.screen_windows', async () => {
            const w = await loadWin32();
            if (!w) throw new Error(win32.error);
            return { windows: w.listWindows() };
        });
        conn.handle('computer.click', async ({ x, y, button, double } = {}) => {
            const w = await loadWin32();
            if (!w) throw new Error(win32.error);
            // mouseClick 内部已经 SetCursorPos，不需要先 mouseMove。
            w.mouseClick(x, y, button ?? 'left', Boolean(double));
            return { ok: true };
        });
        conn.handle('computer.type', async ({ text } = {}) => {
            const w = await loadWin32();
            if (!w) throw new Error(win32.error);
            w.typeUnicode(String(text ?? ''));
            return { typed: String(text ?? '').length };
        });
        conn.handle('computer.key', async ({ vk, keys } = {}) => {
            const w = await loadWin32();
            if (!w) throw new Error(win32.error);
            if (Array.isArray(keys) && keys.length > 0) w.sendKeySteps(keys);
            else if (typeof vk === 'number') w.keyPress(vk);
            else throw new Error('需要 vk 或 keys');
            return { ok: true };
        });
        // 文件：手机往桌面推。
        conn.handle('file.push', async ({ name, chunks, to } = {}) => {
            const target = path.join(to ?? path.join(home, 'workspace'), path.basename(String(name ?? 'file.bin')));
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, Buffer.concat((chunks ?? []).map((c) => Buffer.from(c, 'base64'))));
            return { path: target, bytes: (await fs.stat(target)).size };
        });
        conn.handle('clipboard.get', async () => ({ text: '' }));
        conn.handle('clipboard.set', async ({ text } = {}) => {
            state.clipboard = String(text ?? '');
            return { ok: true };
        });
        // 会话：手机可以列出 / 读桌面会话。
        conn.handle('session.list', async () => listSessions(home));
        conn.handle('session.read', async ({ id } = {}) => readSession(home, String(id ?? '')));
        // 模型：把桌面配置交出去（凭据字段用会话密钥封装）。
        conn.handle('model.export', async ({ includeCredentials } = {}) => exportModel(home, Boolean(includeCredentials), conn));
        conn.handle('model.import', async (args = {}) => importModel(home, args, conn));
    }

    /** 列出桌面会话（目录名 + 最近修改时间）。 */
    async function listSessions(homeDir) {
        const root = path.join(homeDir, 'sessions');
        const out = [];
        let projects = [];
        try { projects = await fs.readdir(root, { withFileTypes: true }); } catch { return { sessions: [] }; }
        for (const project of projects) {
            if (!project.isDirectory()) continue;
            const pdir = path.join(root, project.name);
            for (const sess of await fs.readdir(pdir, { withFileTypes: true }).catch(() => [])) {
                if (!sess.isDirectory()) continue;
                const log = path.join(pdir, sess.name, 'session.v4.jsonl.zstd');
                const stat = await fs.stat(log).catch(() => null);
                if (!stat) continue;
                out.push({ id: sess.name, project: project.name, bytes: stat.size, modified: stat.mtimeMs });
            }
        }
        out.sort((a, b) => b.modified - a.modified);
        return { sessions: out.slice(0, 50) };
    }

    /** 读一个会话的原始日志（手机端自行解析，两端格式相同）。 */
    async function readSession(homeDir, id) {
        const root = path.join(homeDir, 'sessions');
        for (const project of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
            if (!project.isDirectory()) continue;
            const log = path.join(root, project.name, id, 'session.v4.jsonl.zstd');
            const data = await fs.readFile(log).catch(() => null);
            if (data) return { id, project: project.name, chunks: fileChunks(data) };
        }
        throw new Error('找不到会话 ' + id);
    }

    /** 导出模型配置。凭据类走密封。 */
    async function exportModel(homeDir, includeCredentials, conn) {
        const files = [];
        const llmDir = path.join(homeDir, 'llm-deepseek');
        for (const name of await fs.readdir(llmDir).catch(() => [])) {
            const p = path.join(llmDir, name);
            const stat = await fs.stat(p).catch(() => null);
            if (stat?.isFile()) files.push({ path: 'llm-deepseek/' + name, content: await fs.readFile(p, 'utf8') });
        }
        const result = { files, credentials: null, note: null };
        if (includeCredentials) {
            const cred = await fs.readFile(path.join(homeDir, '.credentials.yaml'), 'utf8').catch(() => null);
            if (cred) {
                if (!conn?.sessionKey) {
                    // 没有会话密钥就**不发凭据** —— 宁可失败，也不要明文送 Key。
                    result.note = '本次连接没有会话密钥，已跳过凭据传输（明文链路不发 API Key）';
                } else {
                    result.credentials = seal(conn.sessionKey, { '.credentials.yaml': cred });
                }
            }
        }
        return result;
    }

    /** 在桌面侧接受手机推来的模型配置。 */
    async function importModel(homeDir, args, conn) {
        const written = [];
        for (const f of args.files ?? []) {
            // 只允许写 llm-* 与 .credentials.yaml，且不允许跳出 home。
            const rel = String(f.path ?? '');
            if (!/^(llm-[a-z0-9-]+\/[^/]+|\.credentials\.yaml)$/i.test(rel)) throw new Error('拒绝写入路径 ' + rel);
            const target = path.join(homeDir, rel);
            if (!target.startsWith(homeDir)) throw new Error('路径越界');
            await fs.mkdir(path.dirname(target), { recursive: true });
            // 覆盖前留一份备份，写坏了还能回退。
            await fs.copyFile(target, target + '.linkbak').catch(() => {});
            await fs.writeFile(target, String(f.content ?? ''), 'utf8');
            written.push(rel);
        }
        if (args.credentials) {
            if (!conn?.sessionKey) throw new Error('没有会话密钥，拒绝接收凭据');
            const opened = open(conn.sessionKey, args.credentials);
            for (const [rel, content] of Object.entries(opened)) {
                const target = path.join(homeDir, rel);
                await fs.copyFile(target, target + '.linkbak').catch(() => {});
                await fs.writeFile(target, content, 'utf8');
                written.push(rel);
            }
        }
        return { written };
    }

    /**
     * 拿当前连接；没有就明确报错（而不是返回空值让模型猜）。
     * @returns {object} 连接。
     */
    function requireConn() {
        if (!state.conn || state.conn.closed) throw new Error('没有已配对的设备。先在手机上用 link_connect 配对。');
        return state.conn;
    }

    // ── 主机侧操作 ───────────────────────────────────────────────────────────
    // 抽成具名函数：工具（给模型）和 HTTP 路由（给界面）调的是**同一份**逻辑。
    // 否则界面和模型两条路径会各自漂移 —— 那种不一致最难查。
    async function opStart(args = {}) {
        await ensureToken();
        if (state.server) {
            return { running: true, port: state.server.port, code: state.code, addresses: lanAddresses() };
        }
        state.server = await startLinkServer({
            port: args.port ?? config.port ?? DEFAULT_PORT,
            host: config.host ?? '0.0.0.0',
            authorize,
            device: { name: os.hostname(), platform: process.platform + '-' + process.arch },
            methods: [...DESKTOP_METHODS, ...COMMON_METHODS],
            log,
            onConnection(conn) {
                state.conn = conn;
                registerHostMethods(conn);
                conn.on('close', () => { if (state.conn === conn) state.conn = null; });
            },
        });
        newCode();
        return {
            running: true,
            port: state.server.port,
            code: state.code,
            codeExpiresInSeconds: Math.round(CODE_TTL_MS / 1000),
            addresses: lanAddresses(),
            hint: '在手机上执行 link_connect，host 填上面任一地址，port 填端口，code 填配对码。',
        };
    }

    /** 状态：界面和 link_host_status 共用。 */
    function opStatus() {
        return {
            running: Boolean(state.server),
            port: state.server?.port ?? null,
            code: state.code && Date.now() <= state.codeExpiresAt ? state.code : null,
            codeExpiresInSeconds: state.code ? Math.max(0, Math.round((state.codeExpiresAt - Date.now()) / 1000)) : 0,
            addresses: lanAddresses(),
            connected: state.conn && !state.conn.closed
                ? {
                    device: state.conn.peer,
                    methods: state.conn.peerMethods,
                    encrypted: Boolean(state.conn.sessionKey),
                }
                : null,
        };
    }

    /** 停服务。 */
    async function opStop() {
        if (!state.server) return { running: false };
        await state.server.close();
        state.server = null;
        state.conn = null;
        state.code = null;
        return { running: false };
    }

    /** 换新配对码。 */
    function opCode() {
        if (!state.server) throw new Error('联动服务还没启动，先启动服务。');
        newCode();
        return { code: state.code, codeExpiresInSeconds: Math.round(CODE_TTL_MS / 1000) };
    }

    // GUI 用的 HTTP 路由（挂在已鉴权的 Connection 上，见 routes.js 的说明）。
    registerRoutes(ctx, {
        status: () => opStatus(),
        start: (body) => opStart(body ?? {}),
        stop: () => opStop(),
        code: () => opCode(),
    });

    defineAndRegister();

    /** 注册全部桌面侧工具。 */
    function defineAndRegister() {
        const registry = [
            {
                name: 'link_host_start',
                description: '启动远程联动服务（桌面侧）：在局域网开端口等手机接入，并生成 6 位配对码。手机用 link_connect 输入该码完成配对。',
                parameters: { port: { type: 'number', description: '端口，默认 45731。' } },
                async execute(args) { return opStart(args); },
            },
            {
                name: 'link_host_status',
                description: '查看远程联动服务状态：是否运行、端口、配对码、已连设备。',
                parameters: {},
                async execute() { return opStatus(); },
            },
            {
                name: 'link_host_code',
                description: '重新生成 6 位配对码（旧码立即失效）。',
                parameters: {},
                async execute() { return opCode(); },
            },
            {
                name: 'link_host_stop',
                description: '停止远程联动服务并断开已配对设备。',
                parameters: {},
                async execute() { return opStop(); },
            },
            // ── 操作手机 ────────────────────────────────────────────────────────
            {
                name: 'phone_status',
                description: '查看已配对手机的状态（电量、屏幕、无障碍服务是否就绪）。',
                parameters: {},
                async execute() { return requireConn().call('mobile.status'); },
            },
            {
                name: 'phone_screen_shot',
                description: '截取已配对手机的屏幕。返回图片与落盘路径。',
                parameters: {},
                async execute() {
                    const shot = await requireConn().call('mobile.screen_shot', {}, { timeoutMs: 30_000 });
                    if (!shot?.png) return shot;
                    const dir = path.join(os.tmpdir(), 'dsh-link');
                    await fs.mkdir(dir, { recursive: true });
                    const file = path.join(dir, 'phone-' + Date.now() + '.png');
                    await fs.writeFile(file, Buffer.from(shot.png, 'base64'));
                    return { path: file, width: shot.width, height: shot.height, bytes: shot.bytes };
                },
            },
            {
                name: 'phone_screen_elements',
                description: '列出已配对手机当前界面上可交互的元素及其精确坐标（无障碍树）。',
                parameters: {},
                async execute() { return requireConn().call('mobile.screen_elements'); },
            },
            {
                name: 'phone_click',
                description: '在已配对手机上点击一个坐标。',
                parameters: {
                    x: { type: 'number', required: true, description: '横坐标。' },
                    y: { type: 'number', required: true, description: '纵坐标。' },
                    double: { type: 'boolean', description: '是否双击。' },
                },
                async execute(args) { return requireConn().call('mobile.click', args); },
            },
            {
                name: 'phone_scroll',
                description: '在已配对手机上滚动。',
                parameters: { delta: { type: 'number', required: true, description: '正数向上、负数向下。' } },
                async execute(args) { return requireConn().call('mobile.scroll', args); },
            },
            {
                name: 'phone_type',
                description: '在已配对手机的当前焦点输入框里输入文本（支持中文）。',
                parameters: { text: { type: 'string', required: true, description: '要输入的文字。' } },
                async execute(args) { return requireConn().call('mobile.type', args); },
            },
            {
                name: 'phone_key',
                description: '在已配对手机上按一个键或组合键，如 ["back"]、["enter"]、["ctrl","c"]。',
                parameters: { keys: { type: 'array', items: { type: 'string' }, required: true, description: '键名数组。' } },
                async execute(args) { return requireConn().call('mobile.key', args); },
            },
            // ── 文件 / 模型 ─────────────────────────────────────────────────────
            {
                name: 'phone_push_file',
                description: '把一个文件从桌面推到已配对手机的工作区。',
                parameters: {
                    path: { type: 'string', required: true, description: '桌面上的文件路径。' },
                    to: { type: 'string', description: '手机上的目标目录（默认手机工作区）。' },
                },
                async execute(args) {
                    const data = await fs.readFile(args.path);
                    return requireConn().call('file.push', {
                        name: path.basename(args.path),
                        to: args.to ?? null,
                        chunks: fileChunks(data),
                    }, { timeoutMs: 120_000 });
                },
            },
            {
                name: 'link_share_model',
                description: '把桌面的模型配置发给已配对手机（含 provider/模型列表；includeCredentials 时连 API Key 一起，凭据走会话密钥加密）。',
                parameters: { includeCredentials: { type: 'boolean', description: '是否一并发送凭据（API Key）。' } },
                async execute(args) {
                    const conn = requireConn();
                    // 这里走的是「我作为调用方」的路径？不 —— 桌面是服务方，
                    // 所以直接调用本地的 exportModel 更直接。
                    return exportModel(home, Boolean(args.includeCredentials), conn);
                },
            },
        ];

        for (const spec of registry) {
            // ⚠️ 必填是**逐属性**的 `required: true` 注解，不是参数级数组、
            //    也不是 `optional` 字段（我第一版写错了，dsh 的 schema 不认）。
            ctx.tools.register(defineTool({
                name: spec.name,
                description: spec.description,
                parameters: spec.parameters ?? {},
                output: textOut({}),
                async execute(args) { return spec.execute(args ?? {}); },
                presentCall: () => ({ card: 'generic', title: spec.name, kind: 'read', rawInput: {} }),
            }));
        }
        log('已注册 ' + registry.length + ' 个桌面侧联动工具');
    }
}

export const name = '@dsh-desktop/link';
export const inject = ['tools', 'connection'];

export { apply };
