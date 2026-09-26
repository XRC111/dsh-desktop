import { spawn, spawnSync, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { DshInstall } from './dsh-locator';
import { log, logDshChunk } from './logger';
import { waitForPort } from './port';

export type DshState = 'idle' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';

export interface DshStatus {
  state: DshState;
  /** dsh 就绪后的完整地址（含 token），渲染进程必须用它加载 UI */
  url?: string;
  port?: number;
  pid?: number;
  version?: string;
  /** 首选端口被占用而回退到系统分配端口 */
  portFallback?: boolean;
  message?: string;
  problems?: string[];
  hints?: string[];
}

/** 去掉 ANSI 颜色码，避免 token 正则被转义序列打断 */
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/** dsh 启动后打印的一行：dsh web: http://127.0.0.1:<port>/?token=<token> */
const URL_RE = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)\/[^\s]*\?token=[A-Za-z0-9._\-]+/;

export interface StartOptions {
  install: DshInstall;
  /** 首选端口，被占用则自动回退 */
  preferredPort: number;
  /** 回退时实际使用的端口（0 = 由系统分配） */
  listenPort: number;
  portFallback: boolean;
  dshHome: string;
  /** 桌面适配补丁（不存在则退回原生 web profile） */
  patchFile?: string;
  /** 就绪等待上限 */
  readyTimeoutMs?: number;
  version?: string;
}

export class DshService extends EventEmitter {
  private child: ChildProcess | null = null;
  private status: DshStatus = { state: 'idle' };
  private lineBuffer = '';
  private stopping = false;

  getStatus(): DshStatus {
    return { ...this.status };
  }

  private setStatus(patch: Partial<DshStatus>): void {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.getStatus());
  }

  /**
   * 启动 dsh web。
   *
   * 关键实现：用 Electron 内置 Node 以纯 Node 模式运行 dsh 的入口脚本，
   * 不额外分发 node.exe。runAsNode fuse 必须保持启用（默认即启用）。
   */
  async start(opts: StartOptions): Promise<DshStatus> {
    if (this.child) return this.getStatus();

    this.stopping = false;
    this.setStatus({
      state: 'starting',
      version: opts.version,
      portFallback: opts.portFallback,
      message: opts.portFallback
        ? `端口 ${opts.preferredPort} 被占用，已改用系统分配的空闲端口`
        : '正在启动 DeepSeek Harness…',
      problems: undefined,
      hints: undefined,
    });

    // 启动参数分层（实测确认）：
    //   `web` 是 `--profile web` 的别名，但**子命令形式不接受父级参数**
    //   （会报 "web takes none of parent --profile, --patch, ..."）。
    //   因此一旦要叠加 --patch，就必须改用 `--profile web --patch <file>` 的写法，
    //   app 自身的参数（--no-open / --port）仍然跟在后面。
    const usePatch = !!opts.patchFile && fs.existsSync(opts.patchFile);
    const args = [
      // web profile 会加载 @deepseek-ai/cordis-plugin-hmr（live reload 会动态插入该行），
      // 它要求 Node 暴露内部模块，否则启动即报
      // "--expose-internals is required for HMR service" 并退出。
      // 该 flag 必须位于脚本路径之前，Electron 以 RUN_AS_NODE 模式运行时同样接受。
      '--expose-internals',
      opts.install.entry,
      ...(usePatch
        ? ['--profile', 'web', '--patch', opts.patchFile as string]
        : ['web']),
      '--no-open', // 禁止 dsh 拉起系统浏览器，UI 由本窗口承载
      '--port',
      String(opts.listenPort),
    ];
    if (usePatch) log(`应用桌面适配补丁：${opts.patchFile}`);

    log(`spawn: ${process.execPath} ${args.join(' ')}`);
    log(`cwd: ${opts.install.runtimeDir}`);
    log(`DSH_HOME: ${opts.dshHome}`);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1', // 让 Electron 二进制以纯 Node 运行，不启动 Chromium
      DSH_HOME: opts.dshHome,
      NO_COLOR: '1',
    };
    delete env.ELECTRON_NO_ATTACH_CONSOLE;

      const child = spawn(process.execPath, args, {
        cwd: opts.install.runtimeDir, // 保证 dsh 能在运行时目录内正确解析模块
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // 关键：**不要** windowsHide。dsh 需要继承外壳准备好的隐藏控制台，
        // 这样它在 Windows 沙箱（受限令牌）下起的 shell 子进程会共享该控制台，
        // 而不是让系统新建一个可见窗口。详见 src/main/win-console.ts。
        windowsHide: false,
      });

    this.child = child;
    this.setStatus({ state: 'starting', pid: child.pid });

    const urlReady = this.watchForReadyUrl(opts.readyTimeoutMs ?? 90000);

    child.stdout?.on('data', (chunk: Buffer) => {
      logDshChunk(chunk);
      this.consume(chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      logDshChunk(chunk);
      this.consume(chunk.toString('utf8'));
    });

    child.once('error', (err) => {
      log(`dsh 子进程错误：${err.message}`);
      this.child = null;
      this.setStatus({
        state: 'failed',
        message: `无法启动 DeepSeek Harness：${err.message}`,
        hints: ['请确认安装目录完整；若杀毒软件拦截了进程创建，请将其加入白名单。'],
      });
    });

    child.once('exit', (code, signal) => {
      const expected = this.stopping;
      this.child = null;
      log(`dsh 子进程退出 code=${code} signal=${signal} expected=${expected}`);
      if (expected) {
        this.setStatus({ state: 'stopped', message: '服务已停止' });
        return;
      }
      this.setStatus({
        state: 'failed',
        message: `DeepSeek Harness 意外退出（退出码 ${code ?? '未知'}）`,
        hints: [
          '可能是端口被占用、依赖损坏或被安全软件拦截。',
          `请查看日志：${path.join('logs', 'dsh-web.log')}`,
        ],
      });
    });

    const url = await urlReady;
    if (!url) {
      // 没能从输出里拿到地址：给出可读错误
      if (this.status.state === 'starting') {
        this.setStatus({
          state: 'failed',
          message: 'DeepSeek Harness 启动超时，未能获取 Web UI 地址。',
          hints: [
            `请查看日志排除原因：logs/dsh-web.log`,
            '若首次运行需要初始化配置，请稍后点击“重试”。',
          ],
        });
      }
      return this.getStatus();
    }

    // 双保险：拿到 URL 后再确认端口真的可连接（避免 UI 加载竞态）
    const port = Number(new RegExp(URL_RE).exec(url)![1]);
    const reachable = await waitForPort(port, { timeoutMs: 15000 });
    if (!reachable) {
      this.setStatus({
        state: 'failed',
        message: `Web UI 端口 ${port} 无法连接。`,
        hints: ['端口可能被安全软件拦截，或 dsh 初始化失败，请查看日志。'],
      });
      return this.getStatus();
    }

    this.setStatus({ state: 'ready', url, port, message: '就绪' });
    return this.getStatus();
  }

  /** 从输出流里解析就绪 URL；采用有界缓冲，避免内存累积 */
  private watchForReadyUrl(timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.off('raw', onRaw);
        resolve(v);
      };
      const onRaw = (text: string): void => {
        const m = URL_RE.exec(text.replace(ANSI_RE, ''));
        if (m) finish(m[0]);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      this.on('raw', onRaw);
      // 若 URL 在监听器注册前已经出现，补一次检查
      onRaw(this.lineBuffer);
    });
  }

  private consume(text: string): void {
    this.emit('raw', text);
    // 有界缓冲：只保留最后 8KB，用于跨 chunk 的行拼接
    this.lineBuffer = (this.lineBuffer + text).slice(-8192);
  }

  /** 优雅停止：Windows 上必须回收整棵进程树 */
  async stop(timeoutMs = 8000): Promise<void> {
    const child = this.child;
    if (!child || child.pid == null) {
      this.setStatus({ state: 'stopped', message: '服务未在运行' });
      return;
    }
    this.stopping = true;
    this.setStatus({ state: 'stopping', message: '正在停止 DeepSeek Harness…' });

    const pid = child.pid;
    const exited = new Promise<void>((resolve) => {
      const t = setTimeout(() => resolve(), timeoutMs);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });

    killTree(pid);
    await exited;
    this.child = null;
    this.setStatus({ state: 'stopped', message: '服务已停止' });
  }

  /** 同步强杀，用于 app 退出前的最后兜底 */
  killTreeSync(): void {
    const pid = this.child?.pid;
    if (pid == null) return;
    killTreeSync(pid);
    this.child = null;
  }
}

