/**
 * 远程凭据转发 —— 协议（两端共享）。
 *
 * ── 要解决的问题 ────────────────────────────────────────────────────────────
 * 用户有手机和电脑两台 dsh，但模型 API Key / 账号登录态只在其中一台上。
 * 早先的做法是**把凭据文件复制过去**（`model.export` 传 `.credentials.yaml`），
 * 问题是：
 *   · 整文件带走了不相干的东西（实测把微信/QQ bot 令牌也带上了）；
 *   · 登录态 token 往往和设备/风控绑定，搬到手机上往往不可用；
 *   · key 离开了原机器。
 *
 * ── 现在的做法 ──────────────────────────────────────────────────────────────
 * **不传凭据，传请求。**
 *
 *   本地策略（B）：本地有可用 provider 就**本地执行**（快、少一跳）；
 *   本地没有 → 走 `llm.remote` provider → 经联动通道把**请求内容**发给对端，
 *   由对端用它自己的 adapter 执行，把流式结果逐块回传。
 *
 * 于是：
 *   · **凭据永远不离开它所属的机器** —— 谁发起请求，就用谁的 key；
 *   · **插件注入的 API 一并覆盖** —— 拦截点在 `llm/stream` waterfall，
 *     它在 adapter **之上**一层，所以第三方插件注册的 provider（Qoder、
 *     workbuddy、任何 `llm.registerAdapter` 的）一律经过，无需逐个适配。
 *
 * ── 为什么拦截点选在 llm/stream ────────────────────────────────────────────
 * `dsh-llm/lib/index.js` 里：
 *
 *     stream(options) {
 *       return this.ctx.waterfall(this, "llm/stream", options,
 *         () => this.adapterStream(options, prepared));
 *     }
 *
 * 每一次模型调用都经过它，`options` 是完整请求，监听器可以：
 *   · 调 `next()` → 正常本地执行；
 *   · 自己 yield chunk → 短路（我们转发的情形）。
 */

/** 本地执行策略。 */
export const RELAY_POLICY = {
    /** 优先本地：本地有可用 provider 就本地跑。 */
    localFirst: 'local-first',
    /** 一律转发：所有请求都发给对端。 */
    alwaysRemote: 'always-remote',
};

/** 转发方法名（挂在联动通道上）。 */
export const RELAY_METHOD = 'llm.relay';

/**
 * 服务方在握手里**宣告**的方法名。
 *
 * 为什么单独列：`methods` 列表是给对端做能力发现的（peerMethods）。转发能力
 * 是**可选**的（桌面得有 llm 服务），所以要能让对端看见"这台机器能代为执行模型
 * 调用"，而不是让手机盲发过去撞 404。
 */
export const RELAY_ADVERTISED = RELAY_METHOD;

/**
 * 转发请求的载荷。
 *
 * 形状是实测出来的（真实 dsh 上跑探针确认），不是猜的：
 *   { provider: "deepseek-account", model: "deepseek-chat",
 *     messages: [{ role: "user", content: "…" }] }
 *
 * 关键：`options` 只有这三个字段，**纯 JSON**，所以可以原样跨链路转发，
 * 接收端喂给自己的 `llm.stream()` 即可，无需反序列化任何内部结构。
 *
 * 但要注意：真实调用里 options 可能带更多字段（tools、system、信号…）。
 * 所以这里转发**整个 options**，不做字段裁剪 —— 裁剪会在插件注入自定义字段时
 * 静默丢东西，而那正是「插件注入的 API 也要走转发」这条要求要覆盖的场景。
 */
export const RELAY_REQUEST_KEYS = ['provider', 'model', 'messages'];

/** 转发时用到的虚拟 provider 名。它会出现在模型选择器里。 */
export const REMOTE_PROVIDER = 'llm-remote';

/**
 * 虚拟 provider 的展示名。
 * 刻意写得显眼：用户看到「经电脑调用」就知道请求会离开本机，而不是以为在本地跑。
 */
export const REMOTE_PROVIDER_LABEL = '经另一台设备调用';

/** 单次请求的分块转发用的分片 ID 前缀（诊断用）。 */
export const RELAY_TRACE_PREFIX = 'llm-relay';

/**
 * 把请求转发到对端，并把对端产生的 chunk 逐块交回本地消费方。
 *
 * waterfall 的监听器必须返回 AsyncIterable<StreamChunk>，所以这里把
 * 回调式的 call-stream 包成一个异步生成器。
 *
 * ⚠️ 队列不能丢：对端是「边算边发」，本地在 await 生成器时才拉取。若只留最后一个
 *    值，用户看到的就是「等半天整段蹦出来」—— 那正是要避免的。
 *
 * ── 为什么是共享的（两端都用同一份）────────────────────────────────────────
 * 这个函数只用到 conn 的 `callStream` / `closed`，**与设备角色无关**：
 * 手机→电脑、电脑→手机、电脑→电脑、手机→手机（经中转）都是同一套机制。
 * 它曾只写在手机侧，桌面侧要反向转发时就得复制一份 —— 而复制出来的两份迟早
 * 会走样（比如一边改了取消语义、另一边没有）。
 *
 * @param {object} conn - 已配对的连接。
 * @param {object} options - 原始 GenerateOptions（原样转发，不裁剪字段）。
 * @param {string} [label] - 诊断标签，用于日志里区分是谁发起的转发。
 * @returns {AsyncGenerator<object>} 对端的 chunk。
 */
export async function* relayStream(conn, options, label = 'peer') {
    /** @type {object[]} 等待消费的 chunk。 */
    const queue = [];
    let done = false;
    let failure = null;
    let wake = null;
    const push = (chunk) => { queue.push(chunk); wake?.(); wake = null; };
    const finish = (error) => { if (error) failure = error; done = true; wake?.(); wake = null; };

    // 对端结束或失败时，结束整个生成器。
    const settled = conn.callStream(RELAY_METHOD, options, push).then(
        () => finish(null),
        (error) => finish(error),
    );

    try {
        for (;;) {
            while (queue.length > 0) yield queue.shift();
            if (done) break;
            await new Promise((resolve) => { wake = resolve; });
        }
        while (queue.length > 0) yield queue.shift();
        if (failure) throw failure;
    } finally {
        // 本地消费方提前退出（用户取消 / 会话中断）时结束这次转发。
        // settled 只是用来兜住「对端还没结束就走了」的 rejection，
        // 不 await —— await 它会把取消也变成等待。
        settled.catch(() => {});
    }
}
