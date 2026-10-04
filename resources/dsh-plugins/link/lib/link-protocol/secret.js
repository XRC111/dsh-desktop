/**
 * DSH 远程联动 —— 机密载荷的封装。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * 「共用模型」意味着桌面要把 LLM 配置（含 **API Key**）交给手机。而这条链路是
 * 局域网明文 TCP + 一个配对令牌 —— 令牌只能阻止「不知道令牌的人连上来」，
 * 挡不住同网段的被动嗅探。
 *
 * ── 做法 ────────────────────────────────────────────────────────────────────
 * 握手时双方各生成一对**临时** ECDH 密钥（P-256），互送公钥，各自用
 * ECDH + HKDF-SHA256 派生出同一个会话密钥。只有**机密字段**（凭据、令牌）
 * 用这个密钥 AES-256-GCM 封装后再进帧；普通消息仍是明文 —— 它们本来就要
 * 出现在界面和日志里，加密只会让排障变难。
 *
 * 这样做的性质：
 *   ✅ 被动嗅探拿不到 API Key（ECDH 保证前向安全，握手后换密钥即失效）
 *   ✅ 篡改载荷会在 GCM 校验处失败
 *   ❌ **不防中间人**：hello/welcome 里的公钥本身没有签名，能劫持链路的攻击者
 *      可以各换一把。要挡它需要预共享指纹或带外校验，对「同一局域网内自己
 *      的两台设备」这个场景性价比太低。所以界面文案不该说「端到端加密」，
 *      而应该说「凭据加密传输」。
 *
 * ── 临时私钥的生命周期 ──────────────────────────────────────────────────────
 * 私钥只活在内存里、只在这次连接内有效，断开即弃。**不要落盘** —— 落盘的
 * 长期私钥会让「前向安全」这个性质消失。
 */

import { createECDH, createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/** 曲线固定 P-256：Node 全平台可用，且两边都是同一份 Node。 */
const CURVE = 'prime256v1';

/** 从 ECDH 共享密钥派生出用于 AES 的 32 字节密钥。 */
const HKDF_INFO = Buffer.from('dsh-link/v1/session-key', 'utf8');

/**
 * 生成一对临时 ECDH 密钥。
 * @returns {{publicKey: string, privateKey: Buffer}} 公钥（base64，待发给对端）与私钥。
 */
export function makeEphemeralKeyPair() {
    const ecdh = createECDH(CURVE);
    ecdh.generateKeys();
    return {
        publicKey: ecdh.getPublicKey().toString('base64'),
        privateKey: ecdh.getPrivateKey(),
    };
}

/**
 * 用本端私钥与对端公钥派生出会话密钥。
 * @param {Buffer} privateKey - 本端私钥。
 * @param {string} peerPublicKey - 对端公钥（base64）。
 * @returns {Buffer} 32 字节会话密钥。
 */
export function deriveSessionKey(privateKey, peerPublicKey) {
    const ecdh = createECDH(CURVE);
    ecdh.setPrivateKey(privateKey);
    const shared = ecdh.computeSecret(Buffer.from(peerPublicKey, 'base64'));
    // HKDF 而不是直接用共享密钥：ECDH 输出是曲线上的一点，不是均匀分布的密钥材料。
    return Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), HKDF_INFO, 32));
}

/**
 * 封装一个 JSON 可序列化的值。
 * @param {Buffer} key - 会话密钥。
 * @param {any} value - 待封装的值。
 * @returns {string} base64(nonce[12] | tag[16] | ciphertext)。
 */
export function seal(key, value) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), 'utf8')), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ct]).toString('base64');
}

/**
 * 解开 seal() 的封装。
 * @param {Buffer} key - 会话密钥。
 * @param {string} box - seal() 的产物。
 * @returns {any} 原值；密钥不对或载荷被改动时抛错。
 */
export function open(key, box) {
    const raw = Buffer.from(box, 'base64');
    const nonce = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
}

/**
 * 把机密字段列表从对象里摘出来单独封装。
 *
 * 这样「哪些字段是敏感的」是**显式声明**的，而不是靠字段名猜 ——
 * 漏掉一个字段就等于把它明文发出去。
 *
 * @param {Buffer} key - 会话密钥。
 * @param {object} value - 原始对象。
 * @param {string[]} secretFields - 需要封装的字段名。
 * @returns {{public: object, secret: string|null}} 明文部分与封装的机密部分。
 */
export function splitSecrets(key, value, secretFields) {
    const pub = { ...value };
    const secret = {};
    let any = false;
    for (const f of secretFields) {
        if (pub[f] !== undefined) {
            secret[f] = pub[f];
            delete pub[f];
            any = true;
        }
    }
    return { public: pub, secret: any ? seal(key, secret) : null };
}

/**
 * splitSecrets() 的逆操作。
 * @param {Buffer} key - 会话密钥。
 * @param {object} pub - 明文部分。
 * @param {string|null} box - 封装的机密部分。
 * @returns {object} 合并后的对象。
 */
export function mergeSecrets(key, pub, box) {
    if (!box) return { ...pub };
    return { ...pub, ...open(key, box) };
}
