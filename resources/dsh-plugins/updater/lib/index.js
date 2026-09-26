/**
 * DSH Desktop 更新面板 —— 宿主侧（Node）入口。
 *
 * 这一侧几乎什么都不做：版本信息和更新动作由桌面外壳通过 preload 暴露给页面
 * （`window.dshDesktop.getVersions / checkUpdate / restart`），
 * 客户端模块（`./client`）直接调用它们即可，不需要在 Harness 里挂 HTTP 路由。
 *
 * 保留这个入口只是因为 dsh 的插件协议要求：包要能被 cordis 加载（`name` + `apply`），
 * 才能进入 profile 的组合栈，进而让 `dsh.bundle.patch` 与客户端模块生效。
 */
export const name = 'dsh-desktop-updater';

/**
 * @param ctx 宿主上下文（本插件不消费任何服务）
 * @param config 可选的配置覆盖（暂未使用）
 */
export function apply(_ctx, _config) {
  // 故意留空：见文件头说明。
}
