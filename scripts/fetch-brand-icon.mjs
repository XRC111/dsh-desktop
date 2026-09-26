// 下载 DeepSeek 官方 favicon（作为应用图标的源图）
// 说明：官方站点只提供 ICO 形式的 favicon（225x225，32bpp DIB）。
//       gen-assets.mjs 会解码它并生成标准的多尺寸 ICO 与托盘图标。
//
// 该脚本是可选步骤：仓库中已放置 build/deepseek-icon/favicon.ico，
// 离线构建时会直接复用，不会联网。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'build', 'deepseek-icon');
const out = path.join(dir, 'favicon.ico');
const url = 'https://www.deepseek.com/favicon.ico';

fs.mkdirSync(dir, { recursive: true });

if (fs.existsSync(out) && !process.argv.includes('--force')) {
  console.log(`[brand-icon] 已存在，跳过下载：${path.relative(root, out)}（--force 可强制更新）`);
  process.exit(0);
}

try {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // 校验是否为 ICO（避免把 404 HTML 页面写成图标）
  if (!(buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0)) {
    throw new Error(`返回内容不是 ICO（前 4 字节 ${[...buf.subarray(0, 4)].join(',')}）`);
  }
  fs.writeFileSync(out, buf);
  console.log(`[brand-icon] 已下载官方 favicon → ${path.relative(root, out)}（${buf.length} bytes）`);
} catch (err) {
  console.error(`[brand-icon] 下载失败：${err.message}`);
  console.error('             可手动把官方 favicon 放到 build/deepseek-icon/favicon.ico。');
  console.error('             若网络需要代理，请用浏览器下载后放入该路径。');
  process.exit(1);
}