/**
 * 清理 dsh 上次异常退出（进程被强杀）遗留的写锁。
 *
 * dsh 用 <DSH_HOME>/profiles/*.lock 做 profile 写入互斥，锁文件里存的是持有者的 PID。
 * 如果 dsh 是被 taskkill /F 强杀的，锁文件不会被清理，下次启动会一直等到
 * 「atomic-write: timed out waiting for the writer lock」然后启动失败。
 * 这里在启动前判断 PID 是否还活着，只删除确认已失效的锁。
 */
export function healStaleLocks(dshHome: string): number {
  const profilesDir = path.join(dshHome, 'profiles');
  if (!fs.existsSync(profilesDir)) return 0;

  let cleaned = 0;
  for (const name of fs.readdirSync(profilesDir)) {
    if (!name.endsWith('.lock')) continue;
    const file = path.join(profilesDir, name);
    let pid = Number.NaN;
    try {
      pid = Number(fs.readFileSync(file, 'utf8').trim());
    } catch {
      /* 读不到内容则按陈旧锁处理 */
    }
    if (Number.isFinite(pid) && pid > 0 && isProcessAlive(pid)) continue; // 仍被占用
    try {
      fs.unlinkSync(file);
      cleaned++;
      log(`清理陈旧锁：${file}（持有者 PID ${Number.isFinite(pid) ? pid : '未知'} 已不存在）`);
    } catch {
      /* 删除失败则跳过，由 dsh 自己处理超时 */
    }
  }
  return cleaned;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM = 进程存在但无权限；ESRCH = 进程不存在
    return err?.code === 'EPERM';
  }
}

/**
 * 回收进程树。
 * Windows 上 ChildProcess.kill() 只结束直接子进程，dsh 派生出的
 * bash/pwsh 沙箱子进程会残留，因此必须用 taskkill /T /F。
 */
export function killTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      const p = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      p.once('error', () => {
        /* 进程可能已退出 */
      });
    } catch {
      /* ignore */
    }
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }
}

export function killTreeSync(pid: number): void {
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } catch {
      /* ignore */
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
  }
}
