#!/usr/bin/env node
/**
 * 守住 dsh-market 里的兼容层改动。
 *
 * ── 为什么需要这个脚本 ──────────────────────────────────────────────────────
 * `resources/dsh-plugins/dshmarket` 是从上游 npm 包整份同步的（见
 * `chore(dshmarket): 同步上游 1.66.x → …` 那几个提交）。同步方式是整目录替换，
 * 于是我们对它做的三处改动会**静默消失** —— 没有冲突、没有报错，只是兼容层
 * 突然不生效了。表现是「市场又开始把旧插件标成不兼容」，而没人会联想到是
 * 上游同步干的。
 *
 * 改动本身记录在 `scripts/patches/dshmarket-legacy-compat.patch`，同步后重放：
 *   git apply scripts/patches/dshmarket-legacy-compat.patch
 *
 * 这个脚本做的是**事后检查**：三处改动只要缺一处就红，并直接指向 patch 文件。
 *
 * 跑法：node scripts/check-dshmarket-compat.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKET = path.join(ROOT, 'resources/dsh-plugins/dshmarket');
const PATCH = 'scripts/patches/dshmarket-legacy-compat.patch';

/** 三处改动各自的识别标记（用代码里真实存在的一段，不写注释）。 */
const CHECKS = [
    {
        file: 'lib/legacy-compat.js',
        label: '兼容层模块本体',
        test: (text) => text.includes('export function crossesLine') && text.includes('export function mergeExemptions'),
    },
    {
        file: 'lib/discovery-compatibility.js',
        label: '市场列表按兼容层放行',
        test: (text) => /import\s*\{\s*crossesLine\s*\}\s*from\s*'\.\/legacy-compat\.js'/.test(text)
            && text.includes('crossesLine(hostVersion, declaration.range)'),
    },
    {
        file: 'lib/routes.js',
        label: '安装前写精确豁免',
        test: (text) => /import\s*\{[^}]*mergeExemptions[^}]*\}\s*from\s*'\.\/legacy-compat\.js'/.test(text)
            && text.includes('async function preauthorizeLegacy')
            && text.includes('await preauthorizeLegacy(targets)'),
    },
];

let failed = 0;
for (const check of CHECKS) {
    const file = path.join(MARKET, check.file);
    if (!fs.existsSync(file)) {
        console.log(`  FAIL  ${check.label} —— 缺文件 ${check.file}`);
        failed += 1;
        continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    if (check.test(text)) {
        console.log(`  PASS  ${check.label}`);
    } else {
        console.log(`  FAIL  ${check.label} —— ${check.file} 里找不到对应改动`);
        failed += 1;
    }
}

if (failed > 0) {
    console.error('');
    console.error(`dsh-market 的兼容层改动有 ${failed} 处不见了。`);
    console.error('多半是同步上游时整目录覆盖了。重放补丁：');
    console.error(`  git apply ${PATCH}`);
    // 另一种可能，且症状一模一样：在这个目录里跑过 `npm run build`。
    // lib/ 是 tsc 从 src/*.ts 编译出来的，而兼容层只存在于 lib/ 里 ——
    // 编译一次就被抹掉，且没有任何输出提示。不说清楚的话，第一反应一定是
    // 去查上游同步，而它可能根本没发生过。
    console.error('');
    console.error('如果并没有同步上游，检查是否在 resources/dsh-plugins/dshmarket 里');
    console.error('跑过 `npm run build` 或 `npm install`（后者会触发 prepare 构建）：');
    console.error('lib/ 是 tsc 从 src/*.ts 编译出来的，兼容层只在 lib/ 里，编译一次就没了。');
    process.exit(1);
}
console.log('\n兼容层改动齐全。');
