/**
 * DSH 远程联动 —— 两端握手与建连。
 *
 * 桌面 = LinkServer（监听、校验配对码/令牌、发放长期令牌）
 * 手机 = connectToHost（拨号、出示配对码或令牌）
 *
 * ── 配对流程 ────────────────────────────────────────────────────────────────
 *   首次：桌面显示一个 6 位**配对码** → 用户在手机输入 → 手机用 code 握手
 *         → 桌面校验通过，回 welcome 并**发放一个长期令牌** → 手机存起来
 *   之后：手机直接用 token 握手，用户不必再输码
 *
 * 为什么要分「码」和「令牌」：码是给人念的、必须短、且**一次性**；令牌是给机器
 * 重连用的，长且长期有效。把两者混成一个，要么码太长没法念，要么长期凭据太弱。
 *
 * ── 会话密钥 ────────────────────────────────────────────────────────────────
 * 握手同时交换临时 ECDH 公钥，双方各自派生出会话密钥挂在连接上
 * （`conn.sessionKey`），用于封装 API Key 之类的机密。见 secret.js。
 *
 * 令牌校验用 timingSafeEqual —— 局域网里时序攻击不现实，但这类比较没有理由
 * 写成会短路的形式，免得被当范例抄走。
 */

import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { LinkConnection } from './connection.js';
import { LineDecoder, encode, PROTOCOL_VERSION } from './protocol.js';
import { makeEphemeralKeyPair, deriveSessionKey } from './secret.js';

/**
 * 定长比较两个字符串，避免短路比较。
 * @param {string} a - 第一个。
 * @param {string} b - 第二个。
 * @returns {boolean} 是否相同。
 */
function equals(a, b) {
    const ba = Buffer.from(String(a ?? ''), 'utf8');
    const bb = Buffer.from(String(b ?? ''), 'utf8');
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
}

/**
 * 启动桌面侧的联动服务。
 *
 * @param {object} options - 选项。
 * @param {number} [options.port] - 端口，0 表示由系统分配。
 * @param {string} [options.host] - 绑定地址。
 * @param {string} [options.token] - 固定令牌（不传 authorize 时用于直接比对）。
 * @param {(hello: object) => ({ok: true, token?: string} | {ok: false, reason: string})} [options.authorize]
 *        配对裁决：校验 hello 里的 code/token，决定是否接受、以及是否发放新令牌。
 * @param {object} options.device - 本机描述 { name, platform }。
 * @param {string[]} options.methods - 本端可被调用的方法清单。
 * @param {(conn: LinkConnection) => void} options.onConnection - 握手成功后回调。
 * @param {(msg: string) => void} [options.log] - 日志。
 * @returns {Promise<{port: number, address: string, connections: Set<LinkConnection>, close: () => Promise<void>}>}
 */
