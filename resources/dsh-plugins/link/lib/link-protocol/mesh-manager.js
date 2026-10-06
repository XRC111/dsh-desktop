/**
 * DSH 远程联动 —— 连接管理器（mesh 核心）。
 *
 * 负责「现在连上了谁」，并按拓扑决定**谁该拨谁**。
 *
 * ── 两种拓扑的差别只有一个：拨号方向 ────────────────────────────────────────
 *
 *   STAR（无 overlay，手机当 hub）
 *     hub    : listen，所有 client 连进来
 *     client : dial hub，不主动连别人
 *     后果   : 两台 client 之间无法直连远程控制（但文件/会话可经 hub 转发）
 *
 *   MESH（每台都有虚拟 IP）
 *     每台都 listen + dial 每一个已知 peer
 *     后果   : 任意两台可直接互连互控
 *
 * 关键取舍：**MESH 里不要让两端同时互拨**，否则会各建一条重复连接。
 * 办法是**按 deviceId 字典序决定方向**：只有"我比你小"才主动拨你。
 * 双方握手时都知道对方的 id，所以这个仲裁不需要额外协议消息，天然无冲突。
 *
 * ── 为什么不在 CGNAT 后面的手机上做 hub 的 dialer ──────────────────────────
 * star 模式里 hub 永远只 listen。它想主动连别人是不行的（别人连不进来），
 * 但也不需要 —— 需要外发的东西（文件、会话）本来就由 client 推到 hub。
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TOPOLOGY } from './mesh-identity.js';
import { startLinkServer, connectToHost } from './endpoint.js';
import { makePairingCode, TRANSIT_METHOD } from './protocol.js';

/**
 * 决定「谁拨号」的仲裁：只有 deviceId 字典序小的那个主动拨大的。
 *
 * 纯函数，不依赖任何运行时状态 —— 双方各自调用都会得到一致结论，
 * 所以不会建出两条重复连接。
 *
 * @param {string} aId - 一端的 deviceId。
 * @param {string} bId - 另一端的 deviceId。
 * @returns {boolean} true 表示 a 应当主动拨 b。
 */
export function shouldDial(aId, bId) {
    return String(aId) < String(bId);
}

/**
 * 连接管理器：持有到所有 peer 的连接，并维持它们。
 */
