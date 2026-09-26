import * as net from 'net';

/** 端口是否空闲（可被监听） */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

/**
 * 在给定端口中挑一个可用的：优先首选端口，被占用则回退到系统分配（0）。
 * 说明：dsh 的 `--port 0` 会由操作系统分配空闲端口，因此不存在“端口冲突失败”的情况。
 */
export async function pickPort(preferred: number): Promise<{ port: number; fallback: boolean }> {
  if (await isPortFree(preferred)) return { port: preferred, fallback: false };
  return { port: 0, fallback: true };
}

/**
 * TCP connect 轮询，确认端口已经可以接受连接。
 * 不使用固定 sleep：命中即返回，超时才失败。
 */
export function waitForPort(
  port: number,
  opts: { timeoutMs?: number; intervalMs?: number; host?: string } = {},
): Promise<boolean> {
  const { timeoutMs = 15000, intervalMs = 250, host = '127.0.0.1' } = opts;
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve) => {
    const attempt = (): void => {
      const socket = net.connect({ port, host });
      let settled = false;

      const done = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (ok) resolve(true);
        else if (Date.now() >= deadline) resolve(false);
        else setTimeout(attempt, intervalMs);
      };

      socket.setTimeout(1500);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
    };
    attempt();
  });
}
