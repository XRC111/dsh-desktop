/**
 * DSH 远程联动 —— 设备身份与注册表（mesh 核心）。
 *
 * ── 为什么需要这一层 ────────────────────────────────────────────────────────
 * 原先的联动是**固定一对一**：桌面起服务、手机拨号，一条连接。所以"谁是对方"
 * 是隐含的，加第三台设备就没法表达。
 *
 * mesh 之后每台设备都需要回答三个问题：
 *   1. **我是谁**      → 稳定的 deviceId + 密钥对（identity.js）
 *   2. **我认识谁**    → 配对过的设备清单（registry.js）
 *   3. **现在连上了谁**→ 运行期的连接集合（LinkManager）
 *
 * ── 连接拓扑：为什么是「星型 + 可升级为全互联」 ──────────────────────────────
 * 直觉上"全互联"是 N×(N-1)/2 条连接，但现实有一处不对称：
 *
 *   · 桌面有固定地址，别人**能**主动连它；
 *   · **手机在运营商 CGNAT 后面，别人连不进来**。
 *
 * 所以没有 overlay 虚拟网卡时，物理上能做到的只有**星型**：
 * 主机（通常是手机）当 hub，各从机拨进来。
 *
 * 于是拓扑分两级，检测到可直连时就升级：
 *
 *   STAR   无 overlay  → 一台 hub 收 N 个 client；client 之间不直连
 *   MESH   有 overlay  → 每台设备都有虚拟 IP，于是任意两台可互连
 *
 * 两种模式下**工具寻址完全一样**（都是 link_invoke({ device, ... })），
 * 所以切换拓扑对模型/界面是透明的 —— 这是把拓扑收进连接层的主要好处。
 *
 * ── 身份为什么用密钥对而不是只用令牌 ────────────────────────────────────────
 * 令牌是"共享秘密"：一旦泄密，**所有**用过它的设备都能冒名顶替。密钥对是
 * 每台设备一对：连接时互相验证公钥，配对过一次就长期可信，也能在注册表里
 * 明确"哪台是哪台"。
 *
 * 注意：这不替代通道自身的加密（见 endpoint.js 的 ECDH），而是**身份**层。
 */

import { createHash, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 拓扑模式。 */
export const TOPOLOGY = {
    /** 星型：一台 hub 收多个 client。手机上没有 overlay 时的默认。 */
    star: 'star',
    /** 全互联：每台都有虚拟 IP，任意两台可互连。装了 overlay 之后。 */
    mesh: 'mesh',
};

/**
 * 生成一台设备的稳定身份。
 *
 * 密钥对用 X25519（Node 的 `generateKeyPairSync('x25519')`）：ECDSA 适合签名但
 * 密钥更长，而这里只需要**密钥协商**（证明对方持有私钥），X25519 最小最快。
 * 身份绑定用公钥的 SHA-256 前 8 字节 —— 够短好记，够长不会撞。
 *
 * @param {string} name - 人类可读名（主机名或用户填的）。
 * @param {string} [kind] - 'desktop' | 'mobile'，只影响界面展示。
 * @returns {{deviceId: string, name: string, kind: string, publicKey: string}} 身份。
 */
export function createIdentity(name, kind = 'device') {
    const { publicKey, privateKey } = generateKeyPairSyncX25519();
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const deviceId = fingerprint(pubPem);
    return { deviceId, name: String(name || deviceId.slice(0, 8)), kind, publicKey: pubPem, privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

/**
 * 计算公钥指纹，用作 deviceId。
 * @param {string} pubPem - SPKI PEM。
 * @returns {string} 16 字符十六进制指纹。
 */
function fingerprint(pubPem) {
    return createHash('sha256').update(pubPem).digest('hex').slice(0, 16);
}

/**
 * X25519 密钥对（Node 内置，无需外部依赖）。
 * @returns {{publicKey: import('node:crypto').KeyObject, privateKey: import('node:crypto').KeyObject}} 密钥对。
 */
function generateKeyPairSyncX25519() {
    return generateKeyPairSync('x25519');
}

/**
 * 从磁盘载入身份，没有就生成一个。
 *
 * 私钥保存在 `$DSH_HOME/link/identity.json`。⚠️ 权限尽力设成 0600 ——
 * 目录可能不可写（见 registry 的容错），所以失败不算错误。
 *
 * @param {string} homeDir - DSH_HOME。
 * @param {string} name - 设备名。
 * @param {string} [kind] - 设备类型。
 * @returns {{deviceId: string, name: string, kind: string, publicKey: string, privateKeyPem: string}} 身份。
 */
export function loadOrCreateIdentity(homeDir, name, kind) {
    const file = path.join(homeDir, 'link', 'identity.json');
    try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (saved?.deviceId && saved?.privateKeyPem) return saved;
    } catch { /* 没有或坏了，重新生成 */ }
    const identity = createIdentity(name, kind);
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(identity, null, 2), 'utf8');
        try { fs.chmodSync(file, 0o600); } catch { /* Windows 上不支持就算了 */ }
    } catch { /* 目录不可写时，身份只活在内存里（本次运行有效） */ }
    return identity;
}
