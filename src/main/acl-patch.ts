/**
 * 运行时补丁：Windows ACL 沙箱的令牌默认 DACL 补 world 条目。
 *
 * 【为什么】
 * \`workspace-write\` 下受限子进程会以 \`STATUS_DLL_INIT_FAILED (0xC0000142)\` 秒死，
 * 现象是「\`workspace-write\` 下任何命令都跑不了、无任何输出」，而同样参数的
 * \`read-only\` 正常。实测（A/B，唯一变量就是本补丁）：
 *
 *   | 模式             | 原版  | 打完本补丁 |
 *   | ---------------- | ----- | ---------- |
 *   | workspace-write  | ❌ 0xC0000142 | ✅ 正常 |
 *   | read-only        | ✅ 正常 | ✅ 正常     |
 *
 * 【机制】
 * \`AclSandbox.init()\` 用 \`setTokenDefaultDaclGrant\` 往令牌的**默认 DACL** 合并一条
 * 全权 ACE。默认 DACL 是「该令牌新建且未显式指定安全描述符的对象」继承的 DACL。
 *
 * 该调用在两种模式下传的 SID 不同：
 *   · read-only       → \`world\`（Everyone）
 *   · workspace-write → 能力 SID（\`S-1-4-*\`，tempWriteSid ?? writeSid）
 *
 * 而 Windows 对写类访问做**两次**检查：先用令牌的正常 SID 列表（pass-1），
 * 再用 restricting 列表（pass-2）。**能力 SID 只在 restricting 列表里**，
 * 不在正常列表里 —— 于是 workspace-write 下新建的对象只满足 pass-2、
 * pass-1 无任何 SID 可匹配，对象不可用，进程在 DLL 初始化阶段就死。
 * read-only 合并的是 Everyone（保活组成员，在正常列表里），两次都过，所以正常。
 *
 * 上游注释已经写到「新对象的自身 DACL 要过 pass-2」，**漏了 pass-1** —— 这是缺陷。
 *
 * 【为什么不削弱写边界】
 * 默认 DACL 只作用于「本令牌新建的对象」；**对象创建本身**仍由父容器 DACL 把关
 * （未授权目录里的文件依旧创建不出来）。实测打完补丁后：
 *   写工作区 ✅ / 写桌面 ❌ / 写 C:\\Windows ❌ / 写 D:\\ 根 ❌ —— 边界完好。
 *
 * 【为什么放外壳里】
 * 补丁打在运行时的编译产物上，上游运行时热更新/自愈修复会覆盖它；启动时幂等
 * 重打一次。上游修好后锚点失配 → 安静跳过（宁可不补也不能改坏）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';

const ACL_PACKAGE_DIR = path.join(
  'node_modules',
  '@deepseek-ai',
  'dsh-sandbox-windows-acl',
  'lib',
);

/** 承载 \`setTokenDefaultDaclGrant\` 的文件名前缀（上游用 hash 命名，版本间会变）。 */
const IMPL_FILE_PREFIX = 'types-';

/** 补丁标记：已打过就不再重复。 */
const PATCHED_MARKER = 'DSH Desktop shell (default-DACL pass-1 fix)';

/**
 * 锚点：\`init()\` 里那次默认 DACL 合并调用（与上游编译产物逐字匹配）。
 * 注意末尾是分号，且该字符串在文件里唯一。
 */
const ANCHOR =
  'setTokenDefaultDaclGrant(api, restrictedToken, this.tempWriteSidPtr ?? this.writeSidPtr ?? worldSid);';

/** 幂等补丁：在锚点之后追加一次 world 合并，补上 pass-1。 */
const PATCHED = [
  ANCHOR,
  '			// ' + PATCHED_MARKER,
  '			// 能力 SID 只在 restricting 列表里，只满足 pass-2；新建对象的 pass-1',
  '			// 需要正常 SID 列表里的主体（Everyone 是保活组成员）。缺了它，',
  '			// workspace-write 下的子进程会在 DLL 初始化阶段以 0xC0000142 死掉。',
  '			setTokenDefaultDaclGrant(api, restrictedToken, worldSid);',
].join('\n');

export function ensureAclDefaultDaclPatch(runtimeDir: string): void {
  if (process.platform !== 'win32') return;
  try {
    const libDir = path.join(runtimeDir, ACL_PACKAGE_DIR);
    if (!fs.existsSync(libDir)) {
      log('ACL 默认DACL补丁：未找到 dsh-sandbox-windows-acl，跳过');
      return;
    }
    // 上游用 hash 命名（types-XXXXXXXX.js），文件名会随版本变，按前缀找。
    const target = fs
      .readdirSync(libDir)
      .filter((name) => name.startsWith(IMPL_FILE_PREFIX) && name.endsWith('.js'))
      .map((name) => path.join(libDir, name))
      .find((file) => {
        try {
          return fs.readFileSync(file, 'utf8').includes(ANCHOR);
        } catch {
          return false;
        }
      });
    if (!target) {
      log('ACL 默认DACL补丁：锚点未匹配（上游实现可能已变化或已自行修复），跳过');
      return;
    }
    const content = fs.readFileSync(target, 'utf8');
    if (content.includes(PATCHED_MARKER)) return; // 已打过，幂等退出
    if (content.includes('setTokenDefaultDaclGrant(api, restrictedToken, worldSid);')) {
      // 上游已自己补了 world（无论注释怎么写），不要再叠一条
      log('ACL 默认DACL补丁：上游已合并 world，跳过');
      return;
    }
    fs.writeFileSync(target, content.replace(ANCHOR, PATCHED), 'utf8');
    log(`ACL 默认DACL补丁：已应用（${path.basename(target)}）——workspace-write 下命令不再 0xC0000142`);
  } catch (err) {
    log(`ACL 默认DACL补丁失败（不影响启动，沙箱命令可能仍不可用）：${String((err as Error)?.message ?? err)}`);
  }
}
