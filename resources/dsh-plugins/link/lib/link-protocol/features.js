/**
 * 实验性功能开关 —— **默认全部关闭**。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * 这些功能已经写完并且真机验证通过了，但**还不打算让普通用户用到**：
 *   · 跨端模型转发 / 共享模型列表（llm.relay + llm.list）
 *   · 双向转发与流式中转（relay.call / relay.stream）
 *   · 异地组网（EasyTier）
 *
 * 原因是它们**还太新**：这一轮里它们暴露过 ctx 未定义、漏导入、能力宣告
 * 不对称、adapter 缺基类方法、跨分组重复、递归转发…每一类都是「功能完全
 * 不生效或整插件挂掉」级别的问题，而且多数要真机才暴露。直接放出去等于
 * 让用户当测试者。
 *
 * ── 为什么开关放在协议层 ────────────────────────────────────────────────────
 * 两端（手机 / 桌面）各有一份插件代码，而这类开关**最容易只改一边** ——
 * 上一轮就因为漏改桌面侧的同名函数导致递归转发。所以只有一个来源，
 * 两端都从这里读。
 *
 * ── 怎么开 ──────────────────────────────────────────────────────────────────
 * 改这里的常量为 true 并重新发版。**不要**加「按用户灰度」之类的逻辑：
 * 现在没有那个需求，而开关本身越简单越不容易出错。
 */

/** 跨端模型转发与共享模型列表（llm.relay / llm.list）。 */
export const RELAY_ENABLED = false;

/** 中转能力（relay.call / relay.stream）—— mesh 里设备间转发的基础。 */
export const TRANSIT_ENABLED = false;

/** 异地组网（内嵌 EasyTier）。 */
export const EASYTIER_ENABLED = false;

/**
 * 汇总快照。
 *
 * 用途：界面与工具据此**如实说明**「本机没开这个功能」，而不是让用户面对
 * 一个不存在的选项却找不到原因。
 *
 * @param {object} ctx Cordis 上下文（用来读用户配置里的覆盖值）。
 * @returns {{relay: boolean, transit: boolean, easytier: boolean, anyEnabled: boolean}}
 */
export function featureFlags(ctx) {
    const o = readOverrides(ctx);
    const relay = o.relay ?? RELAY_ENABLED;
    const transit = o.transit ?? TRANSIT_ENABLED;
    const easytier = o.easytier ?? EASYTIER_ENABLED;
    return { relay, transit, easytier, anyEnabled: relay || transit || easytier };
}

/**
 * 从用户配置读覆盖值。
 *
 * 之所以留这个口子：调试时能在不重新发版的情况下打开（改
 * `profiles/web/cordis.patch.yml`）。**读不到就用默认的 false** ——
 * 配置出错时必须是「关」，不能是「开」。
 *
 * 形如：
 *   - id: dsh-link-features
 *     name: "@dsh-android/link"
 *     config:
 *       features: { relay: true }
 */
function readOverrides(ctx) {
    try {
        // ⚠️ 配置形状是 `config.features: { relay: true }`（见上面的 yaml 示例）。
        //    早先这里取的是 `ctx.get('link')?.config` 后**直接**读 `.relay`，
        //    少了一层 features —— 于是按文档写配置的人怎么改都不生效，而
        //    开关又默认全关，症状就是「配了跟没配一样」，极难自查。
        //    这里两种形状都认：优先 features 子对象，再退回扁平写法。
        const config = ctx?.get?.('link')?.config;
        const cfg = (config && typeof config === 'object' && config.features && typeof config.features === 'object')
            ? config.features
            : (config && typeof config === 'object' ? config : ctx?.cfg?.features);
        if (cfg && typeof cfg === 'object') {
            return {
                relay: cfg.relay === true,
                transit: cfg.transit === true,
                easytier: cfg.easytier === true,
            };
        }
    } catch { /* 配置读不到就用默认 */ }
    return {};
}