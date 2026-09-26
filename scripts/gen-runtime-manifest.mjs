// 生成运行时文件清单，供应用启动时做完整性自检与自动修复。
//
// 背景：NSIS 解压 3.5 万个小文件时，在部分机器上（杀软实时扫描 / 慢盘）
//       会出现静默丢文件的情况（实测一次丢失约 25%），表现为 dsh 启动时
//       报 "Cannot find module './xxx'"。
//       因此在安装包里同时附带一份清单 + 一份 tar，启动时若发现缺失就从 tar 补齐。
//
// 产物：build/dsh-runtime-manifest.json
//   files 为相对 resources 目录的 posix 路径（与 tar 成员名一致，形如
//   "dsh-runtime/node_modules/...")
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, 'resources', 'dsh-runtime');
const outFile = path.join(root, 'build', 'dsh-runtime-manifest.json');

if (!fs.existsSync(runtime)) {
  console.error('[manifest] 未找到 resources/dsh-runtime，请先执行 npm run prepare:runtime');
  process.exit(1);
}

const files = [];
let totalBytes = 0;

function walk(dir, relBase) {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(abs, relBase);
    } else if (st.isFile()) {
      totalBytes += st.size;
      files.push(path.relative(relBase, abs).split(path.sep).join('/'));
    }
  }
}

// 以 resources 为基准，成员名与 tar 一致（dsh-runtime/...）
walk(runtime, path.dirname(runtime));

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(
  outFile,
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    fileCount: files.length,
    totalBytes,
    files,
  }),
);

const mb = (fs.statSync(outFile).size / 1024 / 1024).toFixed(2);
console.log(
  `[manifest] 已生成 build/dsh-runtime-manifest.json：${files.length} 个文件，` +
    `${(totalBytes / 1024 / 1024).toFixed(1)} MB，清单 ${mb} MB`,
);
