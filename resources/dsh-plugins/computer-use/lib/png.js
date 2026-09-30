/**
 * 零依赖 PNG 编码器。
 *
 * 为什么不用 Electron 的 nativeImage：
 *   computer use 插件跑在 **dsh 子进程**里（`ELECTRON_RUN_AS_NODE=1` 的 electron.exe），
 *   那里 `require('electron')` 返回的是**可执行文件路径字符串**，不是 API 对象 ——
 *   拿不到 nativeImage。实测确认（type=string）。
 *
 * 所以自己编 PNG：Node 内置 zlib 提供 deflate，剩下就是 PNG 的容器格式。
 * 好处是零依赖，且在任何 Node 环境都能用。
 *
 * PNG 结构：
 *   [1m签名[0m 8 字节
 *   IHDR  宽/高/位深/色型（我们用 8 位 RGBA，色型 6）
 *   IDAT  zlib 压缩的扫描行（每行前置 1 字节滤波器类型，我们全用 0 = None）
 *   IEND
 * 每个 chunk 前有 4 字节长度、后有 4 字节 CRC32。
 */

import zlib from 'node:zlib';

// ── CRC32（PNG 每个 chunk 都要）──────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * 把 RGBA 像素编成 PNG。
 *
 * @param rgba   长度 = width*height*4 的 RGBA 缓冲
 * @param width  宽
 * @param height 高
 * @returns PNG 文件字节
 */
export function encodePng(rgba, width, height) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`像素缓冲长度不符：${rgba.length} != ${width}×${height}×4`);
  }

  // IHDR：宽 高 位深=8 色型=6(RGBA) 压缩=0 滤波=0 隔行=0
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // 扫描行：每行前面加一个滤波器字节（0 = None）
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  // 压缩级别 6：截图这种内容压缩率已经很好，再高只是更慢
  const idat = zlib.deflateSync(raw, { level: 6 });

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG 签名
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 把 BGRA（GDI 的原生顺序）转成 RGBA，并把 alpha 强制为不透明。
 *
 * GDI 的 GetDIBits 在 32 位模式下：字节序是 B,G,R,A，且 alpha 恒为 0
 * （不预乘、不填值）—— 直接当 RGBA 用会得到全透明图。
 */
export function bgraToRgba(buf) {
  for (let i = 0; i < buf.length; i += 4) {
    const b = buf[i];
    buf[i] = buf[i + 2];
    buf[i + 2] = b;
    buf[i + 3] = 255;
  }
  return buf;
}
