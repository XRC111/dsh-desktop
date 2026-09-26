// 把非 TypeScript 的静态资源复制到编译输出目录
//   src/renderer/*.html  →  out/renderer/
//   build/tray.png       →  out/assets/（开发态托盘图标兜底）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function copyDir(from, to, filter) {
  if (!fs.existsSync(from)) return 0;
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    if (!fs.statSync(src).isFile()) continue;
    if (filter && !filter(name)) continue;
    fs.copyFileSync(src, path.join(to, name));
    n++;
  }
  return n;
}

const htmlCount = copyDir(
  path.join(root, 'src', 'renderer'),
  path.join(root, 'out', 'renderer'),
  (n) => n.endsWith('.html') || n.endsWith('.js'),
);

const traySrc = path.join(root, 'build', 'tray.png');
let trayCount = 0;
if (fs.existsSync(traySrc)) {
  const dest = path.join(root, 'out', 'assets');
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(traySrc, path.join(dest, 'tray.png'));
  trayCount = 1;
}

console.log(`[copy-static] renderer=${htmlCount} 个 html，assets=${trayCount} 个图标`);
