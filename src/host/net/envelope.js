/**
 * 网络信封：签名、验签、去重、重放防护（规划 §9.5、§10.4）。
 *
 * 规划 §9.5 列了一串防滥用要求，这里逐条落实：
 *   用数字签名验证消息发布者身份 → `sig`
 *   对消息设置序号、时间信息、重复消息检测 → `seq` / `time` / `#seen`
 *   允许内容消费者验证哈希、签名和版本 → `v` + verify()
 *
 * 信封结构（`sig` 之外的所有字段参与签名）：
 *   v      协议版本
 *   id     信封唯一标识（去重键）
 *   kind   MESSAGE_KIND 之一
 *   from   发送方公钥标识
 *   to     目标公钥标识，null 表示广播
 *   seq    发送方视角的单调序号，用于发现空洞
 *   time   发送时刻（毫秒）
 *   payload 业务载荷
 *   sig    对上面各项的 Ed25519 签名
 *
 * 一个刻意的取舍：**这里不做加密。** 规划 §5.3 要求私聊用成熟端到端加密方案，
 * 而 MVP 阶段（规划 §15 阶段 1）只做「一对一文字消息」且默认只在本地/局域网验证。
 * 所以本层保证的是**真实性与完整性**，不保证机密性；私聊载荷的加密位
 * （`payload.crypto`）先留在协议里，避免以后加加密时要改信封格式。
 */
import { MESSAGE_KIND, PROTOCOL_VERSION, isPublicKeyId, randomId } from '../../shared/protocol.js';
import { verifyWithPublicKeyId } from '../identity.js';

export const REJECT_REASON = Object.freeze({
  MALFORMED: 'malformed',
  VERSION: 'protocol-version-mismatch',
  DUPLICATE: 'duplicate',
  BAD_SIGNATURE: 'signature-invalid',
  SENDER_MISMATCH: 'sender-mismatch',
  CLOCK_SKEW: 'clock-skew',
  NOT_FOR_ME: 'not-for-me',
});

/** 参与签名的字段（`sig` 自身除外）。顺序无关——签名前会做稳定序列化。 */
function signingBody(envelope) {
  return {
    v: envelope.v,
    id: envelope.id,
    kind: envelope.kind,
    from: envelope.from,
    to: envelope.to,
    seq: envelope.seq,
    time: envelope.time,
    payload: envelope.payload,
  };
}

