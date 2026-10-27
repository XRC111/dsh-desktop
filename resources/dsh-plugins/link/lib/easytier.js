/**
 * 内嵌 EasyTier 的桌面侧绑定（koffi FFI）。
 *
 * ── 为什么用 koffi 而不是 spawn 官方 exe ─────────────────────────────────────
 * 三个理由：
 *   1. **免安装**：exe 要单独下载、还要用户自己填 --port-forward 参数；
 *      动态库随应用打包，用户只管填地址。
 *   2. **可控**：直接调 FFI 能拿到结构化错误（get_error_msg），
 *      而 exe 只能匹配 stderr 文本。
 *   3. **省事**：不用管进程生命周期 —— 桌面端没有前台服务那套约束，
 *      进程退出时操作系统自然回收。
 *
 * 代价是要自己处理字符串所有权（见下方 freeRustString），这是 spawn 完全
 * 不存在的问题。
 *
 * ── 签名来自源码，不是猜的 ──────────────────────────────────────────────────
 * 逐个对照 easytier-contrib/easytier-ffi/src/lib.rs（v2.6.4）：
 *   #[unsafe(no_mangle)] pub extern "C" fn parse_config(cfg_str: *const c_char) -> c_int
 *   #[unsafe(no_mangle)] pub extern "C" fn run_network_instance(cfg_str: *const c_char) -> c_int
 *   #[unsafe(no_mangle)] pub unsafe extern "C" fn get_error_msg(out: *mut *const c_char)
 *   #[unsafe(no_mangle)] pub extern "C" fn free_string(s: *const c_char)
 *   #[unsafe(no_mangle)] pub extern "C" fn retain_network_instance(...)
 *   #[unsafe(no_mangle)] pub extern "C" fn collect_network_infos(max_length: c_int) -> *mut c_char
 *
 * 这些是 Rust 侧 `#[no_mangle]` 导出的 C ABI，名字对不上就是
 * UnsatisfiedLinkError —— 而那个错只在运行时炸。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// ESM 里没有 require。koffi 是 CommonJS 原生包，用 createRequire 加载。
// 不放在模块顶层 —— 那会在 koffi 缺失时**加载插件就崩**，而组网是可选功能。
const requireCjs = createRequire(import.meta.url);

const TAG = 'link/easytier';

/** 虚拟网段。两端必须一致，否则端口转发指向不存在的地址。 */
export const SUBNET = '10.144.0.0/24';
/** 本机（桌面）虚拟 IP。固定而非随机 —— 手机侧的 dst_addr 指向它。 */
export const DESKTOP_IP = '10.144.0.2';
/** 手机虚拟 IP。 */
export const PHONE_IP = '10.144.0.3';
/** 实例名。与手机侧区分开，便于在 collect_network_infos 里认。 */
export const INSTANCE = 'dsh-desktop';

/** 进程内句柄：库加载一次，函数引用全局复用。 */
let lib = null;
/** koffi 模块本身（out/pointer/char 等类型构造要用）。 */
let koffiRef = null;
/** 最近一次实例是否在跑（retain_network_instance 只保留一个实例）。 */
let running = false;

/**
 * 找 libeasytier_ffi.dll。
 *
 * ⚠️ 找不到时**不抛异常** —— 组网是可选功能，不能因为它缺了就让整个
 * 「远程联动」插件加载失败（那会让设置页整个打不开）。调用方用
 * [isAvailable] 判断后再决定要不要用。
 *
 * 搜索顺序：
 *   1. DSH_EASYTIER_DLL —— 测试与自定义路径（跑测试时指向真实 dll）
 *   2. 插件目录下的 vendor/ —— 打包时把 dll 放这
 *   3. 已安装目录的资源目录 —— 运行时（DSH 装了带 dll 的版本时）
 */
