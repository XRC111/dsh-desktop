// 生成应用图标资源（零依赖：手写 ICO 解码/封装 + PNG 编码 + 双线性缩放）
//
// 源图优先级：
//   1) build/deepseek-icon/favicon.ico —— DeepSeek 官方 favicon（225x225，32bpp DIB）
//   2) 内置程序绘制的占位图标（无官方图标时兜底）
//
// 产物：
//   build/icon.ico       —— 安装包 / 窗口图标（256/128/64/48/32/16 多尺寸）
//   build/tray.png       —— 系统托盘图标（32x32）
//   build/icon-256.png   —— 预览用大图
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(root, 'build');
const brandIcon = path.join(buildDir, 'deepseek-icon', 'favicon.ico');
fs.mkdirSync(buildDir, { recursive: true });

// ---------------------------------------------------------------------------
// PNG 编码
// ---------------------------------------------------------------------------
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
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// ICO 解码（支持 32bpp / 24bpp DIB，以及 PNG 内嵌）
// ---------------------------------------------------------------------------
function decodeIco(file) {
  const buf = fs.readFileSync(file);
  if (!(buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0)) {
    throw new Error('不是有效的 ICO 文件');
  }
  const count = buf.readUInt16LE(4);

  // 取最大的一张
  let best = null;
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    const w = buf[off] === 0 ? 256 : buf[off];
    const size = buf.readUInt32LE(off + 8);
    const dataOff = buf.readUInt32LE(off + 12);
    if (!best || w > best.w) best = { w, size, dataOff };
  }
  if (!best) throw new Error('ICO 中没有图像');

  const head = buf.subarray(best.dataOff, best.dataOff + 8);
  const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  if (isPng) {
    throw new Error('ICO 内为 PNG 内嵌格式，本脚本仅处理 DIB 格式；请改用 PNG 源图');
  }

  // BITMAPINFOHEADER
  const headerSize = buf.readUInt32LE(best.dataOff);
  const width = buf.readInt32LE(best.dataOff + 4);
  const rawHeight = buf.readInt32LE(best.dataOff + 8); // 含 AND mask，实际高度为一半
  const bpp = buf.readUInt16LE(best.dataOff + 14);
  const height = rawHeight / 2;
  if (bpp !== 32 && bpp !== 24) {
    throw new Error(`暂不支持的位深：${bpp}bpp`);
  }

  const bytesPerPixel = bpp / 8;
  const rowSize = width * bytesPerPixel;
  const pixelStart = best.dataOff + headerSize;
  const rgba = Buffer.alloc(width * height * 4);

  let alphaAllZero = true;
  for (let y = 0; y < height; y++) {
    // DIB 是自下而上存储
    const srcRow = pixelStart + (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      const s = srcRow + x * bytesPerPixel;
      const d = (y * width + x) * 4;
      rgba[d] = buf[s + 2]; // R
      rgba[d + 1] = buf[s + 1]; // G
      rgba[d + 2] = buf[s]; // B
      const a = bpp === 32 ? buf[s + 3] : 255;
      rgba[d + 3] = a;
      if (a !== 0) alphaAllZero = false;
    }
  }

  // 部分图标 32bpp 的 alpha 全为 0，此时回退到 AND mask
  if (bpp === 32 && alphaAllZero) {
    const maskRowSize = Math.ceil(width / 32) * 4;
    const maskStart = pixelStart + rowSize * height;
    for (let y = 0; y < height; y++) {
      const srcRow = maskStart + (height - 1 - y) * maskRowSize;
      for (let x = 0; x < width; x++) {
        const byte = buf[srcRow + (x >> 3)];
        const bit = (byte >> (7 - (x & 7))) & 1;
        rgba[(y * width + x) * 4 + 3] = bit ? 0 : 255;
      }
    }
  }

  return { width, height, rgba };
}

