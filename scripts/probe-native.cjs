// 在 Electron 内置 Node 下探测原生模块能否加载（决定是否需要 ABI 重编译）
// 由 verify-runtime.mjs / rebuild-native.mjs 通过 electron.exe 在 dsh-runtime 目录下执行。
// 注意：必须用绝对路径 require，因为本文件不在 dsh-runtime/node_modules 的解析链上。
// 输出约定：每行 "OK <module>" / "FAIL <module> :: <reason>"，任一失败 → 退出码非 0
const path = require('path');

const base = process.argv[2] || process.cwd();
const modules = ['node-pty', 'koffi', 'sharp', 'node-addon-require-builtin'];

let failed = 0;
console.log(`node=${process.versions.node} abi=${process.versions.modules} base=${base}`);

for (const name of modules) {
  const target = path.join(base, 'node_modules', ...name.split('/'));
  try {
    require(target);
    console.log(`OK ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name} :: ${err && err.message ? err.message.split('\n')[0] : err}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
