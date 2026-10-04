/**
 * 网卡 / 地址识别 —— 把「一堆 IP」变成「这个地址是什么、该不该给手机」。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * 联动要用户在手机上填一个「桌面地址」。以前这里返回 os.networkInterfaces()
 * 里所有非 internal 的 IPv4，装上组网工具之后会变成这样：
 *
 *   192.168.3.173, 100.101.102.103, 10.126.126.5, 172.17.0.1
 *
 * 用户根本不知道该填哪个。而这四个分别是：家里局域网、Tailscale、EasyTier、
 * Docker —— 填错一个就连不上，且报错只有 "连不上" 三个字。
 *
 * ── 判断原则：宁可说"不确定"，也不要猜错 ────────────────────────────────────
 * 只有**高置信**的规则才给具体类型，其余一律 unknown。
 * 标错比不标更糟 —— 用户会照着错的填。（同一个教训在原生审计那节也出现过：
 * 噪音/假阳性会让整个提示失去可信度。）
 *
 * 置信度来源，按可靠性排序：
 *   1. 网卡名（最可靠）—— tailscale0 / easytier / ztxxxxxxxx 这些名字是工具
 *      自己起的，不是猜的；
 *   2. 地址段（次之，但有些段是工具的**默认值**，如 EasyTier 的 10.126.126.0/24、
 *      ZeroTier 的 10.147.17.0/24）—— 用户可改，所以只作辅助；
 *   3. 什么都没有 → unknown。
 */

/**
 * 网卡名 → 类型。字符串包含匹配（小写化后）。
 *
 * ⚠️ 用**包含**而不是等值：Windows 上叫 "Tailscale"，Linux 上叫 "tailscale0"，
 *    Android 上可能是 "tun0"。名字形态各平台不同。
 */
const IFACE_RULES = [
    { kind: 'tailscale', label: 'Tailscale', match: ['tailscale', 'tsnet'] },
    { kind: 'easytier', label: 'EasyTier', match: ['easytier', 'et-'] },
    { kind: 'zerotier', label: 'ZeroTier', match: ['zerotier', 'zt'] },
    { kind: 'wireguard', label: 'WireGuard', match: ['wireguard', 'wg0', 'wg1'] },
    { kind: 'docker', label: 'Docker', match: ['docker', 'br-'] },
    { kind: 'wsl', label: 'WSL/Hyper-V', match: ['vethernet', 'wsl'] },
    { kind: 'vm', label: '虚拟机网卡', match: ['vmware', 'virtualbox', 'vbox', 'hyper-v'] },
];

/**
 * 地址段 → 类型。仅在网卡名给不出结论时使用。
 *
 * 这些都写清了"为什么是这个段"，因为段本身可能被用户改掉 ——
 * 一旦改了就识别不出来，那时退回 unknown 是正确的，不是遗漏。
 */
const RANGE_RULES = [
    // Tailscale 的 IPv4 一定落在 CGNAT 段 100.64.0.0/10（RFC 6598）。
    //
    // ⚠️ 基址必须是**完整 32 位网络地址**，前缀必须写对。我第一版写成
    //    [[0x6440, 8]] —— 那等于 100.0.0.0/8，会把 100.90.x.x 这种公网地址
    //    也认成 Tailscale（测试当场抓到了）。
    { kind: 'tailscale', label: 'Tailscale（CGNAT 段）', v4: [[0x64400000, 10]] },
    // EasyTier 未指定时默认分配 10.126.126.0/24。
    { kind: 'easytier', label: 'EasyTier（默认网段）', v4: [[0x0a7e7e00, 24]] },
    // ZeroTier 的历史默认网段（可改，所以只是提示）。
    { kind: 'zerotier', label: 'ZeroTier（默认网段）', v4: [[0x0a930000, 16]] },
    // Docker 默认网桥。
    { kind: 'docker', label: 'Docker', v4: [[0xac110000, 16]] },
];

