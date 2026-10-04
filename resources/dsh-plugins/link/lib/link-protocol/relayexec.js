/**
 * 远程凭据转发 —— 桌面侧执行端。
 *
 * ── 它做什么 ────────────────────────────────────────────────────────────────
 * 对端（手机）把**请求内容**发过来，本机用**自己的凭据**执行，把流式结果逐块回传。
 * 凭据自始至终不离开本机。
 *
 * ── 为什么能覆盖「插件注入的 API」 ──────────────────────────────────────────
 * 执行端不认 provider 名字，只调本机 `llm.stream(options)`。而 llm.stream 会走
 * adapter 解析 —— 那个 provider 来自内置插件（dsh-llm-deepseek-account /
 * -api-key）还是第三方自建（Qoder、workbuddy、任何调过 llm.registerAdapter 的），
 * 对这条路径**没有区别**。所以"插件注入的 API"自动被覆盖，不需要逐个适配。
 *
 * ── ⚠️ 关于「加密」的诚实说明 ────────────────────────────────────────────────
 * 凭据（API Key / 登录 token）**不在这条链路上**，所以不存在"凭据被窃取"的问题 ——
 * 它们根本不会被发送。
 *
 * 会被发送的是**请求内容**（prompt，含对话历史）。我核对过协议实现：
 * `call-stream` 的 args 是**明文 JSON 帧**。通道有配对码 + 长期令牌做门禁，
 * 但**帧内容没有额外加密**。
 *
 * 也就是说：能接入这条链路的人（已配对设备）能看到你转发的对话内容。因此本功能
 *   1. **默认关闭**，必须显式开启；
 *   2. 界面**明说**「对话内容会发到另一台设备执行」；
 *   3. 每次转发都记日志，可事后查。
 *
 * 若要防「局域网被动嗅探」，正确的位置是**隧道层**（EasyTier 的
 * `--no-tun` + `--secure-mode`）—— 那是端到端的，位置比这里更对。
 */

/**
 * 把请求交给本机 llm runtime 执行，并把流逐块推出。
 *
 * @param {object} ctx - Cordis 上下文（需注入 llm）。
 * @param {(chunk: any) => void} emit - 推出一块 StreamChunk。
 * @param {object} options - GenerateOptions，原样透传。
 * @param {{signal: AbortSignal}} meta - 中止信号。
 * @returns {Promise<{chunks: number, finish: any}>} 执行摘要。
 */
export async function executeLocally(ctx, emit, options, meta) {
    // ⚠️ 不复制、不改写 options：官方注释说 LOOP 构造的请求是 deep-frozen 的
    //    （改写会抛），且其内容是会话日志的纯函数。直接交给 llm.stream。
    let chunks = 0;
    let finish = null;
    for await (const chunk of ctx.llm.stream(options)) {
        if (meta?.signal?.aborted) break;
        chunks += 1;
        if (chunk?.type === 'finish') finish = chunk;
        // StreamChunk 是可判别联合的纯 JSON，直接透传 —— 手机端原样喂回
        // 自己的 llm.stream 消费方即可，不做任何重写。
        emit(chunk);
    }
    // 终态 error/aborted 要变成抛错，这样对端拿到的是带 code 的失败，
    // 而不是"看起来成功但内容是空的"。
    if (finish?.reason?.kind === 'error') {
        const failure = finish.reason.failure;
        const err = new Error(failure?.message ?? '远端模型调用失败');
        if (failure?.code) err.code = failure.code;
        throw err;
    }
    if (finish?.reason?.kind === 'aborted') {
        const err = new Error('远端模型调用被中止');
        err.code = 'ABORTED';
        throw err;
    }
    return { chunks, finish: finish ?? null };
}
