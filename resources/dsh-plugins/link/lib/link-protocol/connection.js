/**
 * DSH 远程联动 —— 连接层：握手、双向调用、应答配对、事件。
 *
 * 两端（手机 / 桌面）共用这一个实现，只是角色不同：
 *   桌面 = server（监听端口，校验配对令牌）
 *   手机 = client（主动拨号过去，因为手机通常没有固定可达地址、也不该开入站端口）
 *
 * 关键设计：**一根 socket 双向都能发 call**。
 *   · 桌面发 mobile.*   → 手机执行（截图、点击、输入）
 *   · 手机发 computer.* → 桌面执行（截图、鼠标、键盘）
 * 所以这里不做「客户端/服务端」的能力区分，只有「谁先握手」的区别。
 */

import { EventEmitter } from 'node:events';
import { LineDecoder, encode, PROTOCOL_VERSION, MAX_FRAME_BYTES } from './protocol.js';

/** 一次 call 的默认超时。截图类方法调用方会显式放宽。 */
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/**
 * 一条已建立的联动连接。
 *
 * @fires LinkConnection#event
 * @fires LinkConnection#close
 */
export class LinkConnection extends EventEmitter {
    /**
     * @param {import('node:net').Socket} socket - 已连接的 socket（握手由调用方完成）。
     * @param {object} options - 选项。
     * @param {'host'|'client'} options.role - 本端角色。
     * @param {object} [options.peer] - 对端描述（握手后由握手流程填入）。
     * @param {string[]} [options.peerMethods] - 对端声明可被调用的方法。
     * @param {(msg: string) => void} [options.log] - 日志函数。
     */
    constructor(socket, { role, peer = null, peerMethods = [], log = () => {} } = {}) {
        super();
        this.role = role;
        this.peer = peer;
        this.peerMethods = peerMethods;
        this.log = log;
        this.socket = socket;
        this.closed = false;
        this.nextId = 1;
        /** @type {Map<number, {resolve: Function, reject: Function, timer: any}>} */
        this.pending = new Map();
        /** @type {Map<string, (args: object) => Promise<any>|any>} */
        this.handlers = new Map();

        socket.setNoDelay(true);
        this.decoder = new LineDecoder((msg) => this.#onMessage(msg));
        socket.on('data', (chunk) => {
            try {
                this.decoder.push(chunk);
            } catch (error) {
                this.log('link: 解码失败 ' + error.message + '，断开连接');
                this.destroy();
            }
        });
        socket.on('error', (error) => {
            this.log('link: socket 错误 ' + (error?.code ?? error?.message));
            this.destroy();
        });
        socket.on('close', () => this.#finish('socket closed'));
    }

    /**
     * 注册一个本端可被对端调用的方法。
     * @param {string} method - 方法名（见 protocol.js 的方法表）。
     * @param {(args: object, meta: {signal: AbortSignal}) => Promise<any>|any} fn - 实现。
     */
    handle(method, fn) {
        this.handlers.set(method, fn);
        return this;
    }

    /**
     * 调用对端的一个方法。
     * @param {string} method - 方法名。
     * @param {object} [args] - 参数。
     * @param {object} [options] - 选项。
     * @param {number} [options.timeoutMs] - 超时。
     * @returns {Promise<any>} 对端的返回值；对端抛错时以 Error 拒绝。
     */
    call(method, args = {}, { timeoutMs = DEFAULT_CALL_TIMEOUT_MS } = {}) {
        if (this.closed) return Promise.reject(new Error('link: 连接已关闭'));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('link: 调用 ' + method + ' 超时（' + timeoutMs + 'ms）'));
            }, timeoutMs);
            if (typeof timer.unref === 'function') timer.unref();
            this.pending.set(id, { resolve, reject, timer });
            this.#write({ t: 'call', id, method, args });
        });
    }

    /**
     * 发一条单向通知（不等待应答）。
     * @param {string} name - 事件名。
     * @param {object} [data] - 数据。
     */
    sendEvent(name, data = {}) {
        this.#write({ t: 'event', name, data });
    }

    /** 优雅关闭：先发 bye，再关 socket。 */
    close(reason = 'bye') {
        if (this.closed) return;
        try {
            this.#write({ t: 'bye', reason });
        } catch { /* 已断开就算了 */ }
        this.#finish(reason);
    }

    /** 立即销毁（出错时用，不讲究礼貌）。 */
    destroy() {
        this.#finish('destroyed');
    }

    /**
     * 写入一条消息。
     * @param {object} msg - 消息对象。
     */
    #write(msg) {
        if (this.closed) return;
        const line = encode(msg);
        if (line.length > MAX_FRAME_BYTES) throw new Error('link: 发出的帧过大');
        this.socket.write(line);
    }

    /**
     * 处理一条入站消息。
     * @param {object} msg - 解析后的消息。
     */
    #onMessage(msg) {
        switch (msg.t) {
            case 'call':
                this.#onCall(msg);
                break;
            case 'reply': {
                const entry = this.pending.get(msg.id);
                if (!entry) return;
                this.pending.delete(msg.id);
                clearTimeout(entry.timer);
                if (msg.ok) entry.resolve(msg.value);
                else {
                    const error = new Error(msg.error?.message ?? '对端报错');
                    if (msg.error?.code) error.code = msg.error.code;
                    entry.reject(error);
                }
                break;
            }
            case 'event':
                this.emit('event', msg.name, msg.data ?? {});
                break;
            case 'bye':
                this.log('link: 对端关闭（' + (msg.reason ?? '无原因') + '）');
                this.#finish('peer bye');
                break;
            default:
                // 未知消息：握手后出现的多半是版本不一致，记下来比静默丢弃强。
                this.log('link: 收到未知消息类型 ' + String(msg.t));
        }
    }

    /**
     * 执行对端请求的方法。
     * @param {{id: number, method: string, args: object}} msg - call 消息。
     */
    async #onCall(msg) {
        const fn = this.handlers.get(msg.method);
        if (!fn) {
            this.#write({
                t: 'reply', id: msg.id, ok: false,
                error: { code: 'METHOD_NOT_FOUND', message: '本端未提供方法 ' + msg.method },
            });
            return;
        }
        const controller = new AbortController();
        try {
            const value = await fn(msg.args ?? {}, { signal: controller.signal });
            this.#write({ t: 'reply', id: msg.id, ok: true, value: value === undefined ? null : value });
        } catch (error) {
            this.#write({
                t: 'reply', id: msg.id, ok: false,
                error: {
                    code: error?.code ?? 'CALL_FAILED',
                    message: String(error?.message ?? error).slice(0, 2000),
                },
            });
        }
    }

    /**
     * 收尾：拒绝所有在途请求，关 socket，发 close 事件。
     * @param {string} reason - 关闭原因。
     */
    #finish(reason) {
        if (this.closed) return;
        this.closed = true;
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(new Error('link: 连接关闭（' + reason + '）'));
        }
        this.pending.clear();
        try {
            this.socket.destroy();
        } catch { /* ignore */ }
        this.emit('close', reason);
    }
}

export { PROTOCOL_VERSION, MAX_FRAME_BYTES };