/** 把 IPv4 点分十进制转成 32 位整数。 */
function v4ToInt(addr) {
    const parts = String(addr).split('.');
    if (parts.length !== 4) return null;
    let n = 0;
    for (const p of parts) {
        const v = Number(p);
        if (!Number.isInteger(v) || v < 0 || v > 255) return null;
        n = (n << 8) | v;
    }
    return n >>> 0;
}

/** 判断 IPv4 是否落在 [base, prefix] 段内。 */
function inV4Range(addr, base, prefix) {
    const n = v4ToInt(addr);
    if (n === null) return false;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (n & mask) === (base & mask);
}

/**
 * 识别一个地址。
 *
 * @param {string} iface - 网卡名。
 * @param {string} address - IP 地址。
 * @param {string} family - 'IPv4' | 'IPv6'。
 * @returns {{kind: string, label: string, hint: string|null}} 分类结果。
 */
export function classifyAddress(iface, address, family) {
    const name = String(iface ?? '').toLowerCase();

    // 1) 网卡名优先 —— 最可靠。
    for (const rule of IFACE_RULES) {
        if (rule.match.some((m) => name.includes(m))) {
            // ZeroTier 的网卡名就是 'zt' + 10 位十六进制，但 'zt' 也会误伤
            // 'ezt' 之类。这里要求名字以 zt 开头才认，避免误标。
            if (rule.kind === 'zerotier' && !/^zt[0-9a-f]{6,}/.test(name)) continue;
            return {
                kind: rule.kind,
                label: rule.label,
                confidence: 'high',
                hint: '这是一张虚拟网卡，只有在对方也加入同一张网络时才能连上。',
            };
        }
    }

    // 2) 地址段辅助判断。
    if (family === 'IPv4') {
        for (const rule of RANGE_RULES) {
            for (const [base, prefix] of rule.v4 ?? []) {
                if (inV4Range(address, base, prefix)) {
                    // 网段是**工具的默认值**，用户可能改过；所以标成"可能"，
                    // 置信度也不如网卡名。界面要能区分这两者。
                    return {
                        kind: rule.kind,
                        label: rule.label + '（可能）',
                        confidence: 'medium',
                        hint: '网卡名没有给出线索，这是按默认网段推测的。',
                    };
                }
            }
        }
        if (String(address).startsWith('169.254.')) {
            return { kind: 'linklocal', label: '链路本地（无效）', confidence: 'high', hint: '这个地址不能用于跨设备连接。' };
        }
        // 私网段：是局域网地址，但很可能就是用户要填的那个。
        if (/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(address)) {
            return { kind: 'lan', label: '局域网', confidence: 'medium', hint: null };
        }
        return { kind: 'public-v4', label: '公网 IPv4', confidence: 'medium', hint: null };
    }

    if (family === 'IPv6') {
        // Tailscale 的 IPv6 是 fd7a:115c:a1e0::/48 这个固定前缀。
        if (/^fd7a:115c:a1e0:/i.test(address)) {
            return { kind: 'tailscale', label: 'Tailscale（固定前缀）', confidence: 'high', hint: null };
        }
        if (/^fe80:/i.test(address)) {
            return { kind: 'linklocal', label: '链路本地（无效）', confidence: 'high', hint: '这个地址不能用于跨设备连接。' };
        }
        if (/^f[cd]/i.test(address)) {
            return { kind: 'ula', label: 'IPv6 私网（ULA）', confidence: 'medium', hint: null };
        }
        // 2000::/3 是当前全球单播地址空间。
        if (/^[23]/i.test(address)) {
            return { kind: 'public-v6', label: '公网 IPv6', confidence: 'high', hint: 'IPv6 无 NAT，跨网络直连通常可用。' };
        }
        return { kind: 'unknown-v6', label: 'IPv6', confidence: 'low', hint: null };
    }

    return { kind: 'unknown', label: '未知', confidence: 'low', hint: null };
}