export async function startLinkServer({ port = 0, host = '0.0.0.0', token, authorize, device, methods, onConnection, log = () => {} }) {
    const connections = new Set();

    const server = net.createServer((socket) => {
        let settled = false;
        const decoder = new LineDecoder((msg) => {
            if (settled) return;
            if (msg.t !== 'hello') {
                socket.write(encode({ t: 'reject', reason: 'expected hello' }));
                socket.destroy();
                return;
            }
            if (msg.proto !== PROTOCOL_VERSION) {
                socket.write(encode({ t: 'reject', reason: 'protocol mismatch (local ' + PROTOCOL_VERSION + ', peer ' + msg.proto + ')' }));
                socket.destroy();
                return;
            }
            // 裁决：优先用调用方给的 authorize；否则退化成直接比对固定令牌。
            let verdict;
            try {
                verdict = authorize ? authorize(msg) : (equals(msg.token, token) ? { ok: true } : { ok: false, reason: 'bad token' });
            } catch (error) {
                verdict = { ok: false, reason: 'authorize threw: ' + (error?.message ?? error) };
            }
            if (!verdict?.ok) {
                log('link: 拒绝配对请求（' + (verdict?.reason ?? 'unknown') + '）来自 ' + socket.remoteAddress);
                socket.write(encode({ t: 'reject', reason: verdict?.reason ?? 'rejected' }));
                socket.destroy();
                return;
            }
            settled = true;
            socket.removeAllListeners('data');

            const conn = new LinkConnection(socket, {
                role: 'host',
                peer: msg.device ?? null,
                peerMethods: Array.isArray(msg.methods) ? msg.methods : [],
                log,
            });
            // 建立会话密钥：本端临时私钥 + 对端临时公钥。
            if (typeof msg.pub === 'string' && msg.pub.length > 0) {
                try {
                    conn.sessionKey = deriveSessionKey(pair.privateKey, msg.pub);
                } catch (error) {
                    log('link: 会话密钥派生失败 ' + (error?.message ?? error));
                }
            }
            connections.add(conn);
            conn.on('close', () => connections.delete(conn));

            socket.write(encode({
                t: 'welcome', proto: PROTOCOL_VERSION, device, methods,
                pub: pair.publicKey,
                ...(verdict.token ? { token: verdict.token } : {}),
            }));
            log('link: 已配对 ' + (msg.device?.name ?? '未知设备') + (conn.sessionKey ? '（已建立会话密钥）' : ''));
            try {
                onConnection(conn);
            } catch (error) {
                log('link: onConnection 抛错 ' + (error?.message ?? error));
            }
        });
        const pair = makeEphemeralKeyPair();
        socket.on('data', (chunk) => {
            if (settled) return;
            try { decoder.push(chunk); } catch { socket.destroy(); }
        });
        socket.on('error', () => socket.destroy());
        socket.setNoDelay(true);
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            server.removeListener('error', reject);
            resolve();
        });
    });
    const address = server.address();
    return {
        port: typeof address === 'object' && address ? address.port : port,
        address: host,
        connections,
        close: () => new Promise((resolve) => {
            for (const c of connections) c.close('server closing');
            server.close(() => resolve());
        }),
    };
}

/**
 * 手机侧拨号到桌面并完成握手。
 *
 * @param {object} options - 选项。
 * @param {string} options.host - 桌面地址。
 * @param {number} options.port - 桌面端口。
 * @param {string} [options.token] - 已有令牌（重连）。
 * @param {string} [options.code] - 配对码（首次配对）。
 * @param {object} options.device - 本机描述。
 * @param {string[]} options.methods - 本端可被调用的方法清单。
 * @param {number} [options.timeoutMs] - 握手超时。
 * @param {(msg: string) => void} [options.log] - 日志。
 * @returns {Promise<LinkConnection & {issuedToken?: string}>} 握手完成、可用的连接。
 */
export function connectToHost({ host, port, token, code, device, methods, timeoutMs = 8000, log = () => {} }) {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host, port });
        const pair = makeEphemeralKeyPair();
        let settled = false;
        let issuedToken;
        const decoder = new LineDecoder((msg) => {
            if (settled) return;
            if (msg.t === 'reject') {
                settled = true;
                socket.destroy();
                reject(new Error('link: 配对被拒绝（' + (msg.reason ?? '未知原因') + '）'));
                return;
            }
            if (msg.t !== 'welcome') return;
            settled = true;
            socket.removeAllListeners('data');
            issuedToken = msg.token;
            const conn = new LinkConnection(socket, {
                role: 'client',
                peer: msg.device ?? null,
                peerMethods: Array.isArray(msg.methods) ? msg.methods : [],
                log,
            });
            if (typeof msg.pub === 'string' && msg.pub.length > 0) {
                try {
                    conn.sessionKey = deriveSessionKey(pair.privateKey, msg.pub);
                } catch (error) {
                    log('link: 会话密钥派生失败 ' + (error?.message ?? error));
                }
            }
            conn.issuedToken = issuedToken;
            resolve(conn);
        });
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            socket.destroy();
            reject(new Error('link: 连接 ' + host + ':' + port + ' 超时'));
        }, timeoutMs);
        socket.on('connect', () => {
            socket.write(encode({
                t: 'hello', proto: PROTOCOL_VERSION, device, methods,
                pub: pair.publicKey,
                ...(token ? { token } : {}),
                ...(code ? { code } : {}),
            }));
        });
        socket.on('data', (chunk) => {
            if (settled) return;
            try { decoder.push(chunk); } catch (error) {
                settled = true; socket.destroy(); reject(error);
            }
        });
        socket.on('error', (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error('link: 连不上 ' + host + ':' + port + '（' + (error?.code ?? error?.message) + '）'));
        });
        socket.on('close', () => {
            clearTimeout(timer);
            if (settled) return;
            settled = true;
            reject(new Error('link: 连接在握手完成前关闭'));
        });
    });
}
