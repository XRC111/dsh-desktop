/**
 * 「技能与 MCP」管理面板 —— 宿主侧入口。
 *
 * 这个插件**没有宿主侧逻辑**：读写全部由外壳的 preload 桥（window.dshDesktop.*）
 * 直接调主进程的 skill-mcp.ts 完成，不需要经过 dsh 子进程。
 *
 * 但 dsh 的补丁层要求每个 insert 条目都指向一个**能加载的模块**，所以这里放一个
 * 空壳：不 inject 任何服务、不注册任何工具，apply 里什么都不做。
 *
 * 为什么不让宿主侧也做点事：技能目录与 mcp-servers.json 都在外壳可访问的文件系统上，
 * 走 dsh 反而要多一层 IPC 转发；而 MCP 配置最终是要写进**补丁层**的，
 * 那本来就是外壳的职责（patch-guard 在启动时生成 effective patch）。
 */
export const name = 'skill-mcp';

/** 不依赖任何服务 —— 空壳，缺什么都能加载。 */
export const inject = [];

/** 无宿主侧行为。 */
export function apply() {
  /* 面板完全由 client/client.js + 外壳 preload 桥实现 */
}
