/**
 * 身份与密码学层（规划 §5.1、§11.3）。
 *
 * 规划对这一层的硬要求：
 *   - 每个用户一组公私钥，公钥或其指纹就是网络身份；昵称可重复，公钥标识唯一。
 *   - 私钥只由用户掌控，绝不上传到任何节点。
 *   - 更换设备要有明确的身份迁移 / 备份恢复方式。
 *   - 钱包不是必须；身份密钥独立于任何加密货币钱包存在。
 *
 * 实现选择：
 *   - Ed25519（Node 内置 node:crypto），不自己造密码算法——规划 §12.5 明确要求。
 *   - 公钥标识 `ed25519:<base64url(32B 原始公钥)>`：self-describing，换算法也不用改解析。
 *   - 指纹 = sha256(原始公钥) 前 16 字节，按 4×8 位分组显示，用于人眼比对。
 *   - 私钥落盘在 <数据目录>/identity.json，权限 0600，原子写。
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';

import { canonicalBytes } from '../shared/canonical.js';
import { IDENTITY_PREFIX, PROTOCOL_VERSION, formatFingerprint, isPublicKeyId } from '../shared/protocol.js';
import { createEncryptionKeys, openSealed, sealFor } from './crypto.js';

const ALGORITHM = 'ed25519';

/** 由 32 字节原始公钥算指纹：sha256 前 16 字节，4 组 8 位。 */
export function fingerprintOfRawPublicKey(rawPublicKey) {
  const digest = createHash('sha256').update(rawPublicKey).digest('hex');
  return formatFingerprint(digest.slice(0, 32));
}

function rawPublicKeyFromJwk(jwk) {
  const raw = Buffer.from(jwk.x, 'base64url');
  if (raw.length !== 32) throw new TypeError(`Ed25519 公钥长度应为 32 字节，实际 ${raw.length}`);
  return raw;
}

/**
 * 生成一组全新的身份密钥。
 *
 * 身份其实有**两套**密钥，用途完全不同，不能互相替代：
 *   Ed25519 —— 签名，证明"这条是谁发的"；公钥标识就是网络身份
 *   X25519  —— 加密，保证"只有收件人能读"；中继节点拿不到它
 * 这和 age / Signal 的做法一致：签名密钥与加密密钥分开。
 */
export function createIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync(ALGORITHM);
  const publicJwk = publicKey.export({ format: 'jwk' });
  const privateJwk = privateKey.export({ format: 'jwk' });
  const raw = rawPublicKeyFromJwk(publicJwk);
  const encryption = createEncryptionKeys();
  return {
    algorithm: ALGORITHM,
    publicKeyId: `${IDENTITY_PREFIX}:${publicJwk.x}`,
    fingerprint: fingerprintOfRawPublicKey(raw),
    /** 只用于本机落盘；任何外发结构里都不得出现这两个字段。 */
    secret: { publicJwk, privateJwk },
    /** 加密密钥对；同样只在本机，绝不上传。 */
    encryption,
  };
}

/**
 * 给旧的身份记录补上加密密钥。
 *
 * 早期版本的身份文件里没有 `encryption` 字段。直接报错会让用户"升级插件之后
 * 身份没了"，而重新生成身份又等于换了一个人。所以这里就地补齐并让调用方落盘 ——
 * 签名身份完全不变，只是多了一套加密密钥。
 */
export function migrateIdentityRecord(record) {
  if (!record || typeof record !== 'object') throw new TypeError('身份记录必须是对象');
  if (record.encryption?.publicKeyId && record.encryption?.secret?.privateJwk) {
    return { record, migrated: false };
  }
  return { record: { ...record, encryption: createEncryptionKeys() }, migrated: true };
}

/**
 * 一个可用的身份句柄：能签名、能验签，但不暴露私钥给调用方。
 * `export()` 是给用户做备份用的显式出口，调用点必须自己承担提示责任。
 */
export class Identity {
  #privateKey;
  #publicKey;
  #record;

  constructor(record) {
    this.#record = record;
    this.#privateKey = createPrivateKey({ key: record.secret.privateJwk, format: 'jwk' });
    this.#publicKey = createPublicKey({ key: record.secret.publicJwk, format: 'jwk' });
  }

  /** 加密公钥标识（x25519:…），可以公开。 */
  get encryptionKeyId() {
    return this.#record.encryption.publicKeyId;
  }

  get publicKeyId() {
    return this.#record.publicKeyId;
  }

  get fingerprint() {
    return this.#record.fingerprint;
  }

  get algorithm() {
    return this.#record.algorithm;
  }

  /** 可安全广播的身份描述（规划 §14「用户身份」）。 */
  describe(profile = {}) {
    return {
      publicKeyId: this.publicKeyId,
      fingerprint: this.fingerprint,
      algorithm: this.algorithm,
      /** 别人要给你发加密消息就需要它。公钥，可以公开。 */
      encryptionKeyId: this.encryptionKeyId,
      nickname: profile.nickname ?? null,
      avatar: profile.avatar ?? null,
      bio: profile.bio ?? null,
    };
  }

  /**
   * 加密给某个接收方（用对方的 x25519 公钥标识）。
   * 中继节点无论如何都解不开 —— 它没有接收方的私钥。
   */
  encryptFor(recipientEncryptionKeyId, value) {
    return sealFor(recipientEncryptionKeyId, value);
  }

