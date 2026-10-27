/**
 * 「经另一台设备调用」—— 一个真正的 llm adapter。
 *
 * ── 为什么需要它（之前缺了它，功能其实不完整）────────────────────────────────
 * 插件原来只调 `ctx.llm.registerConfigurableProviders(...)`，我以为那能让
 * provider 出现在模型选择器里 —— **那是错的**，已核对 dsh-llm 源码：
 *
 *   · registerConfigurableProviders → 写 `this.directory`（用户去哪填凭据）
 *   · listProviders()             → 读 `this.adapters`（有执行能力的实现）
 *
 * 两者不是一回事。所以「经另一台设备调用」**从来没有出现在任何下拉里**
 * —— 桌面也没有。之前模型转发能工作，靠的是 `llm/stream` waterfall
 * 自动拦截：本地跑不了就转发，用户不需要选任何东西。
 *
 * 有了这个 adapter，它才真正成为一个可选的 provider。
 *
 * ── 为什么只实现 3 个方法 ────────────────────────────────────────────────────
 * 基类给了几乎全部默认实现（已逐个核对 dsh-llm/lib/index.js）：
 *
 *   resolveModel(provider, model, _signal)  → { provider, id, name }   ✅ 可用
 *   prepareCall(provider, model, signal)    → { model, stream(options) } ✅
 *   providerInfo(provider)                  → { id, name }              可用但要覆盖
 *   listModels(_provider)                   → Promise.resolve([])        ❌ 空的
 *   stream                                   → 抽象                      ❌ 必须实现
 *
 * 所以只需 stream / listModels / providerInfo 三个。
 *
 * ── provider 名为什么带冒号 ──────────────────────────────────────────────────
 * `llm-remote:<targetDeviceId>` —— 带目标设备是为了让「两台都宣告了转发能力」
 * 时可以分别选择连哪一台。不带的话只能连 `relayViaAnyPeer` 挑的那台
 * （直接优先、经中转兜底），用户没有选择权。
 *
 * ⚠️ providerId 里不能有 `/`，它在设置路径里当分隔符用。
 */

// ⚠️ 这里是**规范源**（packages/dsh-link-protocol/lib/），同级的模块用 './'。
//    写成 './link-protocol/llmrelay.js' 是插件里的相对路径，在规范源里解析不到 ——
//    而 sync 会把本文件原样拷进插件的 lib/link-protocol/，那时 './' 正好对。
//    所以两边都用 './'：规范源里指向 llmrelay.js，同步后在插件里也指向 llmrelay.js。
import {
    REMOTE_PROVIDER, REMOTE_PROVIDER_LABEL, RELAY_ADVERTISED,
} from './llmrelay.js';

/** 远程 provider 的前缀（含冒号，用来分隔目标设备）。 */
export const REMOTE_PREFIX = REMOTE_PROVIDER + ':';

/**
 * 这个 provider 是不是「经另一台设备调用」（含带目标设备后缀的形式）。
 *
 * ⚠️ 必须用 startsWith 而不是 `=== REMOTE_PROVIDER`：adapter 注册的是
 *    带目标后缀的 `llm-remote:<deviceId>`，而 llm/stream 拦截时收到的
 *    options.provider 正是那个带后缀的值。用等号判断会漏，于是用户显式
 *    选了「经另一台设备调用」时请求被**再转发一次** —— 自己转给自己。
 */
export function isRemoteProvider(provider) {
    return typeof provider === 'string' && provider.startsWith(REMOTE_PREFIX);
}

/** 本地没有该目标时的占位模型（让下拉不至于空着）。 */
const UNKNOWN_MODEL = '__remote_default__';

/**
 * 构造一个 adapter。
 *
 * @param {object} deps
 * @param {() => object} deps.peers - 返回当前在线且宣告 llm.relay 的设备清单。
 * @returns {object} 可传给 ctx.llm.registerAdapter 的 adapter。
 */