export class LinkManager {
    /**
     * @param {object} opts - 选项。
     * @param {string} opts.deviceId - 自己的 deviceId。
     * @param {object} opts.identity - 自己的身份（含 privateKeyPem）。
     * @param {import('./mesh-registry.js').Registry} opts.registry - 设备注册表。
     * @param {string} [opts.name] - 设备名。
     * @param {string} [opts.kind] - 'desktop' | 'mobile'。
     * @param {string} [opts.host] - listen 的绑定地址。
     * @param {number} [opts.port] - listen 的端口。
     * @param {string[]} [opts.capabilities] - 本端对外宣告的能力。
     * @param {(msg: string) => void} [opts.log] - 日志。
     */
    constructor(opts) {
        this.deviceId = opts.deviceId;
        this.identity = opts.identity;
        this.registry = opts.registry;
        this.name = opts.name ?? opts.deviceId;
        this.kind = opts.kind ?? 'device';
        this.host = opts.host ?? '0.0.0.0';
        this.port = opts.port ?? 0;
        this.capabilities = opts.capabilities ?? [];
        this.log = opts.log ?? (() => {});

        /** @type {string} 当前拓扑。 */
        // 从注册表恢复用户的显式选择（见 Registry.topology 的说明）。
        this.topology = opts.registry?.topology === TOPOLOGY.mesh ? TOPOLOGY.mesh : TOPOLOGY.star;
        /** @type {import('./connection.js').LinkConnection[]} 由我拨出去的连接。 */
        this.outbound = new Map();
        /** @type {import('./connection.js').LinkConnection[]} 别人拨进来的连接。 */
        this.inbound = new Map();
        /** @type {any} listen 端句柄。 */
        this.server = null;
        /** 6 位配对码（star 模式下 client 用它连 hub）。 */
        this.pairCode = null;
        this.pairCodeExpiresAt = 0;
        /**
         * 本端签发过的长期令牌。
         *
         * ⚠️ 必须在构造函数里初始化成 Set：以前是 `this.tokens?.has?.(...)` 的
         * 可选链 + #mintToken 里才 `if (!this.tokens) this.tokens = new Set()`，
         * 于是「先 authorize 后 mint」的正常顺序下重连校验永远走不到令牌分支，
         * 只能靠 pairCode —— 而码是一次性的，用完就再也连不上。
         *
         * ⚠️ 而且必须**落盘**：只放内存的话进程一重启就全没了，对方拿着有效令牌
         * 也连不进来，只能重新配对 —— 而配对码同样是一次性的，等于每次重启都要
         * 人跑去对端点一次「换一个配对码」。见 tokensFile / loadTokens / saveTokens。
         */
        this.tokens = new Set();
        /** @type {string|null} 令牌文件路径（opts.homeDir 给出时才有）。 */
        this.tokensFile = opts.homeDir ? path.join(opts.homeDir, 'link', 'tokens.json') : null;
        this.loadTokens();

        // ── 自动连接驱动的状态 ──────────────────────────────────────────────
        /** @type {any} 自动拨号的定时器（null = 没在跑）。 */
        this.autoTimer = null;
        /** @type {number} 基础重试间隔。 */
        this.autoIntervalMs = 5000;
        /** @type {((conn: object) => void)|undefined} 新连接的回调。 */
        this.autoOnConnection = undefined;
        /** @type {Map<string, number>} 每台设备的连续失败次数（退备用）。 */
        this.dialFailures = new Map();
        /** @type {Map<string, number>} 每台设备上次尝试拨号的时间。 */
        this.dialLastAt = new Map();
    }

    /** 从磁盘载入签发过的令牌。读不到就当空表（首次运行）。 */
    loadTokens() {
        if (!this.tokensFile) return;
        try {
            const raw = JSON.parse(fs.readFileSync(this.tokensFile, 'utf8'));
            for (const t of raw?.tokens ?? []) {
                if (typeof t === 'string' && t) this.tokens.add(t);
            }
        } catch { /* 首次运行没有这文件 */ }
    }

    /**
     * 把令牌落盘。失败只记日志 —— 写不进去不该让配对本身失败
     * （本次运行内仍然有效，只是重启后要重新配对）。
     */
    saveTokens() {
        if (!this.tokensFile) return;
        try {
            fs.mkdirSync(path.dirname(this.tokensFile), { recursive: true });
            fs.writeFileSync(
                this.tokensFile,
                JSON.stringify({ version: 1, tokens: [...this.tokens] }, null, 2),
                'utf8',
            );
            try { fs.chmodSync(this.tokensFile, 0o600); } catch { /* Windows 上不支持就算了 */ }
        } catch (error) {
            this.log('link: 令牌落盘失败（重启后需重新配对）：' + (error?.message ?? error));
        }
    }

    /** 生成一个新的配对码（一次性，5 分钟）。 @returns {string} 码。 */
    newPairCode() {
        this.pairCode = makePairingCode();
        this.pairCodeExpiresAt = Date.now() + 5 * 60 * 1000;
        return this.pairCode;
    }

    /**
     * 裁决一个配对/连接请求。
     *
     * 两种情况共用它：
     *   · star：client 带 code 或 token 来连 hub；
     *   · mesh：双方互拨，带的是长期 token（首次仍是 code 换 token）。
     *
     * @param {object} hello - 对端 hello。
     * @returns {{ok: boolean, token?: string, reason?: string}} 裁决。
     */
    authorize(hello) {
        // 1) 已有 token：直接放行（重连）。
        if (hello?.token && this.tokens.has(hello.token)) return { ok: true };
        if (hello?.token && hello.token === this.pairToken) return { ok: true };
        // 2) 配对码：一次性，用过即废。
        if (hello?.code && this.pairCode && Date.now() <= this.pairCodeExpiresAt && hello.code === this.pairCode) {
            this.pairCode = null;
            this.pairCodeExpiresAt = 0;
            const token = this.#mintToken();
            this.log('配对码已使用并作废，已发放长期令牌');
            return { ok: true, token };
        }
        return { ok: false, reason: hello?.code ? 'bad or expired code' : 'bad token' };
    }

