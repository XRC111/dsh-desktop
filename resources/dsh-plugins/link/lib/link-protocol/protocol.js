/**
 * DSH 远程联动 —— 两端共享的线路协议。
 *
 * ── 为什么自己写传输，不用 WebSocket ─────────────────────────────────────────
 * 目标环境是「手机 DSH ↔ 桌面 DSH」，两端都跑同一份 Harness。约束是：
 *   · 手机端是 nodejs-mobile 内嵌，插件不能有安装期依赖（不能 npm install ws）；
 *   · 桌面端的插件由外壳落位，同样不该引入新依赖；
 *   · 这条链路要能在两端跑单测（回环），不依赖任何外部服务。
 * Node 自带的 net + 行分隔 JSON 满足全部三条，且完全可测。WebSocket 只多一层
 * 握手和掩码，这里没有浏览器参与，用不上。
 *
 * ── 帧格式 ──────────────────────────────────────────────────────────────────
 * 每条消息是一行 UTF-8 JSON，以 \n 结尾（NDJSON）。选它是因为：
 *   · 分帧逻辑只有「找换行」，不可能写错；
 *   · 出错时肉眼就能看懂流量，调试成本低；
 *   · 不需要长度前缀，也不怕粘包/半包（缓冲区攒到换行再切）。
 * 代价是不能传二进制 —— 文件走 base64 分块（见 fileChunks）。
 *
 * ── 消息类型 ────────────────────────────────────────────────────────────────
 *   hello   → 连接后第一帧，带配对令牌与自身描述
 *   welcome → 接受配对，回带对端描述与它提供的方法清单
 *   reject  → 拒绝配对（令牌不符 / 版本不符），随后断开
 *   call    → 请求调用一个方法
 *   reply   → 对 call 的应答（ok / error）
 *   event   → 单向通知，不期待应答
 *   bye     → 正常关闭
 *
 * 谁都可以发 call —— 这是**双向**的：桌面调用手机的 mobile.*，手机调用桌面的
 * computer.* / session.*。同一根 socket 上两个方向的 id 各自递增，互不干扰。
 */

/** 协议版本。两端不一致就拒绝配对，避免半懂不懂地跑出错数据。 */
export const PROTOCOL_VERSION = 1;

/** 默认端口。桌面在局域网上监听它，手机拨过去。 */
export const DEFAULT_PORT = 45731;

/** 单帧上限（16 MiB）。超过多半是分帧错了，宁可明确报错也不要吃满内存。 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** 文件分块大小（base64 前的原始字节）。 */
export const FILE_CHUNK_BYTES = 256 * 1024;

/**
 * 手机端提供、供桌面调用的方法。
 * 名字用 mobile.* 前缀 —— 与手机侧已有的 mobile-use 插件能力对应。
 */
export const MOBILE_METHODS = [
    'mobile.status',
    'mobile.screen_shot',
    'mobile.screen_elements',
    'mobile.click',
    'mobile.scroll',
    'mobile.key',
    'mobile.type',
];

/**
 * 桌面端提供、供手机调用的方法。
 * computer.* 对应桌面侧的 computer-use 插件；session.* 对应会话互通。
 */
export const DESKTOP_METHODS = [
    'computer.status',
    'computer.screen_shot',
    'computer.screen_windows',
    'computer.click',
    'computer.type',
    'computer.key',
    'session.list',
    'session.read',
    'session.push',
];

/** 两端都提供的通用方法。 */
export const COMMON_METHODS = [
    'file.push',
    'clipboard.get',
    'clipboard.set',
];

