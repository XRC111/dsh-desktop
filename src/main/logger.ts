import * as fs from 'fs';
import * as path from 'path';

const MAX_BYTES = 10 * 1024 * 1024; // 单文件 10 MB
const KEEP_FILES = 3; // 轮转保留 app.log.1 ~ app.log.3

/**
 * 追加式文件日志。
 *
 * 设计要点（对应性能要求）：
 *  - 写入是同步 append，但只写单行，不缓冲整段输出；
 *  - 超过 10 MB 自动轮转，避免单文件无限增长；
 *  - stdout/stderr 由调用方按 chunk 流式喂入，不在内存里累积。
 */
export class FileLogger {
  private size = 0;

  constructor(private readonly file: string) {
    try {
      this.size = fs.statSync(file).size;
    } catch {
      this.size = 0;
    }
  }

  get filePath(): string {
    return this.file;
  }

  write(line: string): void {
    const text = line.endsWith('\n') ? line : line + '\n';
    const buf = Buffer.from(text, 'utf8');
    try {
      fs.appendFileSync(this.file, buf);
      this.size += buf.length;
      if (this.size > MAX_BYTES) this.rotate();
    } catch {
      /* 磁盘满 / 文件被占用时静默降级，不影响主流程 */
    }
  }

  private rotate(): void {
    try {
      const oldest = `${this.file}.${KEEP_FILES}`;
      if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
      for (let i = KEEP_FILES - 1; i >= 1; i--) {
        const src = `${this.file}.${i}`;
        if (fs.existsSync(src)) fs.renameSync(src, `${this.file}.${i + 1}`);
      }
      fs.renameSync(this.file, `${this.file}.1`);
      this.size = 0;
    } catch {
      this.size = 0;
    }
  }
}

let sessionLogger: FileLogger | null = null;

export function initSessionLogger(file: string): FileLogger {
  sessionLogger = new FileLogger(file);
  const stamp = new Date().toISOString();
  sessionLogger.write(`\n===== DSH Desktop session start ${stamp} =====`);
  return sessionLogger;
}

export function log(line: string): void {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  sessionLogger?.write(`[${stamp}] ${line}`);
  if (!process.env.DSH_DESKTOP_QUIET) {
    // 开发态同步打印到控制台，方便排查
    console.log(`[dsh-desktop] ${line}`);
  }
}

/** 把 dsh 子进程的原始输出按 chunk 落盘（流式，不聚合） */
export function logDshChunk(chunk: Buffer | string): void {
  sessionLogger?.write(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
}

export function logPaths(): { dir: string; base: string } {
  return { dir: path.dirname(sessionLogger?.filePath ?? ''), base: 'app.log' };
}