    /** 记住本端签发的令牌（允许对端重连）。 */
    acceptToken(token) {
        if (this.tokens.has(token)) return;
        this.tokens.add(token);
        this.saveTokens();
    }

    /**
     * 记下一个对端（握手成功后调用）。
     * @param {object} peer - { deviceId, name, kind, endpoint }。
     */
    notePeer(peer) {
        if (!peer?.deviceId) return;
        this.registry?.upsert(peer);
    }

    /**
     * 记下一个活跃连接（双向）。同一 deviceId 只保留最新一条。
     * @param {'in'|'out'} dir - 方向。
     * @param {string} deviceId - 对端 id。
     * @param {object} conn - 连接。
     */
    track(dir, deviceId, conn) {
        const map = dir === 'in' ? this.inbound : this.outbound;
        const old = map.get(deviceId);
        if (old && old !== conn && !old.closed) old.close('superseded');
        map.set(deviceId, conn);
        if (conn) {
            const prev = this.registry?.get(deviceId);
            this.registry?.upsert({ deviceId, lastSeen: Date.now() });
        }
    }

    /**
     * 取到某台设备的连接（先找 inbound 再 outbound）。
     * @param {string} deviceId - 对端 id。
     * @returns {object|null} 连接。
     */
    connectionTo(deviceId) {
        return this.inbound.get(deviceId) ?? this.outbound.get(deviceId) ?? null;
    }

    /** @returns {boolean} 是否至少连着一台设备。 */
    get anyConnected() {
        return this.inbound.size + this.outbound.size > 0;
    }

    /**
     * 列出当前所有在线对端（含能力），供 link_devices 返回。
     * @returns {Array<object>} 在线设备。
     */
    onlinePeers() {
        const out = [];
        const seen = new Set();
        for (const [deviceId, conn] of [...this.inbound, ...this.outbound]) {
            if (seen.has(deviceId)) continue;
            seen.add(deviceId);
            out.push({
                deviceId,
                name: conn.peer?.name ?? this.registry?.get(deviceId)?.name ?? deviceId,
                kind: this.registry?.get(deviceId)?.kind ?? conn.peer?.kind ?? 'device',
                direction: this.inbound.has(deviceId) ? 'inbound' : 'outbound',
                encrypted: Boolean(conn.sessionKey),
                capabilities: conn.peerMethods ?? [],
            });
        }
        return out;
    }

    /** 关闭所有连接与监听。 */
    closeAll() {
        for (const conn of [...this.inbound.values(), ...this.outbound.values()]) {
            try { conn.close('shutdown'); } catch { /* 已断开 */ }
        }
        this.inbound.clear();
        this.outbound.clear();
    }

    /**
     * 把「中转」这个能力挂到一条连接上。
     *
     * ⚠️ 必须由 LinkManager **自己**做，不能指望调用方记得注册。
     *    第一版就是让插件的 registerHostMethods / registerMobileMethods 各自去
     *    `conn.handle(TRANSIT_METHOD, ...)` —— 结果测试直接建 LinkManager 时
     *    谁都没注册，报「本端未提供方法 relay.call」；更糟的是能力宣告里也没有它，
     *    于是**功能实现了却永远用不上**（调用方按 peerMethods 找中转方，找不到）。
     *    这种「代码在、但没人挂上去」的错最难查，所以收进这里，两条路径都走它。
     *
     * @param {object} conn - 一条已建立的连接。
     * @returns {object} 同一条连接（便于链式）。
     */
    attachRelay(conn) {
        if (conn && typeof conn.handle === 'function') {
            conn.handle(TRANSIT_METHOD, (args) => this.relayCall(args));
        }
        return conn;
    }

