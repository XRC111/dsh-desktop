/**
 * DSH Desktop 桌面适配面板 —— 宿主侧（Node）入口。
 *
 * 这一侧不做事：所有开关都由桌面外壳通过 preload 暴露给页面
 * （window.dshDesktop.getFeatures / setFeature），客户端模块直接调用它们。
 *
 * 保留入口只是因为 dsh 插件协议要求包能被 cordis 加载（name + apply），
 * 才能进入 profile 组合栈，进而让 dsh.bundle.patch 与客户端模块生效。
 */
export const name = 'dsh-desktop-shell';

/**
 * @param ctx 宿主上下文（本插件不消费任何服务）
 * @param config 可选的配置覆盖（暂未使用）
 */
export function apply(_ctx, _config) {
  // 故意留空：见文件头说明。
}
