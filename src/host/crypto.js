/**
 * 端到端加密（规划 §5.3「私聊内容应使用成熟的端到端加密方案，不自行设计密码算法」）。
 *
 * ## 为什么中继功能必须先有这个
 *
 * 规划 §5.3 明确要求：**中继节点原则上只转发密文，不应拥有读取私聊正文的权限**。
 * 如果没有加密就做中继，那个中继就是一个明文的转发器 —— 用户的每一句话都会
 * 原样经过一台陌生人的机器。那不是"隐私弱一点"，那是规划里被点名禁止的做法。
 *
 * 所以中继之前先补加密：**中继在协议层就无法解密**，不是"我们承诺不看"。
 *
 * ## 用的是标准构件，不是自创算法
 *
 *   X25519     密钥协商（Node 内置）
 *   HKDF-SHA256 从共享秘密导出对称密钥
 *   AES-256-GCM 认证加密（自带完整性）
 *
 * 组合方式是标准的 ECIES：每条消息用一个临时密钥对，
 * `shared = ECDH(临时私钥, 接收方公钥)` → HKDF → AES-GCM。
 * 于是：
 *   - 只有接收方能解开（中继没有接收方私钥）；
 *   - **每条消息前向保密**（临时密钥用完即弃，长期私钥泄露也解不开历史消息）；
 *   - GCM 自带认证，篡改密文会在解密时失败，而不是解出错误内容。
 *
 * ## 与签名的分工（两件事，别混）
 *
 *   签名（Ed25519）→ 证明"这条是谁发的"，全体可见、可被中继校验（用于反垃圾）
 *   加密（X25519）→ 保证"只有收件人能读"，中继无法解开
 *
 * 二者互相独立：加密不等于真实，签名也不等于保密。规划 §6.4 对哈希说过类似的话，
 * 这里同样成立。
 */

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

import { canonicalBytes } from '../shared/canonical.js';

const CURVE = 'x25519';
const ENCRYPTION_PREFIX = 'x25519';
const VERSION = 1;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
/** HKDF 的 info：把密钥绑定到具体用途，避免同一份共享秘密在不同场景下导出同一个密钥。 */
const HKDF_INFO = Buffer.from('dsh-chat/e2e/v1');

/** 生成一对 X25519 加密密钥（与 Ed25519 签名密钥是两套，互不替代）。 */
export function createEncryptionKeys() {
  const { publicKey, privateKey } = generateKeyPairSync(CURVE);
  const publicJwk = publicKey.export({ format: 'jwk' });
  const privateJwk = privateKey.export({ format: 'jwk' });
  return {
    publicKeyId: `${ENCRYPTION_PREFIX}:${publicJwk.x}`,
    secret: { publicJwk, privateJwk },
  };
}

/** 加密公钥标识是否合法。 */
export function isEncryptionKeyId(value) {
  return typeof value === 'string' && /^x25519:[A-Za-z0-9_-]{43}$/.test(value);
}

function publicKeyFromId(publicKeyId) {
  if (!isEncryptionKeyId(publicKeyId)) throw new TypeError(`非法的加密公钥标识: ${String(publicKeyId)}`);
  return createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: publicKeyId.split(':')[1] },
    format: 'jwk',
  });
}

function privateKeyFromJwk(jwk) {
  return createPrivateKey({ key: jwk, format: 'jwk' });
}

/** ECDH → HKDF，得到 32 字节对称密钥。 */
function deriveKey(sharedSecret, salt) {
  return Buffer.from(hkdfSync('sha256', sharedSecret, salt, HKDF_INFO, KEY_BYTES));
}

/**
 * 把一段内容加密给指定的接收方。
 *
 * @param {string} recipientPublicKeyId 接收方的 x25519 公钥标识
 * @param {unknown} value 任意 JSON 值
 * @returns {{v: number, epk: string, salt: string, nonce: string, ct: string, tag: string}}
 *   全部字段都是字符串或数字，可直接塞进信封的 payload 里。
 */
export function sealFor(recipientPublicKeyId, value) {
  const recipient = publicKeyFromId(recipientPublicKeyId);

  // 每条消息一个临时密钥对：这是前向保密的来源。
  const ephemeral = generateKeyPairSync(CURVE);
  const ephemeralJwk = ephemeral.publicKey.export({ format: 'jwk' });
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });

  // 盐里绑上收发双方的公钥，避免同一对密钥在其它上下文里导出同样的密钥。
  const salt = Buffer.concat([
    Buffer.from(ephemeralJwk.x, 'base64url'),
    Buffer.from(recipientPublicKeyId.split(':')[1], 'base64url'),
  ]);
  const key = deriveKey(shared, salt);
  const nonce = randomBytes(NONCE_BYTES);

  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const plaintext = Buffer.from(canonicalBytes(value));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    v: VERSION,
    /** 临时公钥：接收方用它 + 自己的私钥算出同一个共享秘密。 */
    epk: ephemeralJwk.x,
    salt: salt.toString('base64url'),
    nonce: nonce.toString('base64url'),
    ct: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  };
}

/**
 * 解开一条发给自己（或本机身份）的密文。
 * 密文被改动、或不是发给自己的，都会抛错而不是返回错误内容。
 */
export function openSealed(recipientSecret, sealed) {
  if (!sealed || typeof sealed !== 'object') throw new TypeError('密文对象缺失');
  if (sealed.v !== VERSION) throw new TypeError(`不支持的密文版本: ${String(sealed.v)}`);
  for (const field of ['epk', 'salt', 'nonce', 'ct', 'tag']) {
    if (typeof sealed[field] !== 'string') throw new TypeError(`密文缺少字段: ${field}`);
  }

  const ephemeral = createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: sealed.epk },
    format: 'jwk',
  });
  const shared = diffieHellman({
    privateKey: privateKeyFromJwk(recipientSecret.privateJwk),
    publicKey: ephemeral,
  });

  const salt = Buffer.from(sealed.salt, 'base64url');
  const key = deriveKey(shared, salt);
  const nonce = Buffer.from(sealed.nonce, 'base64url');

  // 盐被改动会在 HKDF 之后才体现为 GCM 认证失败，仍然是 fail-closed。
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(sealed.ct, 'base64url')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8'));
}

/** 一个对象看起来是否像本模块产出的密文。 */
export function isSealedPayload(value) {
  return Boolean(
    value && typeof value === 'object'
    && value.v === VERSION
    && typeof value.epk === 'string'
    && typeof value.ct === 'string'
    && typeof value.nonce === 'string'
    && typeof value.tag === 'string'
    && typeof value.salt === 'string',
  );
}

export { ENCRYPTION_PREFIX, VERSION as CRYPTO_VERSION };