export function createRemoteAdapter({ peers }) {
    return {
        // ── 显示 ─────────────────────────────────────────────────────────────
        providerInfo(provider) {
            const target = provider.slice(REMOTE_PREFIX.length);
            return {
                id: provider,
                // 带目标设备名，用户才知道请求会发给谁。
                name: target ? `${REMOTE_PROVIDER_LABEL} · ${target}` : REMOTE_PROVIDER_LABEL,
            };
        },

        // ── 模型列表 ─────────────────────────────────────────────────────────
        /**
         * 列出目标设备上的模型。
         *
         * ⚠️ 不能返回空数组 —— 基类的默认实现就是 `Promise.resolve([])`，
         *   那正是「provider 出现在下拉、但一个模型都没有」的由来。
         *
         * 每个模型都带上 provider 前缀，这样用户选中后请求会经
         * llm/stream → relayViaAnyPeer 转发到**拥有该模型**的那台设备 ——
         * 而不只是「第一台宣告了转发能力的设备」。
         */
        async listModels(provider) {
            const target = provider.slice(REMOTE_PREFIX.length);
            const online = peers().filter((p) => (p.capabilities ?? []).includes(RELAY_ADVERTISED));
            const usable = target ? online.filter((p) => p.deviceId === target) : online;
            if (!usable.length) return [];

            const out = [];
            // 并发取所有可达设备的列表：串行会让多设备场景明显变慢
            // （每次都是一次网络往返）。
            await Promise.all(usable.map(async (p) => {
                const r = await fetchModels(p);
                for (const m of r) {
                    out.push({
                        provider,                        // 必须等于被问的 provider
                        id: `${REMOTE_PREFIX}${m.id}`,   // 编码原模型 id
                        name: `${m.name}（${p.name}）`,
                    });
                }
            }));
            // 一个模型都没有时给一个占位项：否则下拉是空白，用户会以为
            // 没连上，而实际是「对方没返回模型」。占位项在 stream 时会被
            // 解析成「用对方默认模型」。
            if (!out.length) {
                out.push({ provider, id: UNKNOWN_MODEL, name: '默认模型' });
            }
            return out;
        },

        // ── 实际调用 ─────────────────────────────────────────────────────────
        /**
         * 执行流式调用。
         *
         * 直接复用 llm.relay 的转发器 —— 它已经处理了「先直连、再经中转、
         * 失败时列出试过谁」，这里不重复实现。
         *
         * ⚠️ 这条路径与 waterfall 拦截**互不冲突**：llm/stream 的监听器里
         *    有 `options.provider === REMOTE_PROVIDER` 的判断，命中就放行
         *    原样本地走 —— 于是用户显式选「经另一台设备调用」时不会被
         *    再转发一次（否则就成了自己转给自己）。
         */
        async *stream(options) {
            // ⚠️ provider/model 放在**展开之后**覆盖：options 里带着
            //    llm-remote:…:xxx 这种带前缀的值，必须换回对端认识的原值。
            //    顺序反了就会把前缀也发给对端，对端找不到模型。
            const original = {
                ...options,
                provider: REMOTE_PROVIDER,
                model: decodeModel(options?.model),
            };
            // 不指定 conn：relayViaAnyPeer 自己遍历在线设备挑可达的
            // （先直连、再经中转），那条逻辑两端共用，不在这里重复实现。
            yield* forwardStream(original);
        },
    };
}

/** 从编码后的模型 id 里取出原 id（占位符 → 空，让对端用它自己的默认）。 */
function decodeModel(id) {
    if (typeof id !== 'string') return '';
    const i = id.indexOf(':');
    const raw = i >= 0 ? id.slice(i + 1) : id;
    return raw === UNKNOWN_MODEL ? '' : raw;
}

/** 取某设备的模型列表（走 link 通道）。 */
async function fetchModels(peer) {
    const conn = peer.conn;
    if (!conn || typeof conn.call !== 'function') return [];
    try {
        const res = await conn.call('llm.list', {});
        const models = res?.models ?? {};
        return Object.values(models).flat().map((m) =>
            typeof m === 'string' ? { id: m, name: m } : { id: m?.id, name: m?.name ?? m?.id },
        );
    } catch {
        // 单台设备取不到不影响其它设备 —— 与 safeModels 同样的容错原则。
        return [];
    }
}

/**
 * 实际转发。
 *
 * 单独抽出来是为了让 mobile 与 desktop 插件各自注入「怎么找到连接」，
 * 而转发本身的形状（块逐个透传、错误传播）由 llmrelay.relayStream 保证。
 */
let forwardStream = async function* () {
    throw new Error('createRemoteAdapter 需要注入 forwardStream');
};

/** 注入转发实现（两端插件各调一次）。 */
export function setForwardStream(fn) {
    forwardStream = fn;
}