function findDll(pluginRoot) {
    const explicit = process.env.DSH_EASYTIER_DLL;
    if (explicit && fs.existsSync(explicit)) return explicit;

    const candidates = [];
    if (pluginRoot) candidates.push(path.join(pluginRoot, 'vendor', 'libeasytier_ffi.dll'));
    // 已安装的插件在 profiles/node_modules 下；从它往上找 resources。
    if (pluginRoot) {
        let dir = pluginRoot;
        for (let i = 0; i < 6 && dir; i++) {
            candidates.push(path.join(dir, 'resources', 'libeasytier_ffi.dll'));
            dir = path.dirname(dir);
        }
    }
    candidates.push(path.join(os.homedir(), 'AppData/Roaming/DSH-Desktop/dsh-home/libeasytier_ffi.dll'));
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

/**
 * 加载库并取函数引用。
 *
 * @param {string} [pluginRoot] 插件根目录（用于定位 dll）。
 * @returns {object|null} 成功返回句柄；找不到 dll 返回 null。
 */
export function load(pluginRoot) {
    if (lib) return lib;
    const dll = findDll(pluginRoot);
    if (!dll) return null;

    let koffi;
    try {
        // 动态 import：koffi 是原生模块，用 require 在 ESM 里更别扭，
        // 而且加载失败（没装）时能只在这一处降级，不影响插件其余部分。
        koffi = requireCjs('koffi');
        koffiRef = koffi;
    } catch (e) {
        console.warn(`[${TAG}] koffi 不可用，组网功能关闭：${e.message}`);
        return null;
    }

    // ⚠️ koffi **3.x**（DSH 运行时里是 3.3.1）的取函数方式是
    //    `库句柄.func('签名串')`，**不是** 2.x 的 `koffi.func(路径, 名字, 返回, 参数)`。
    //    照 2.x 写会得到 "koffi.func is not a function" —— 而库根本没被加载，
    //    报错完全指不到是版本差异。
    //
    //    已用系统自带 dll 实测确认：
    //        const lib = koffi.load('kernel32.dll');
    //        lib.func('int __stdcall GetLastError()')()   // → 0
    let handle;
    try {
        handle = koffi.load(dll);
    } catch (e) {
        // 「找不到指定的模块」通常不是 dll 缺失，而是它**依赖的** dll 缺失。
        // 已实测 easytier_ffi.dll 依赖 packet.dll（WinPcap/Npcap 抓包库）——
        // 多数 Windows 没装。两者的提示必须分开：前者是「没随包发」（我们的问题），
        // 后者是「系统缺组件」（用户得自己去装）。
        const missingDep = /找不到指定的模块|cannot find the module|specified module/i.test(e.message);
        console.warn(
            `[${TAG}] 加载 ${dll} 失败：${e.message}` +
            (missingDep ? '（它依赖 packet.dll 等组件，通常来自 WinPcap/Npcap —— 多数 Windows 没装）' : ''),
        );
        return null;
    }

    // 导出符号已用 llvm-objdump 对过真实 dll，逐字一致：
    //   collect_network_infos / free_string / get_error_msg / parse_config /
    //   retain_network_instance / run_network_instance / set_tun_fd
    try {
        lib = {
            dllPath: dll,
            parse_config: handle.func('int __cdecl parse_config(char *)'),
            run_network_instance: handle.func('int __cdecl run_network_instance(char *)'),
            free_string: handle.func('void __cdecl free_string(char *)'),
            collect_network_infos: handle.func('char* __cdecl collect_network_infos(int)'),
            // 这两个的参数是 char**，用指针套指针。
            get_error_msg: handle.func('void __cdecl get_error_msg(char **out)'),
            retain_network_instance: handle.func('int __cdecl retain_network_instance(char **instanceNames)'),
        };
    } catch (e) {
        // 符号对不上（EasyTier 换版本改了导出）在这里才暴露。
        // UnsatisfiedLinkError 的信息常常只说「找不到指定的过程」、不含库名，
        // 所以把 dll 路径一起带上，否则用户无从判断是哪个库的问题。
        console.warn(`[${TAG}] 从 ${dll} 取导出符号失败：${e.message}`);
        return null;
    }
    console.log(`[${TAG}] 已加载 ${dll}`);
    return lib;
}

/** 组网功能是否可用（dll 在且加载成功）。 */
export function isAvailable(pluginRoot) {
    try {
        return load(pluginRoot) != null;
    } catch {
        return false;
    }
}

/**
 * 释放 Rust 分配的字符串。
 *
 * ⚠️ **必须调**。get_error_msg 与 collect_network_infos 都用
 * `CString::into_raw` 返回 —— 那是**所有权转移**，Rust 侧已经不记得这块内存，
 * 只能由调用方用 free_string 还回去。不调就是每次报错泄漏一次
 * （加上 collect 每秒轮询一次，一天就是几万次泄漏）。
 *
 * ⚠️ koffi 的行为已实测：把返回类型声明成 `char*` 时，**它已经自动解码成
 *   JS 字符串**（用 kernel32 的 lstrcpyA 验证，返回的是 'EASYTIER-PROBE'
 *   而不是数字地址）。所以这里多数情况拿到的是字符串，直接用即可。
 *   若拿到的是数字（声明成 void* 时的情形）则无法确证读法，见 lastError
 *   的说明 —— 那时返回空串而不是乱猜。
 *
 * @param {string|number|bigint|null} ptr koffi 返回的指针或其解码结果。
 * @returns {string} 字符串内容；空则返回 ''。
 */
function takeRustString(ptr) {
    if (!lib) return '';
    // ⚠️ 判空用 `ptr == null` 而不是 `!ptr`：空字符串是**有效**的 Rust 返回
    //    （「没有错误」时 get_error_msg 写回的就是空串），用 !ptr 会把它当
    //    成没拿到而提前 return —— 连带跳过 finally 里的 free_string。
    if (ptr == null) return '';
    try {
        if (typeof ptr === 'string') return ptr;
        // 数字/BigInt 地址：koffi 会自动解码，落到这里说明声明用错了类型。
        // 不猜读法，返回空串 —— 总比返回地址的十进制文本像模像样地错强。
        return '';
    } finally {
        // 即便读取失败也要还回去 —— 泄漏与读取失败无关。
        try {
            lib.free_string(ptr);
        } catch (e) {
            console.warn(`[${TAG}] free_string 失败：${e.message}`);
        }
    }
}

/**
 * 取最后一次错误信息。
 *
 * ⚠️⚠️ **这行是本文件唯一未验证的地方**，原因写在这里以免被当成结论：
 *
 *   真正的调用形态是 `fn(char **out)`（Rust 侧签名确实是 char**，见
 *   lib.rs 的 `out: *mut *const std::ffi::c_char`）。而 koffi 3.x 怎么把
 *   char** 作为 out 参数传给 JS、以及怎么把写回的指针读成字符串，
 *   **没有找到可确证的示例**：
 *
 *     · koffi.types 里 out() 被标成「方向标记类型」，用在签名串里；
 *     · 实测普通 out（uint8_t*）传 Buffer 可以工作；
 *     · 实测 char* **返回值**会被自动解码成 JS 字符串；
 *     · 实测 void* 返回值是 BigInt 地址，读它用 koffi.as / decode / view
 *       都试过，都报类型不符 —— 没有确认可用的读法。
 *
 *   而真 dll 因为依赖 packet.dll（WinPcap/Npcap，多数 Windows 没装）
 *   **加载不了**，所以无法端到端实测。
 *
 *   下面的写法按「char** = 指针槽」处理。若真机上错误信息取不到，
 *   症状是「配置非法但提示里没有原因」—— 改动点就在这几行。
 *
 * @returns {string} 错误信息；取不到时返回 ''。
 */
function lastError() {
    if (!lib) return '';
    try {
        const slot = koffiRef.out(koffiRef.pointer(koffiRef.char));
        lib.get_error_msg(slot);
        return takeRustString(slot.value ?? null);
    } catch (e) {
        console.warn(`[${TAG}] 取错误信息失败：${e.message}`);
        return '';
    }
}

/**
 * 组装 TOML 配置。
 *
 * ── 字段依据 ────────────────────────────────────────────────────────────────
 * easytier-core v2.6.4：
 *   · config/gateway.rs → PortForwardConfig { bind_addr, dst_addr, proto }
 *     proto 是**字符串** "tcp"/"udp"（由 PortForwardConfigPb::socket_type
 *     经 `match … => "tcp".to_string()` 转来），不是枚举数字。
 *   · config/gateway.rs → ProxyRuntimeConfig { no_tun: bool }
 *   · config/toml.rs → NetworkIdentity { network_name, network_secret }
 *
 * 与手机侧**同结构、只有 IP 对调** —— 这是两端能通的前提。
 *
 * @param {object} o
 * @param {string} o.networkName 网络名，两端必须一致。
 * @param {string} o.networkSecret 网络密钥，两端必须一致。
 * @param {string} o.peerUri 手机地址，如 tcp://1.2.3.4:11010。留空则不连任何人。
 * @param {number} o.bindPort 本机转发监听端口。
 * @param {string} o.dstAddr 手机虚拟 IP + 联动端口。
 */
export function buildToml({ networkName, networkSecret, peerUri, bindPort, dstAddr }) {
    const lines = [
        '# 由 DSH Desktop 的 link 插件生成 —— 在设置里改，不要手编。',
        `instance_name = "${INSTANCE}"`,
        'hostname = "desktop"',
        // 固定虚拟 IP：手机侧的 port_forward dst_addr 指向它。
        `ipv4 = "${DESKTOP_IP}/24"`,
        '',
        '[network_identity]',
        `network_name = "${networkName}"`,
        `network_secret = "${networkSecret}"`,
        '',
        '[flags]',
        'no_tun = true',
        '',
    ];
    if (peerUri) {
        lines.push('[[peer]]', `uri = "${peerUri}"`, '');
    }
    lines.push(
        '[[port_forwards]]',
        'proto = "tcp"',
        // 绑 127.0.0.1 而非 0.0.0.0：绑全网卡会把转发端口暴露给同网段任何人，
        // 等于把联动通道敞开。link 客户端本来就只连 127.0.0.1。
        `bind_addr = "127.0.0.1:${bindPort}"`,
        `dst_addr = "${dstAddr}"`,
        '',
    );
    return lines.join('\n');
}

/**
 * 启动组网。
 *
 * 顺序刻意是**先 parse_config 再 run_network_instance**：后者失败时只给一句
 * 「failed to start instance」，指不到是哪行配置错了；前者能立刻说清哪个字段
 * 不认。两者都取 get_error_msg 而不是自己猜原因。
 *
 * @param {object} o 见 [buildToml]。
 * @returns {{ok: boolean, error?: string, toml?: string}}
 */
export function start(o) {
    if (!lib) return { ok: false, error: '组网动态库不可用（未随安装包一起提供）' };
    if (running) stop();

    const toml = buildToml(o);
    try {
        if (lib.parse_config(toml) !== 0) {
            return { ok: false, error: `配置不合法：${lastError()}\n\n配置：\n${toml}`, toml };
        }
        if (lib.run_network_instance(toml) !== 0) {
            return { ok: false, error: `启动失败：${lastError()}`, toml };
        }
        running = true;
        return { ok: true, toml };
    } catch (e) {
        return { ok: false, error: `调用失败：${e.message}`, toml };
    }
}

/** 停止组网。已停止是空操作 —— 停止别人已停的东西不该报错。 */
export function stop() {
    if (!lib || !running) return;
    try {
        lib.retain_network_instance(null);
    } catch (e) {
        console.warn(`[${TAG}] 停止失败：${e.message}`);
    }
    running = false;
}

/** 是否在跑。 */
export function isRunning() {
    return running;
}

/**
 * 当前运行状态（诊断页用）。
 *
 * @returns {{available: boolean, running: boolean, dll?: string, error?: string, peers?: any[]}}
 */
export function status(pluginRoot) {
    // ⚠️ 这里自己兜一次 load()：status 会被诊断页随时调用，不该依赖
    //    「调用方记得先 load 过」。少了这一步会走到 `!lib` 分支返回
    //    「未找到 dll」—— 哪怕 dll 就在那儿。
    if (!lib) load(pluginRoot);
    const dll = lib ? lib.dllPath : findDll(pluginRoot);
    const out = { available: !!dll, running, dll: dll || null };
    if (!lib) {
        out.error = dll ? '库在但未加载' : '未找到 libeasytier_ffi.dll';
        return out;
    }
    try {
        const raw = takeRustString(lib.collect_network_infos(16));
        out.raw = raw;
        // JSON 结构不是稳定 API —— 任何解析失败都退化成空列表，
        // 诊断页少显示内容远好过把设置页搞崩。
        out.peers = (() => {
            try {
                const root = JSON.parse(raw || '{}');
                const map = root.map || {};
                return Object.entries(map).map(([name, info]) => ({
                    name,
                    running: !!info?.running,
                    ipv4: info?.routes?.[0]?.peer_id?.ipv4 || '',
                }));
            } catch {
                return [];
            }
        })();
    } catch (e) {
        out.error = e.message;
    }
    return out;
}