    /**
     * 本端对外宣告的能力，**保证含 relay.call**。
     *
     * 中转是管理器自带的能力，所以宣告也由它保证 —— 调用方传进来的 capabilities
     * 只补业务方法，不必（也不该）操心这个。
     *
     * @returns {string[]} 能力清单。
     */
    advertisedMethods() {
        const base = this.capabilities ?? [];
        return base.includes(TRANSIT_METHOD) ? [...base] : [...base, TRANSIT_METHOD];
    }

    // ── 监听 / 拨号 ─────────────────────────────────────────────────────────
    //
    // 这两个方法把 endpoint.js 的 startLinkServer / connectToHost 接进管理器，
    // 并保证「同一 deviceId 只留一条连接」由 track() 统一裁决 —— 否则 mesh 模式下
    // 两端同时互拨会各建一条，表现为同一设备重复出现、调用结果错乱。

    /**
     * 开始监听（star 模式的 hub、mesh 模式的每一台都要调）。
     *
     * @param {object} [options] - 选项。
     * @param {number} [options.port] - 端口，默认 this.port（0 = 系统分配）。
     * @param {string} [options.host] - 绑定地址，默认 this.host。
     * @param {(conn: object) => void} [options.onConnection] - 额外回调（注册方法用）。
     * @returns {Promise<{port: number, address: string}>} 实际监听结果。
     */
    async listen({ port, host, onConnection } = {}) {
        if (this.server) return { port: this.port, address: this.host };
        const handle = await startLinkServer({
            port: port ?? this.port,
            host: host ?? (this.host === '0.0.0.0' ? undefined : this.host),
            // 裁决交给 authorize：它同时处理配对码（一次性）与长期令牌（重连）。
            authorize: (hello) => this.authorize(hello),
            device: { name: this.name, kind: this.kind, deviceId: this.deviceId, platform: this.kind === 'mobile' ? 'android' : process.platform },
            // 用 advertisedMethods() 而不是 this.capabilities：它保证 relay.call 在列，
            // 否则调用方按 peerMethods 找不到中转方（功能在、却永远用不上）。
            methods: this.advertisedMethods(),
            log: this.log,
            onConnection: (conn) => {
                // 中转处理器由管理器自己挂，不指望调用方记得（见 attachRelay 的说明）。
                this.attachRelay(conn);
                // 对端 deviceId 来自握手时的 device 描述。没有它就没法做去重，
                // 只能按 socket 对待 —— 退化成「不认设备」，但连接仍然可用。
                const peerId = conn.peer?.deviceId;
                if (peerId) {
                    this.track('in', peerId, conn);
                    this.notePeer({
                        deviceId: peerId,
                        name: conn.peer?.name,
                        kind: conn.peer?.kind,
                        capabilities: conn.peerMethods,
                    });
                }
                try { onConnection?.(conn); } catch (error) { this.log('link: onConnection 抛错 ' + (error?.message ?? error)); }
            },
        });
        this.server = handle;
        this.port = handle.port;
        this.log('link: 已监听 ' + handle.address + ':' + handle.port);
        return { port: handle.port, address: handle.address };
    }

