/**
 * DSH 远程联动 —— 设备注册表（mesh 核心）。
 *
 * 回答「我认识谁」。每台设备一份 `$DSH_HOME/link/registry.json`，记录已配对设备：
 *
 *   { deviceId, name, kind, publicKey, endpoint, lastSeen, capabilities }
 *
 * 设计要点：
 *   · **不需要中心**。配对时双方各自把对方写进自己的清单，所以天然去中心化 ——
 *     这也是 EasyTier/Tailscale 的思路，不依赖任何第三方协调。
 *   · **capabilities 缓存**对端宣告的方法清单，只是加速 UI 展示；真正的
 *     能力以握手时返回的 `methods` 为准（见 connection.js 的 peerMethods）。
 *   · 写盘失败不抛：DSH_HOME 可能只读（手机上偶尔遇到），此时注册表只活在内存。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 注册表里的单条设备记录。 */
export class PeerRecord {
    /**
     * @param {object} init - 初始字段。
     */
    constructor(init = {}) {
        /** @type {string} 稳定设备 id（公钥指纹）。 */
        this.deviceId = init.deviceId;
        /** @type {string} 人类可读名。 */
        this.name = init.name ?? init.deviceId;
        /** @type {string} 'desktop' | 'mobile'。 */
        this.kind = init.kind ?? 'device';
        /** @type {string} 对端公钥（PEM），用于身份校验。 */
        this.publicKey = init.publicKey ?? null;
        /** @type {string} 连接地址 host:port。 */
        this.endpoint = init.endpoint ?? null;
        /**
         * @type {string|null} 对端签发给本端的长期令牌。
         *
         * ⚠️ 这个字段必须落盘：没有它，重连就只能重新输 6 位配对码，而码是
         * 一次性的 —— 等于每次重连都要人跑去桌面点一次「换一个配对码」。
         * 它和 publicKey 一样属于「配对时确立、之后长期使用」的凭据。
         */
        this.token = init.token ?? null;
        /** @type {number} 上次在线时间戳。 */
        this.lastSeen = init.lastSeen ?? 0;
        /** @type {string[]} 对端宣告的能力（缓存，仅供 UI）。 */
        this.capabilities = init.capabilities ?? [];
    }

    /** @returns {object} 适合展示/传输的形态（不含任何私钥）。 */
    toPublic() {
        // ⚠️ 刻意**不含 token**：这个形态会进 HTTP 路由的响应与 UI 渲染，
        // 而令牌是能直接冒充本机连上对端的长期凭据。需要令牌的只有 dial()，
        // 它读的是 PeerRecord 实例本身。
        return {
            deviceId: this.deviceId,
            name: this.name,
            kind: this.kind,
            endpoint: this.endpoint,
            lastSeen: this.lastSeen,
            capabilities: this.capabilities,
            paired: Boolean(this.token),
        };
    }
}

/**
 * 设备注册表：读、改、落盘。
 */
export class Registry {
    /**
     * @param {string} homeDir - DSH_HOME。
     * @param {string} selfId - 自己的 deviceId（用于跳过自己）。
     */
    constructor(homeDir, selfId) {
        this.file = path.join(homeDir, 'link', 'registry.json');
        this.selfId = selfId;
        /** @type {Map<string, PeerRecord>} */
        this.peers = new Map();
        /**
         * @type {string} 连接拓扑：star / mesh。
         *
         * 存这里而不是只放内存：拓扑是**用户的显式选择**（「我装了 overlay，改成
         * 全互联」），重启后被打回默认值的话，用户会以为「设了没用」——
         * 而且 mesh 下两台设备都必须是 mesh 才互连，一边悄悄回落就永远连不上。
         *
         * 默认 **mesh**（不是 star）：mesh 是超集 —— 它同时做「监听」和「主动拨
         * 已知设备」，而 star 只是「hub 监听、其余拨入」。默认 mesh 时，有 overlay
         * 的用户开箱即用；没有 overlay 的用户，设备之间拨不通也只是那几条拨号失败
         * （有退避，不刷屏），而**与 hub 的连接照常建立** —— 也就是退化到 star 的
         * 可用性，却不必让人先去改设置。反过来默认 star 的话，装了 overlay 的人
         * 得先找到这个开关，而找不到时的表现是「明明在同一张虚拟网里却连不上」。
         */
        this.topology = 'mesh';
        this.load();
    }

