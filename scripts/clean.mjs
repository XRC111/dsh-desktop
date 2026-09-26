// 清理构建产物
//   node scripts/clean.mjs          清理 out/ 与 dist/
//   node scripts/clean.mjs --all    连带删除 resources/dsh-runtime（下次构建需重新下载）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const all = process.argv.includes('--all');

const targets = [path.join(root, 'out'), path.join(root, 'dist')];
if (all) targets.push(path.join(root, 'resources', 'dsh-runtime'));

for (const dir of targets) {
  if (!fs.existsSync(dir)) {
    console.log(`[clean] 跳过（不存在）：${path.relative(root, dir)}`);
    continue;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`[clean] 已删除：${path.relative(root, dir)}`);
}