    /**
     * 拨号到一台已知设备。
     *
     * 会按 shouldDial 仲裁：mesh 模式下两端都会尝试拨对方，但只有 deviceId
     * 字典序小的一方真正发起，另一方等它连进来 —— 这样不会建出重复连接。
     * 传 `{ force: true }` 可跳过仲裁（用于「我就是要主动连它」的手动配对）。
     *
     * @param {string} deviceId - 对端 id。
     * @param {object} [options] - 选项。
     * @param {boolean} [options.force] - 跳过仲裁。
     * @param {string} [options.code] - 首次配对的 6 位码。
     * @param {(conn: object) => void} [options.onConnection] - 额外回调。
     * @returns {Promise<object|null>} 连接；被仲裁拦下时返回 null。
     */
    async dial(deviceId, { force = false, code, onConnection } = {}) {
        if (!force && !shouldDial(this.deviceId, deviceId)) {
            this.log('link: 按仲裁不主动拨 ' + deviceId + '（等它连进来）');
            return null;
        }
        const rec = this.registry?.get(deviceId);
        if (!rec?.endpoint) throw new Error('不知道 ' + deviceId + ' 的地址（先配对，或等它连进来一次）');
        // 没有任何凭据时**提前**给出可操作的提示。
        //
        // 不这么做的话，对端会回一句「bad token」—— 那是从服务端视角描述的，
        // 用户看到「令牌不对」只会以为令牌坏了，而真实原因是**本端压根没配过对**
        // （注册表里只有地址、没有令牌）。配对码是一次性的，所以唯一出路是
        // 重新配对，这句话必须说清楚。
        if (!code && !rec.token) {
            throw new Error(
                '还没有和 ' + (rec.name ?? deviceId) + ' 配对过（缺令牌）。'
                + '请在桌面上取一个新的 6 位配对码，然后用 link_connect 配对一次。',
            );
        }
        const [host, portText] = String(rec.endpoint).split(':');
        const port = Number(portText) || this.port;
        // 已有连接就别重复拨 —— 除非调用方明确要求。
        const existing = this.connectionTo(deviceId);
        if (existing && !existing.closed) return existing;

        const conn = await connectToHost({
            host,
            port,
            code,
            token: rec.token,
            device: { name: this.name, kind: this.kind, deviceId: this.deviceId, platform: this.kind === 'mobile' ? 'android' : process.platform },
            methods: this.advertisedMethods(),
            log: this.log,
        });
        // 拨出去的连接也要挂中转处理器 —— 否则「我能拨别人」的那条路上，
        // 别人请我中转时我答不上来（本端未提供方法 relay.call）。
        this.attachRelay(conn);
        this.track('out', deviceId, conn);
        if (conn.issuedToken) {
            // 首次配对拿到的长期令牌要落到注册表，否则下次重连又得输码。
            this.registry?.upsert({ deviceId, token: conn.issuedToken });
        }
        try { onConnection?.(conn); } catch (error) { this.log('link: onConnection 抛错 ' + (error?.message ?? error)); }
        return conn;
    }

    /**
     * 切换拓扑。
     *
     * star → mesh 时不会自动去拨所有已知 peer：那需要每台都有可达地址，
     * 由调用方（插件的定时/事件逻辑）决定何时拨，这里只记下模式。
     *
     * @param {string} topology - TOPOLOGY.star | TOPOLOGY.mesh。
     * @returns {string} 生效后的拓扑。
     */
    setTopology(topology) {
        const next = topology === TOPOLOGY.mesh ? TOPOLOGY.mesh : TOPOLOGY.star;
        if (next === this.topology) return this.topology;
        this.topology = next;
        // 落盘：这是用户的显式选择，重启后必须还在（否则用户会以为「设了没用」）。
        this.registry?.setTopology?.(next);
        this.log('link: 拓扑 = ' + this.topology);
        // 切到 mesh 时**立刻**拨一轮，别让用户等一个 interval 才发现「还是连不上」；
        // 切回 star 时清掉退避计数（下次进 mesh 从头开始，不被旧失败拖慢）。
        if (this.autoTimer) {
            if (next === TOPOLOGY.mesh) {
                void this.#autoTick();
            } else {
                this.dialFailures.clear();
                this.dialLastAt.clear();
            }
        }
        return this.topology;
    }

    /**
     * mesh 模式下应当主动拨号的设备清单。
     *
     * 只返回「我该拨、且还没连上」的 —— 已经连上的不重复拨，
     * 不该我拨的（字典序更大）交给对方。
     *
     * @returns {Array<object>} 待拨设备记录。
     */
    dialTargets() {
        if (this.topology !== TOPOLOGY.mesh) return [];
        return (this.registry?.list() ?? []).filter((rec) => {
            if (!rec.endpoint) return false;
            if (!shouldDial(this.deviceId, rec.deviceId)) return false;
            const conn = this.connectionTo(rec.deviceId);
            return !conn || conn.closed;
        });
    }