export class EnvelopeCodec {
  #identity;
  #logger;
  #clockSkewMs;
  #seen = new Set();
  #seenOrder = [];
  #dedupeLimit;
  #sendSeq = 0;
  #metrics = {
    sealed: 0, opened: 0, rejected: 0,
    byReason: Object.create(null),
  };

  constructor({
    identity,
    logger = null,
    /** 允许的时钟偏差。规划 §14 明确要求考虑「节点间的时钟偏差」。 */
    clockSkewMs = 5 * 60 * 1000,
    dedupeLimit = 4096,
  }) {
    this.#identity = identity;
    this.#logger = logger;
    this.#clockSkewMs = clockSkewMs;
    this.#dedupeLimit = dedupeLimit;
  }

  get metrics() {
    return { ...this.#metrics, byReason: { ...this.#metrics.byReason } };
  }

  get nextSeq() {
    return this.#sendSeq + 1;
  }

  /** 构造并签名一个信封。 */
  seal(kind, payload, { to = null, now = Date.now() } = {}) {
    if (!Object.values(MESSAGE_KIND).includes(kind)) {
      throw new TypeError(`未知信封类型: ${kind}`);
    }
    if (to !== null && !isPublicKeyId(to)) {
      throw new TypeError(`to 必须是公钥标识或 null，收到: ${String(to)}`);
    }
    this.#sendSeq += 1;
    const envelope = {
      v: PROTOCOL_VERSION,
      id: randomId('env'),
      kind,
      from: this.#identity.publicKeyId,
      to,
      seq: this.#sendSeq,
      time: now,
      payload,
    };
    envelope.sig = this.#identity.sign(signingBody(envelope));
    this.#metrics.sealed += 1;
    return envelope;
  }

  /** 只构造不签名/不推进序号，纯粹用于测试与畸形输入验证。 */
  static buildRaw(fields) {
    return { ...fields };
  }

  #reject(reason, detail = {}) {
    this.#metrics.rejected += 1;
    this.#metrics.byReason[reason] = (this.#metrics.byReason[reason] ?? 0) + 1;
    if (this.#logger) this.#logger.debug?.(`信封被拒: ${reason}`, detail);
    return { ok: false, reason, detail };
  }

  /**
   * 校验并打开一个信封。
   * @returns {{ok: true, envelope: object, payload: unknown} | {ok: false, reason: string, detail?: object}}
   */
  open(envelope, { now = Date.now(), expectFrom = null } = {}) {
    if (!envelope || typeof envelope !== 'object') return this.#reject(REJECT_REASON.MALFORMED);

    const { v, id, kind, from, to, seq, time, sig } = envelope;
    if (typeof id !== 'string' || id.length === 0) return this.#reject(REJECT_REASON.MALFORMED, { field: 'id' });
    if (typeof kind !== 'string' || !Object.values(MESSAGE_KIND).includes(kind)) {
      return this.#reject(REJECT_REASON.MALFORMED, { field: 'kind', kind });
    }
    if (!isPublicKeyId(from)) return this.#reject(REJECT_REASON.MALFORMED, { field: 'from' });
    if (to !== null && to !== undefined && !isPublicKeyId(to)) {
      return this.#reject(REJECT_REASON.MALFORMED, { field: 'to' });
    }
    if (!Number.isInteger(seq) || seq < 0) return this.#reject(REJECT_REASON.MALFORMED, { field: 'seq' });
    if (typeof time !== 'number' || !Number.isFinite(time)) {
      return this.#reject(REJECT_REASON.MALFORMED, { field: 'time' });
    }
    if (typeof sig !== 'string' || sig.length === 0) return this.#reject(REJECT_REASON.MALFORMED, { field: 'sig' });

    // 版本先于签名检查：我们无法验证一个语义未知的对象的签名是否"正确"。
    if (v !== PROTOCOL_VERSION) return this.#reject(REJECT_REASON.VERSION, { got: v, expected: PROTOCOL_VERSION });

    if (expectFrom !== null && from !== expectFrom) {
      return this.#reject(REJECT_REASON.SENDER_MISMATCH, { expected: expectFrom, got: from });
    }

    // 去重先于验签：重复消息是最常见的情况，验签是这里最贵的一步。
    if (this.#seen.has(id)) return this.#reject(REJECT_REASON.DUPLICATE, { id });

    const skew = Math.abs(now - time);
    if (skew > this.#clockSkewMs) {
      return this.#reject(REJECT_REASON.CLOCK_SKEW, { skewMs: skew, allowed: this.#clockSkewMs });
    }

    if (!verifyWithPublicKeyId(from, signingBody(envelope), sig)) {
      return this.#reject(REJECT_REASON.BAD_SIGNATURE, { id, from });
    }

    // 目标过滤：不是发给我的单播就丢掉（但仍已去重，避免同一条被反复验签）。
    if (to !== null && to !== undefined && to !== this.#identity.publicKeyId) {
      this.#remember(id);
      return this.#reject(REJECT_REASON.NOT_FOR_ME, { to });
    }

    this.#remember(id);
    this.#metrics.opened += 1;
    return { ok: true, envelope, payload: envelope.payload };
  }

  /** 有界去重集合：超过上限丢最早的一半，内存不随会话时长增长。 */
  #remember(id) {
    this.#seen.add(id);
    this.#seenOrder.push(id);
    if (this.#seenOrder.length > this.#dedupeLimit) {
      const drop = this.#seenOrder.splice(0, Math.floor(this.#dedupeLimit / 2));
      for (const item of drop) this.#seen.delete(item);
    }
  }

  /** 某个 id 是否已经见过（测试用）。 */
  hasSeen(id) {
    return this.#seen.has(id);
  }

  get seenCount() {
    return this.#seen.size;
  }
}
