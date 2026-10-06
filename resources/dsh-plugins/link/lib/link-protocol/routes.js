/**
 * 远程联动 —— 供 GUI 调用的 HTTP 路由（两端共用）。
 *
 * ── 为什么要开 HTTP 路由 ────────────────────────────────────────────────────
 * 手机上填 host/端口/配对码、桌面上点「起服务 / 看配对码 / 断开」，这些都应该在
 * 界面里完成，而不是每次都让用户跟模型说话。但 dsh 的插件工具（ctx.tools）是
 * **给模型用的**，客户端页面调不到它们。
 *
 * dsh 为此留了正式接缝：`ctx.connection.fetch.register({ path, methods, requestBody, fetch })`
 * ——它就是 `/api/session/uploadFileBinary` 这类内建路由用的同一套机制（已核对
 * `@deepseek-ai/dsh-client-file-upload` 的用法）。所以这里不发明新协议，走同一条路。
 *
 * ── 路径约定 ────────────────────────────────────────────────────────────────
 * 内建路由都在 `/api/...` 下，客户端用相对路径 `api/...` 调。这里沿用：
 *   GET  /api/dsh-link/status   两端状态
 *   POST /api/dsh-link/start    桌面：起服务
 *   POST /api/dsh-link/stop     桌面：停服务
 *   POST /api/dsh-link/code     桌面：重发配对码
 *   POST /api/dsh-link/connect  手机：用 host/port/code 连桌面
 *
 * ── 安全 ────────────────────────────────────────────────────────────────────
 * 这些路由挂在**已鉴权的 Connection** 上（和上传路由同级），也就是只有持有本机
 * web token 的客户端能调 —— 界面自己。不要在这里再做一套鉴权，也别把
 * `/link/start` 暴露到未鉴权的路径上：它会让局域网里任何人拿到配对码。
 */

/** 路由前缀。两端必须一致，客户端页面按它拼 URL。 */
export const ROUTE_PREFIX = '/api/dsh-link';

/**
 * 一个 JSON 应答。
 * @param {any} value - 载荷。
 * @param {number} [status] - HTTP 状态。
 * @returns {Response} 响应。
 */
function json(value, status = 200) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
    });
}

/**
 * 把一个操作包成路由处理器：解析 JSON body、捕获异常转成 400/500。
 *
 * 为什么不让它直接抛：抛出去会变成网关的通用错误页，界面只能显示「出错了」。
 * 这里统一成 `{ ok:false, error }`，界面就能把「配对码不对」这类信息原样显示。
 *
 * @param {(body: object) => Promise<any>} fn - 实际操作。
 * @returns {(request: Request) => Promise<Response>} 路由处理器。
 */
export function handler(fn) {
    return async (request) => {
        let body = {};
        try {
            const text = await request.text();
            body = text ? JSON.parse(text) : {};
        } catch {
            return json({ ok: false, error: '请求体不是合法 JSON' }, 400);
        }
        try {
            return json({ ok: true, value: await fn(body) });
        } catch (error) {
            return json({ ok: false, error: String(error?.message ?? error) }, 400);
        }
    };
}

/**
 * 把一组路由注册到 Connection 的 fetch 注册表。
 *
 * @param {object} ctx - Cordis 上下文（需已注入 connection）。
 * @param {object} spec - { status, start?, stop?, code?, connect? }，值为 async 函数。
 * @returns {void}
 */
export function registerRoutes(ctx, spec) {
    // 没有 connection（或它没有 fetch 注册表）时**不要**抛错：联动本身仍然可用
    // （手机能连、工具能调），只是界面拿不到状态。让 GUI 缺失比让插件加载失败好。
    // ⚠️ 但仍然必须把 'connection' 写进 inject —— 否则访问 ctx.connection 会直接
    //    抛 "cannot get property \"connection\" without inject"（实测踩过）。
    if (!ctx.connection?.fetch?.register) {
        ctx.logger?.warn?.('[link] connection.fetch 不可用，GUI 路由未注册（功能不受影响）');
        return;
    }
    const routes = [
        ['/status', 'GET', spec.status],
        ['/start', 'POST', spec.start],
        ['/stop', 'POST', spec.stop],
        ['/code', 'POST', spec.code],
        ['/connect', 'POST', spec.connect],
        // 远程凭据转发的开关（仅手机侧提供）。
        ['/llm-relay', 'POST', spec.llmRelay],
        // mesh：已配对设备清单与拓扑切换（仅手机侧提供）。
        ['/devices', 'GET', spec.devices],
        ['/topology', 'POST', spec.topology],
    ];
    for (const [suffix, method, fn] of routes) {
        if (typeof fn !== 'function') continue;
        ctx.effect(
            () => ctx.connection.fetch.register({
                path: ROUTE_PREFIX + suffix,
                methods: [method],
                // ⚠️ 取值只有 'buffered' | 'streaming'（已核对 api-catalog 的
                //    ConnectionRequestBodyMode）。我第一版凭直觉写成 'text'/'none'，
                //    运行时会被无声忽略或报错。
                requestBody: 'buffered',
                fetch: handler(fn),
            }),
            'dsh-link: ' + method + ' ' + ROUTE_PREFIX + suffix,
        );
    }
}