    // ── 自动连接驱动 ─────────────────────────────────────────────────────────
    //
    // 上面那些是「能力」，这一段是「让它自己动起来」。没有它，mesh 拓扑切了也
    // 不会互连：dialTargets() 只是算出一份「该拨谁」的清单，没有任何东西去拨。
    //
    // 设计取舍：
    //   · **不做全连接轮询**。每台设备只拨「字典序比我大」的，所以任意两台之间
    //     只有一条链路、且方向固定 —— 这是 shouldDial 的结论，不需要额外协调。
    //   · **退避重试**而不是固定间隔猛拨：对端没起来时（比如手机还没开）每秒一次
    //     会白烧电量和日志。失败次数越多间隔越长，上限 60 秒。
    //   · **连上就停**：成功后把该设备的失败计数清零，下一个 tick 不再拨它。
    //   · 定时器 unref()，不阻止进程退出（桌面侧关窗口时不该被它吊住）。

    /**
     * 启动自动连接：按拓扑决定要不要监听，并周期性地把 dialTargets 拨上。
     *
     * 幂等：重复调用不会起第二个定时器。
     *
     * @param {object} [options] - 选项。
     * @param {number} [options.intervalMs] - 基础重试间隔，默认 5000。
     * @param {(conn: object) => void} [options.onConnection] - 每条新连接的回调
     *        （用来注册本端可被调用的方法）。
     * @param {boolean} [options.listen] - 是否同时监听入站，默认 true。
     * @returns {Promise<{listening: boolean, port: number|null}>} 启动结果。
     */
    async startAutoConnect({ intervalMs = 5000, onConnection, listen = true } = {}) {
        if (this.autoTimer) return { listening: Boolean(this.server), port: this.server ? this.port : null };
        this.autoIntervalMs = intervalMs;
        this.autoOnConnection = onConnection;

        let listening = false;
        if (listen) {
            try {
                await this.listen({ onConnection: (conn) => this.#onAutoConnection(conn) });
                listening = true;
            } catch (error) {
                // 监听失败不该让自动拨号也停掉：mesh 里「我连出去」和「别人连进来」
                // 是两条独立的路，前者可用就先让它工作。
                this.log('link: 自动连接时监听失败（仍会尝试主动拨号）：' + (error?.message ?? error));
            }
        }

        // 立刻跑一次（别等第一个 interval），再挂定时器。
        void this.#autoTick();
        this.autoTimer = setInterval(() => { void this.#autoTick(); }, intervalMs);
        if (typeof this.autoTimer.unref === 'function') this.autoTimer.unref();
        this.log('link: 自动连接已启动（拓扑 ' + this.topology + '，间隔 ' + intervalMs + 'ms）');
        return { listening, port: listening ? this.port : null };
    }

    /** 停止自动连接（定时器 + 监听）。 */
    async stopAutoConnect() {
        if (this.autoTimer) {
            clearInterval(this.autoTimer);
            this.autoTimer = null;
        }
        this.dialFailures.clear();
        if (this.server) {
            const handle = this.server;
            this.server = null;
            try { await handle.close(); } catch { /* 已关 */ }
        }
        this.closeAll();
        this.log('link: 自动连接已停止');
    }

    /** 一条新的（主动拨出或被动接入的）连接就绪。 */
    #onAutoConnection(conn) {
        try { this.autoOnConnection?.(conn); } catch (error) {
            this.log('link: onConnection 抛错 ' + (error?.message ?? error));
        }
    }

    /**
     * 一轮自动拨号。
     *
     * 逐个尝试 dialTargets，失败的按设备记退避；成功的清计数。
     * 单个设备失败**不中断**其它设备 —— 一台没开不该拖住其余全部。
     */
    async #autoTick() {
        if (this.topology !== TOPOLOGY.mesh) return;
        for (const rec of this.dialTargets()) {
            const id = rec.deviceId;
            const failures = this.dialFailures.get(id) ?? 0;
            // 指数退避，上限 60 秒：2^n × 基础间隔。
            const waitMs = Math.min(this.autoIntervalMs * 2 ** failures, 60_000);
            const lastAt = this.dialLastAt.get(id) ?? 0;
            if (Date.now() - lastAt < waitMs) continue;

            this.dialLastAt.set(id, Date.now());
            try {
                const conn = await this.dial(id, {
                    // 这里**不**跳过仲裁：自动互连必须遵守字典序，否则两端同时拨
                    // 会各建一条重复连接（dialTargets 已经按仲裁筛过，这里是第二道）。
                    force: false,
                    onConnection: (c) => this.#onAutoConnection(c),
                });
                if (conn) {
                    this.dialFailures.delete(id);
                    this.log('link: 已自动连上 ' + (rec.name ?? id));
                }
            } catch (error) {
                const n = failures + 1;
                this.dialFailures.set(id, n);
                // 头两次失败不必吵，多半只是对端还没起来。
                if (n <= 2 || n % 5 === 0) {
                    this.log('link: 自动连接 ' + (rec.name ?? id) + ' 失败（第 ' + n + ' 次）：'
                        + (error?.message ?? error));
                }
            }
        }
    }

    /**
     * 中转：把一次方法调用转发到「我连着、但调用方连不上」的那台设备。
     *
     * 这是 star 拓扑里两台设备互通的唯一途径 —— 它们都连着本机（hub），
     * 但彼此没有直连路径。
     *
     * 安全边界（缺一不可）：
     *   · **不转发 relay.\*** —— 只做一跳。允许链式转发的话，A→B→C 的延迟和
     *     排障都会失控，而且会被当成放大器；
     *   · **只转发目标宣告过的方法** —— 拿 peerMethods 比对。否则等于给调用方
     *     一个「任意方法调用」的口子，绕过目标自己的能力声明；
     *   · **只在目标在线时转发** —— 离线直接报错，不能把请求吞掉。
     *
     * @param {object} args - { to, method, args }。
     * @returns {Promise<any>} 目标方法的返回值。
     */
    async relayCall({ to, method, args } = {}) {
        const targetId = String(to ?? '');
        const name = String(method ?? '');
        if (!targetId) throw new Error('relay.call 需要 to（目标 deviceId）');
        if (!name) throw new Error('relay.call 需要 method');
        if (name.startsWith('relay.')) {
            throw new Error('不支持链式转发（relay.* 不能被再次转发）');
        }
        if (targetId === this.deviceId) {
            // 目标是自己：这不是转发，是绕圈子。直接拒绝，免得调用方误用。
            throw new Error('不能经由本机转发到本机');
        }
        const conn = this.connectionTo(targetId);
        if (!conn || conn.closed) throw new Error('目标设备不在线：' + targetId);
        if (!(conn.peerMethods ?? []).includes(name)) {
            throw new Error('目标设备未提供方法 ' + name + '（只有：' + (conn.peerMethods ?? []).join(', ') + '）');
        }
        this.log('link: 中转 ' + name + ' → ' + targetId);
        // 转发多一跳，超时放宽到 60s：截图/读会话这类本来就慢，再加一跳容易撞默认 30s。
        return conn.call(name, args ?? {}, { timeoutMs: 60_000 });
    }

    /** 生成一个长期令牌。 @returns {string} 令牌。 */
    #mintToken() {
        // 用 node:crypto 的 randomBytes，不用 globalThis.crypto.getRandomValues ——
        // 后者在 nodejs-mobile 的某些构建里不存在（手机端就是这个运行时），
        // 而令牌是长期凭据，拿不到强随机源时必须失败而不是退化。
        const token = randomBytes(24).toString('hex');
        this.acceptToken(token);
        return token;
    }
}