  /** 解开一条发给自己的密文；解不开就抛错，不会返回错误内容。 */
  decrypt(sealed) {
    return openSealed(this.#record.encryption.secret, sealed);
  }

  /** 对任意 JSON 值签名；先做稳定序列化，保证两端字节一致。 */
  sign(value) {
    return cryptoSign(null, canonicalBytes(value), this.#privateKey).toString('base64url');
  }

  verify(value, signature) {
    return verifyWithPublicKeyId(this.publicKeyId, value, signature);
  }

  /**
   * 导出身份材料（备份 / 迁移到新设备，规划 §5.1）。
   * 返回值含私钥，调用方必须只在用户明确要求备份时使用，且不得写入日志。
   */
  exportSecret() {
    return JSON.parse(JSON.stringify(this.#record));
  }

  /**
   * 签名的身份文档 —— 让别人在**不信任中继**的前提下拿到你的加密公钥。
   *
   * 为什么必须自签名：中继是陌生人。如果由中继告诉你"B 的加密公钥是 X"，
   * 中继就可以把 X 换成自己的公钥，从而解密你和 B 的全部通信（中间人）。
   * 但只要文档由 B 的 Ed25519 私钥签名，中继就伪造不了 —— 它的能力被限制在
   * "转发或拒绝"，而不是"替换"。
   *
   * 顺带说明中继**做不到**什么：它可以不给、可以给旧的（重放），
   * 所以文档里带 `updatedAt`，接收方应保留最新的一份并提示"密钥变更"。
   */
  document(profile = {}) {
    const body = {
      v: PROTOCOL_VERSION,
      publicKeyId: this.publicKeyId,
      encryptionKeyId: this.encryptionKeyId,
      fingerprint: this.fingerprint,
      nickname: profile.nickname ?? null,
      avatar: profile.avatar ?? null,
      updatedAt: Date.now(),
    };
    return { ...body, sig: this.sign(body) };
  }

  /** 只导出公钥部分，可自由写入任何地方。 */
  exportPublicRecord() {
    return {
      publicKeyId: this.publicKeyId,
      fingerprint: this.fingerprint,
      algorithm: this.algorithm,
      publicJwk: this.#record.secret.publicJwk,
      encryptionKeyId: this.encryptionKeyId,
      encryptionPublicJwk: this.#record.encryption.secret.publicJwk,
    };
  }
}

/** 由已落盘记录构造 Identity。 */
export function identityFromRecord(record) {
  if (!record || typeof record !== 'object') throw new TypeError('身份记录必须是对象');
  if (!isPublicKeyId(record.publicKeyId)) throw new TypeError('身份记录的 publicKeyId 不合法');
  if (!record.secret?.publicJwk || !record.secret?.privateJwk) {
    throw new TypeError('身份记录缺少密钥材料');
  }
  if (!record.encryption?.publicKeyId || !record.encryption?.secret?.privateJwk) {
    throw new TypeError('身份记录缺少加密密钥；应先用 migrateIdentityRecord 补齐');
  }
  return new Identity(record);
}

/** 用任意公钥标识验签。公钥标识自带算法前缀，未知算法一律拒绝而不是猜测。 */
export function verifyWithPublicKeyId(publicKeyId, value, signature) {
  if (!isPublicKeyId(publicKeyId)) return false;
  if (typeof signature !== 'string' || signature.length === 0) return false;
  const [algorithm, encoded] = publicKeyId.split(':');
  if (algorithm !== ALGORITHM) return false;
  let publicKey;
  try {
    publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: encoded }, format: 'jwk' });
  } catch {
    return false;
  }
  let bytes;
  try {
    bytes = canonicalBytes(value);
  } catch {
    return false;
  }
  try {
    return cryptoVerify(null, bytes, publicKey, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

/**
 * 内容哈希（规划 §11.2）：公开内容以内容哈希作为稳定标识。
 * 这里只做「一致性证明」——规划明确写了哈希不代表内容正确，只证明收到的数据和某个哈希匹配。
 */
export function contentHashOf(value) {
  const digest = createHash('sha256').update(canonicalBytes(value)).digest('hex');
  return `${'b3'}:${digest}`;
}

/** 由公钥标识直接算指纹，不需要完整身份记录（用于显示远端节点身份）。 */
export function fingerprintOfPublicKeyId(publicKeyId) {
  if (!isPublicKeyId(publicKeyId)) return null;
  const encoded = publicKeyId.split(':')[1];
  return fingerprintOfRawPublicKey(Buffer.from(encoded, 'base64url'));
}

/**
 * 校验一份身份文档。
 *
 * 返回真实性与「密钥是否被换过」两个独立结论：
 *   authenticity —— 是不是声明的那个签名密钥签的（中继伪造不了）
 *   完整性       —— 字段有没有被改过（签名覆盖全部字段，所以并入 authenticity）
 *   keyChanged   —— 与已知的旧文档相比，加密公钥是否变了
 *
 * `keyChanged` 必须单独报出来：密钥变更可能是正常的换设备，也可能是中间人攻击，
 * 只有用户能判断，所以不能静默接受。
 */
export function verifyIdentityDocument(doc, { known = null } = {}) {
  const problems = [];
  if (!doc || typeof doc !== 'object') return { valid: false, keyChanged: false, problems: ['not-an-object'] };
  if (doc.v !== PROTOCOL_VERSION) problems.push(`protocol-mismatch:${String(doc.v)}`);
  if (!isPublicKeyId(doc.publicKeyId)) problems.push('bad-public-key-id');
  if (typeof doc.encryptionKeyId !== 'string' || !doc.encryptionKeyId.startsWith('x25519:')) {
    problems.push('bad-encryption-key-id');
  }

  const { sig, ...body } = doc;
  const valid = typeof sig === 'string' && verifyWithPublicKeyId(doc.publicKeyId, body, sig);
  if (!valid) problems.push('signature-invalid');

  const keyChanged = Boolean(known?.encryptionKeyId)
    && known.encryptionKeyId !== doc.encryptionKeyId;
  if (keyChanged) problems.push('encryption-key-changed');

  return { valid, keyChanged, problems, doc };
}
