import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

/**
 * 纯 JS 解包（tar / tar.gz）—— 零外部依赖、零外部进程。
 *
 * 为什么需要它：Windows 7 **没有** %SystemRoot%\System32\tar.exe
 * （微软从 Win10 1803 才随系统内置 bsdtar）。任何直接 spawn 系统 tar 的路径
 * 在 Win7 上都会以「无法调用系统 tar」收场 —— 热更新、运行时补丁、运行时安装全部失效。
 *
 * 支持范围：普通文件、目录、GNU 长名（typeflag 'L'）、PAX 扩展头（'x' / 'g'）。
 * 我们自家的打包器（bsdtar / GNU tar）只会产出这几类。
 */

/** gzip 魔数：1f 8b */
function isGzip(buf: Buffer): boolean {
  return buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/** 系统 tar 是否可用（Win7 上恒为 false）。 */
export function hasSystemTar(): boolean {
  if (process.platform !== 'win32') return true; // 交给 PATH 解析
  try {
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    return fs.existsSync(exe);
  } catch {
    return false;
  }
}

/**
 * 纯 JS 解包（tar / tar.gz）：不 spawn 任何外部进程。
 *
 * Win7 没有 %SystemRoot%\\System32\\tar.exe（Win10 1803 才内置），
 * 所以这里是**主路径**而不是兜底，任何解包都不该硬依赖系统 tar。
 *
 * 为什么不用系统 tar.exe：它可能被安全软件/环境拦截后**既不退出也不报错**
 * （实测会把下载进度卡死在 99%）。tar 格式本身很简单，512 字节头 + 数据块，
 * 我们只需要支持自家打包器（bsdtar）产出的：普通文件、目录、GNU 长名（L）、PAX 扩展头（x）。
 */
export function extractTarPure(tarFile: string, destDir: string): Promise<void> {
  return Promise.resolve().then(() => {
    const raw = fs.readFileSync(tarFile);
    const tarBuf = isGzip(raw) ? zlib.gunzipSync(raw) : raw;

    fs.mkdirSync(destDir, { recursive: true });
    let offset = 0;
    let pendingName: string | null = null;

    const readStr = (buf: Buffer, off: number, len: number): string => {
      const raw = buf.subarray(off, off + len);
      const end = raw.indexOf(0);
      return (end === -1 ? raw : raw.subarray(0, end)).toString('utf8');
    };

    while (offset + 512 <= tarBuf.length) {
      const header = tarBuf.subarray(offset, offset + 512);
      if (header.every((b) => b === 0)) break; // 结束块

      const nameField = readStr(header, 0, 100);
      const prefix = readStr(header, 345, 155).trim();
      const sizeStr = readStr(header, 124, 12).replace(/[^0-7]/g, '');
      const size = parseInt(sizeStr || '0', 8) || 0;
      const type = String.fromCharCode(header[156] || 48);
      offset += 512;

      const data = tarBuf.subarray(offset, offset + size);
      offset += Math.ceil(size / 512) * 512;

      if (type === 'L') {
        pendingName = readStr(data, 0, size).replace(/\0[\s\S]*$/, '');
        continue;
      }
      if (type === 'x') {
        // PAX 扩展头：形如 "52 path=updater/lib/x.js\n"，作用于下一个条目
        const text = data.toString('utf8');
        const m = text.match(/(?:^|\n)\d+ path=([^\n]+)/);
        pendingName = m ? m[1] : pendingName;
        continue;
      }
      if (type === 'g') continue; // 全局扩展头，忽略

      let name = pendingName ?? (prefix ? `${prefix}/${nameField}` : nameField);
      pendingName = null;
      name = name.replace(/^\.\//, '');
      if (!name || name.includes('..') || path.isAbsolute(name)) continue;

      const dest = path.join(destDir, ...name.split('/'));
      if (type === '5') {
        fs.mkdirSync(dest, { recursive: true });
        continue;
      }
      if (type === '0' || type === '\0') {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, data.subarray(0, size));
      }
      // 其它类型（链接等）我们的包里没有，忽略
    }
  });
}

/**
 * 用系统 bsdtar 解包 —— 仅作为纯 JS 解包失败后的最后兜底（Win7 上没有）。
 *
 * @param gzip 传 true 时给 tar 加 z；bsdtar 本可自动识别，显式传只为兼容 GNU tar。
 * @param timeoutMs 大于 0 时限时（系统 tar 被安全软件拦截后可能既不退出也不报错）
 */
export function extractWithSystemTar(
  tarFile: string,
  destDir: string,
  gzip = false,
  timeoutMs = 0,
): Promise<void> {
  const tarExe =
    process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';

  return new Promise<void>((resolve, reject) => {
    const child = spawn(tarExe, [gzip ? '-xzf' : '-xf', tarFile, '-C', destDir], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });

    let timer: NodeJS.Timeout | null = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        reject(new Error('系统 tar 解包超时（' + Math.round(timeoutMs / 1000) + 's）'));
      }, timeoutMs);
    }

    child.once('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('tar 退出码 ' + code + '：' + stderr.slice(-300)));
    });
  });
}