/**
 * 「经中转调用」的方法名。
 *
 * 谁**同时**连着两台设备，谁就提供它 —— 通常是 star 拓扑里的 hub（桌面）：
 * 两台手机都连到桌面但彼此连不上，于是一台要去另一台的方法，就让桌面代转。
 *
 * 只做**一跳**：不转发 `relay.*` 本身（见 mesh-manager 的 relayCall），
 * 否则 A→B→C→… 的链条会让延迟和故障排查都失控。
 *
 * ⚠️ 名字不能叫 RELAY_METHOD：llmrelay.js 已经导出了同名常量（值 'llm.relay'，
 *    是**完全不同的东西** —— 远程凭据转发）。两者在同一文件里 import 时后者会
 *    静默覆盖前者，于是 `conn.handle(RELAY_METHOD, ...)` 变成注册 'llm.relay'，
 *    把流式转发的处理器顶掉，而真正要注册的 relay.call 从未出现。
 *    实测踩过，所以这里用 TRANSIT_METHOD 明确区分。
 */
export const TRANSIT_METHOD = 'relay.call';

/**
 * 生成一个短配对码（6 位数字）。
 *
 * 用 crypto 的随机源，不用 Math.random —— 这个码是这条链路唯一的门禁，
 * 局域网里任何人只要猜到它就能操作对方的设备（包括鼠标键盘）。
 *
 * @returns {string} 形如 "048213" 的 6 位数字串。
 */
export function makePairingCode() {
    // 拒绝采样避免取模偏置（虽小，但这里代价几乎为零）。
    const limit = Math.floor(0xffffffff / 1000000) * 1000000;
    const { randomBytes } = globalThis.__dshLinkRandom ?? {};
    let n;
    do {
        if (randomBytes) n = randomBytes(4).readUInt32BE(0);
        else {
            const buf = new Uint8Array(4);
            globalThis.crypto.getRandomValues(buf);
            n = (buf[0] << 24 >>> 0) + (buf[1] << 16) + (buf[2] << 8) + buf[3];
        }
    } while (n >= limit);
    return String(n % 1000000).padStart(6, '0');
}

/**
 * 生成一个长令牌。配对码是给人念的，令牌是给机器重连用的。
 * @returns {string} 32 位十六进制。
 */
export function makeToken() {
    const buf = new Uint8Array(16);
    globalThis.crypto.getRandomValues(buf);
    return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 把任意大小的数据进行 base64 分块。
 * @param {Buffer|Uint8Array} data - 原始数据。
 * @param {number} [chunkBytes] - 每块字节数。
 * @returns {string[]} base64 块数组（最后一块可能更短）。
 */
export function fileChunks(data, chunkBytes = FILE_CHUNK_BYTES) {
    const out = [];
    for (let i = 0; i < data.length; i += chunkBytes) {
        out.push(Buffer.from(data.subarray(i, i + chunkBytes)).toString('base64'));
    }
    return out;
}

/**
 * 把分块还原为 Buffer。
 * @param {string[]} chunks - base64 块数组。
 * @returns {Buffer} 原始数据。
 */
export function joinChunks(chunks) {
    return Buffer.concat(chunks.map((c) => Buffer.from(c, 'base64')));
}

/**
 * NDJSON 分帧器：把字节流切成一行一条消息。
 *
 * ⚠️ 必须处理**半包**：一次 TCP read 可能只拿到半行，也可能一次拿到三行半。
 * 缓冲区攒着，只在看到 \n 时才切 —— 这是这类代码唯一容易写错的地方。
 */
export class LineDecoder {
    /** @param {(msg: object) => void} onMessage - 每解析出一条消息回调一次。 */
    constructor(onMessage) {
        this.onMessage = onMessage;
        this.buffer = '';
    }

    /**
     * 喂入一段数据。
     * @param {Buffer|string} chunk - 新到的字节。
     */
    push(chunk) {
        this.buffer += chunk.toString('utf8');
        if (this.buffer.length > MAX_FRAME_BYTES) {
            throw new Error('link: 单帧超过 ' + MAX_FRAME_BYTES + ' 字节，疑似分帧错误');
        }
        let idx;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, idx);
            this.buffer = this.buffer.slice(idx + 1);
            if (line.trim() === '') continue;
            this.onMessage(JSON.parse(line));
        }
    }
}

/**
 * 把一条消息编码成一行。
 * @param {object} msg - 消息对象。
 * @returns {string} 带换行的字符串。
 */
export function encode(msg) {
    return JSON.stringify(msg) + '\n';
}