/**
 * 把 os.networkInterfaces() 的结果整理成可展示的地址列表。
 *
 * @param {object} interfaces - os.networkInterfaces() 的返回值。
 * @returns {Array<{address: string, family: string, iface: string, kind: string, label: string, hint: string|null, usable: boolean}>}
 *          可用地址在前；标注为不可用的（链路本地等）排在最后但仍返回，
 *          这样用户看到"为什么没列出来"时能找到答案，而不是以为程序漏了。
 */
export function describeAddresses(interfaces) {
    const out = [];
    for (const [iface, list] of Object.entries(interfaces ?? {})) {
        for (const ni of list ?? []) {
            // 回环不列：它对别人没有意义。
            if (ni.internal) continue;
            const info = classifyAddress(iface, ni.address, ni.family);
            // IPv6 注意事项：一台机器上常同时存在多个全球地址 —— DHCPv6/SLAAC 的
            // "稳定"地址，以及 **临时/隐私地址**（Windows 默认开启
            // UseTemporaryAddresses）。后者会定期轮换，写进配置里过一阵就失效。
            //
            // ⚠️ os.networkInterfaces() 拿不到"这个地址是临时还是稳定"（那需要
            //    系统 API）。所以这里不假装能判断，只在有多个全球 IPv6 时把这件事
            //    说清楚 —— 让用户知道"别只看第一个"，而不是给他一个会变的默认值。
            out.push({
                address: ni.address,
                family: ni.family,
                iface,
                ...info,
                usable: info.kind !== 'linklocal',
            });
        }
    }
    // 多个全球 IPv6 时补一句提醒（见上面的说明：拿不到临时/稳定的区分）。
    const globalV6 = out.filter((x) => x.family === 'IPv6' && x.usable && x.kind === 'public-v6');
    if (globalV6.length > 1) {
        for (const x of globalV6) {
            x.hint = (x.hint ? x.hint + ' ' : '')
                + '本机有 ' + globalV6.length + ' 个公网 IPv6，其中可能有会轮换的临时地址；'
                + '如果过一阵连不上，换列表里的另一个试试。';
        }
    }

    // ── 排序 ────────────────────────────────────────────────────────────────
    // 用户是从上往下挑的，所以顺序就是建议顺序。三条规则，按重要性排：
    //
    //   1. 可用的在前（链路本地这类永远不能用，沉底）；
    //   2. **机器内部网络沉底** —— Docker / WSL / 虚拟机网卡是宿主机内部的，
    //      外部设备**根本连不到**。把它们排在候选里只会误导用户。
    //      我第一版把它们和真正的 overlay 并列，测试立刻抓到排序不确定。
    //   3. 剩下按「最可能就是答案」排：局域网 → 公网 → 各种 overlay → 未知。
    const INTERNAL_KINDS = new Set(['docker', 'wsl', 'vm']);
    const kindRank = {
        lan: 0,
        'public-v4': 1,
        'public-v6': 2,
        tailscale: 3,
        easytier: 4,
        zerotier: 5,
        wireguard: 6,
        ula: 7,
    };
    const internal = (x) => (INTERNAL_KINDS.has(x.kind) ? 1 : 0);
    out.sort((a, b) => {
        if (a.usable !== b.usable) return a.usable ? -1 : 1;
        if (internal(a) !== internal(b)) return internal(a) - internal(b);
        const ra = kindRank[a.kind] ?? 10;
        const rb = kindRank[b.kind] ?? 10;
        if (ra !== rb) return ra - rb;
        // 最后按地址字符串稳定排序 —— 保证同样输入永远得到同样顺序，
        // 否则界面每次刷新顺序都可能变，用户会以为地址在变。
        if (a.family !== b.family) return a.family === 'IPv4' ? -1 : 1;
        return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
    });
    return out;
}
