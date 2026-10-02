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

/**
 * 在 RGBA 缓冲上画坐标网格与刻度标签（供截图叠加用）。
 *
 * 为什么要画网格：模型从整屏截图里**目测估算**按钮坐标，误差天然有 10-40px，
 * 而典型按钮只有 24-32px 高 —— 于是「老是点偏」。
 * 画上带数字的网格后，模型可以**读数**（看目标落在哪两条线之间）而不是估数，
 * 把误差压到一个格子的 1/4 以内。这是纯像素操作，零依赖。
 *
 * 网格设计：
 *   · 主格 100px：细线（灰，低对比，不干扰阅读）
 *   · 每 200px：稍亮线 + 边缘坐标数字
 *   · 只在**边缘条带**画数字，不在中间盖住内容
 *
 * @param rgba  RGBA 缓冲（原地修改）
 * @param width/height 尺寸
 * @param originX/originY 该图左上角对应的屏幕坐标（窗口截图时非 0）
 * @param step 主格间距（像素），默认 100
 */
export function drawGrid(rgba, width, height, originX = 0, originY = 0, step = 100) {
  const setPx = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
  };
  // 半透明叠加：把原像素与线条色按比例混合，避免生硬的纯色线盖住内容
  const blend = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    rgba[i] = Math.round(rgba[i] * (1 - a) + r * a);
    rgba[i + 1] = Math.round(rgba[i + 1] * (1 - a) + g * a);
    rgba[i + 2] = Math.round(rgba[i + 2] * (1 - a) + b * a);
    rgba[i + 3] = 255;
  };

  // 网格线：每 step 一条，5px 粗的淡线（视觉上像标尺，不遮挡）
  for (let sx = 0; sx < width; sx += step) {
    const major = ((sx + originX) % (step * 2)) === 0;
    for (let y = 0; y < height; y++) {
      blend(sx, y, major ? 255 : 120, major ? 80 : 160, major ? 80 : 255, major ? 0.45 : 0.22);
      if (major) blend(sx + 1, y, 255, 80, 80, 0.22);
    }
  }
  for (let sy = 0; sy < height; sy += step) {
    const major = ((sy + originY) % (step * 2)) === 0;
    for (let x = 0; x < width; x++) {
      blend(x, sy, major ? 255 : 120, major ? 80 : 160, major ? 80 : 255, major ? 0.45 : 0.22);
      if (major) blend(x, sy + 1, 255, 80, 80, 0.22);
    }
  }

  // 刻度数字：3x5 点阵字体，画在左边缘与上边缘，黑底白字保证可读
  const glyphs = {
    '0': ['111','101','101','101','111'], '1': ['010','110','010','010','111'],
    '2': ['111','001','111','100','111'], '3': ['111','001','111','001','111'],
    '4': ['101','101','111','001','001'], '5': ['111','100','111','001','111'],
    '6': ['111','100','111','101','111'], '7': ['111','001','010','010','010'],
    '8': ['111','101','111','101','111'], '9': ['111','101','111','001','111'],
  };
  const drawText = (txt, tx, ty, scale) => {
    const cw = 3 * scale + scale; // 字宽 + 间距
    // 背景条（黑底，保证任何内容上都可读）
    for (let y = -scale; y < 5 * scale + scale; y++)
      for (let x = -scale; x < txt.length * cw + scale; x++) blend(tx + x, ty + y, 0, 0, 0, 0.75);
    for (let ci = 0; ci < txt.length; ci++) {
      const gph = glyphs[txt[ci]];
      if (!gph) continue;
      for (let gy = 0; gy < 5; gy++)
        for (let gx = 0; gx < 3; gx++)
          if (gph[gy][gx] === '1')
            for (let dy = 0; dy < scale; dy++)
              for (let dx = 0; dx < scale; dx++)
                setPx(tx + ci * cw + gx * scale + dx, ty + gy * scale + dy, 255, 235, 60);
    }
  };

  const scale = width >= 1400 ? 2 : 1;
  // 左侧：纵坐标（每 2*step 标一个，避免太密）
  for (let sy = 0; sy < height; sy += step * 2) {
    drawText(String(sy + originY), 4, sy + 3, scale);
  }
  // 顶部：横坐标
  for (let sx = 0; sx < width; sx += step * 2) {
    drawText(String(sx + originX), sx + 3, 3, scale);
  }
  return { step, originX, originY, gridWidth: width, gridHeight: height };
}
