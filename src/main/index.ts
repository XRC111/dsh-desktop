/**
 * 入口引导器（bootstrap）——只做一件事：决定这次启动加载哪一份「壳代码」。
 *
 *   - 用户数据目录下存在可用的热更新壳 → 加载它（热更新立刻生效，只需重启进程）
 *   - 否则加载内置壳 ./boot.js（app.asar 里的代码）
 *
 * 为什么这样能实现「不跑安装包的热更新」：
 *   外壳的全部代码就是 app.asar 里的 out/（main + preload + renderer），
 *   而 preload 与渲染页的路径都是相对 __dirname 解析的（见 window-manager.ts），
 *   所以把一份完整的新壳放进可写的用户数据目录、让入口优先加载它，
 *   就等价于换了整个外壳 —— 不需要管理员权限，也不碰安装目录里被占用的文件。
 *
 * 稳健性：
 *   - 热壳只在 baseVersion 与当前安装版一致时才加载（跨大版本结构不兼容 → 走安装包）
 *   - 每次加载热壳都登记一次「启动尝试」，进程活过 4 秒才认为成功；
 *     连续两次失败会自动把该热壳改名禁用并回退内置壳（不会把应用搞坏）
 *   - 热更新只换代码；dsh 运行时（3.5 万文件）不受影响，所以重启后几秒即可用
 */

// ELECTRON_RUN_AS_NODE 是在「进程启动那一刻」由 Electron 二进制读取的：
// 若外部环境已设置它，本进程会以纯 Node 模式运行（app / BrowserWindow 全部不可用）。
// 此处删除无法逆转已发生的启动模式，作用是别让它再传给子进程树。
// 注意启动方式：别在设置了该变量的终端里直接启动应用（见 README）。
delete process.env.ELECTRON_RUN_AS_NODE;

import { log } from './logger';
import {
  cleanupOldShells,
  markShellHealthy,
  noteBootAttempt,
  resolveHotShell,
  setLoadedHotShell,
} from './hot-shell';

const hot = resolveHotShell();
setLoadedHotShell(hot);

if (hot) {
  noteBootAttempt(hot);
  log(`使用热更新壳 ${hot.version}（基于安装版 ${hot.baseVersion}）：${hot.dir}`);
  try {
    require(hot.entry);
  } catch (err) {
    log(`热更新壳加载失败，回退内置壳：${String((err as Error)?.stack ?? err)}`);
    setLoadedHotShell(null);
    require('./boot.js');
  }
  // 活过 4 秒即认为这套壳可用；否则下次启动累加尝试计数，两次后自动禁用
  const t = setTimeout(() => markShellHealthy(), 4000);
  t.unref?.();
} else {
  log('使用内置壳');
  require('./boot.js');
}

// 清理临时目录与过老的热壳（保留最近 2 个，便于回退）
setTimeout(() => {
  try {
    cleanupOldShells(2);
  } catch (err) {
    log(`清理旧热壳失败：${String(err)}`);
  }
}, 8000).unref?.();