    /** 从磁盘载入；没有就用空表。 */
    load() {
        this.peers = new Map();
        try {
            const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            for (const item of raw?.peers ?? []) {
                if (item?.deviceId && item.deviceId !== this.selfId) {
                    this.peers.set(item.deviceId, new PeerRecord(item));
                }
            }
            if (raw?.topology === 'mesh' || raw?.topology === 'star') this.topology = raw.topology;
        } catch { /* 首次运行没有这文件 */ }
    }

    /**
     * 记下拓扑选择并落盘。
     * @param {string} topology - 'star' | 'mesh'。
     * @returns {string} 生效后的拓扑。
     */
    setTopology(topology) {
        this.topology = topology === 'mesh' ? 'mesh' : 'star';
        this.save();
        return this.topology;
    }

    /**
     * 落盘。失败只记警告 —— 注册表丢失不该让联动整体不可用。
     *
     * ⚠️ 这里必须写**完整记录**（含 token），不能用 toPublic()：
     * toPublic() 刻意剥掉了令牌（它要进 HTTP 响应和 UI），拿它落盘会让令牌
     * 永远存不下来 —— 表现是每次重连都要重新输 6 位配对码，而码是一次性的，
     * 等于每次都要人跑去桌面点「换一个配对码」。落盘和对外展示是两件事。
     *
     * @returns {boolean} 是否成功。
     */
    save() {
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const peers = [...this.peers.values()].map((p) => ({
                deviceId: p.deviceId,
                name: p.name,
                kind: p.kind,
                publicKey: p.publicKey,
                endpoint: p.endpoint,
                token: p.token,
                lastSeen: p.lastSeen,
                capabilities: p.capabilities,
            }));
            fs.writeFileSync(this.file, JSON.stringify({ version: 1, topology: this.topology, peers }, null, 2), 'utf8');
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 记入/更新一个已配对设备。
     * @param {object} init - 设备字段。
     * @returns {PeerRecord} 记录。
     */
    upsert(init) {
        if (!init?.deviceId) throw new Error('upsert 需要 deviceId');
        if (init.deviceId === this.selfId) throw new Error('不能把自己登记成对端');
        const existing = this.peers.get(init.deviceId);
        const rec = existing ?? new PeerRecord(init);
        // 只覆盖显式提供的字段，避免一次 partial 更新把已有信息清空。
        // token 也在其中：配对成功时写入，之后 partial 更新（如只改 lastSeen）
        // 不会把它抹掉。
        for (const k of ['name', 'kind', 'publicKey', 'endpoint', 'capabilities', 'token']) {
            if (init[k] !== undefined) rec[k] = init[k];
        }
        rec.lastSeen = init.lastSeen ?? rec.lastSeen;
        this.peers.set(rec.deviceId, rec);
        this.save();
        return rec;
    }

    /**
     * 移除一个设备。
     * @param {string} deviceId - 设备 id。
     * @returns {boolean} 是否确实移除了。
     */
    remove(deviceId) {
        const had = this.peers.delete(deviceId);
        if (had) this.save();
        return had;
    }

    /**
     * 取一个设备。
     * @param {string} deviceId - 设备 id。
     * @returns {PeerRecord|null} 记录或 null。
     */
    get(deviceId) {
        return this.peers.get(deviceId) ?? null;
    }

    /** @returns {PeerRecord[]} 全部已配对设备。 */
    list() {
        return [...this.peers.values()];
    }

    /** @returns {number} 已配对设备数（不含自己）。 */
    get size() {
        return this.peers.size;
    }
}