// ---------------------------------------------------------------------------
// 双线性缩放（预乘 alpha，避免透明边缘出现黑边）
// ---------------------------------------------------------------------------
function resize(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const fy = ((y + 0.5) * sh) / dh - 0.5;
    const y0 = Math.max(0, Math.floor(fy));
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = Math.min(1, Math.max(0, fy - y0));
    for (let x = 0; x < dw; x++) {
      const fx = ((x + 0.5) * sw) / dw - 0.5;
      const x0 = Math.max(0, Math.floor(fx));
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = Math.min(1, Math.max(0, fx - x0));

      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;

      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      const add = (i, wgt) => {
        const al = src[i + 3] / 255;
        r += src[i] * al * wgt;
        g += src[i + 1] * al * wgt;
        b += src[i + 2] * al * wgt;
        a += al * wgt;
      };
      add(i00, (1 - wx) * (1 - wy));
      add(i10, wx * (1 - wy));
      add(i01, (1 - wx) * wy);
      add(i11, wx * wy);

      const d = (y * dw + x) * 4;
      if (a > 0) {
        out[d] = Math.min(255, Math.round(r / a));
        out[d + 1] = Math.min(255, Math.round(g / a));
        out[d + 2] = Math.min(255, Math.round(b / a));
        out[d + 3] = Math.min(255, Math.round(a * 255));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 占位图标（无官方图标时的兜底：圆角渐变底 + 白色 D）
// ---------------------------------------------------------------------------
const C1 = [0x4d, 0x6b, 0xfe];
const C2 = [0x8a, 0x6b, 0xff];

function insideRoundedRect(x, y, size, radius) {
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function insideLetterD(px, py) {
  if (px >= 74 && px <= 104 && py >= 58 && py <= 198) return true;
  const dx = px - 104;
  const dy = py - 128;
  const d2 = dx * dx + dy * dy;
  return dx >= 0 && d2 <= 70 * 70 && d2 >= 42 * 42;
}

function renderPlaceholder(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const scale = size / 256;
  const radius = size * 0.225;
  const SS = 3;
  const inv = 1 / (SS * SS);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHit = 0;
      let fgHit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          if (!insideRoundedRect(fx, fy, size, radius)) continue;
          bgHit++;
          if (insideLetterD(fx / scale, fy / scale)) fgHit++;
        }
      }
      const a = bgHit * inv;
      const idx = (y * size + x) * 4;
      if (a <= 0) continue;
      const t = (x / size) * 0.55 + (y / size) * 0.45;
      let r = Math.round(C1[0] + (C2[0] - C1[0]) * t);
      let g = Math.round(C1[1] + (C2[1] - C1[1]) * t);
      let b = Math.round(C1[2] + (C2[2] - C1[2]) * t);
      const fg = fgHit * inv;
      if (fg > 0) {
        r = Math.round(r * (1 - fg) + 255 * fg);
        g = Math.round(g * (1 - fg) + 255 * fg);
        b = Math.round(b * (1 - fg) + 255 * fg);
      }
      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = Math.round(a * 255);
    }
  }
  return rgba;
}

// ---------------------------------------------------------------------------
// ICO 封装
// ---------------------------------------------------------------------------
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);

  const entries = [];
  let offset = 6 + pngs.length * 16;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const sizes = [256, 128, 64, 48, 32, 16];
let source;
let raws = new Map();

if (fs.existsSync(brandIcon)) {
  try {
    const img = decodeIco(brandIcon);
    source = `DeepSeek 官方 favicon（${img.width}x${img.height}）`;
    for (const size of sizes) {
      raws.set(size, resize(img.rgba, img.width, img.height, size, size));
    }
  } catch (err) {
    console.warn(`[gen-assets] 官方图标解析失败（${err.message}），改用内置占位图标`);
  }
}

if (!source) {
  source = '内置占位图标';
  for (const size of sizes) raws.set(size, renderPlaceholder(size));
}

const pngs = sizes.map((size) => ({ size, data: encodePNG(size, size, raws.get(size)) }));

fs.writeFileSync(path.join(buildDir, 'icon.ico'), buildIco(pngs));
fs.writeFileSync(path.join(buildDir, 'tray.png'), encodePNG(32, 32, raws.get(32)));
fs.writeFileSync(path.join(buildDir, 'icon-256.png'), pngs[0].data);

console.log(`[gen-assets] 图标来源：${source}`);
console.log('[gen-assets] 已生成:');
console.log('  build/icon.ico        (256/128/64/48/32/16)');
console.log('  build/tray.png        (32x32)');
console.log('  build/icon-256.png    (256x256)');
