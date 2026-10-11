/**
 * 会话分享与复用（规划 §6）。
 *
 * 规划 §6.4 列出一个分享对象必须有的字段，这里逐项落实：
 *   唯一内容标识 → `id`（内容哈希）
 *   作者公钥      → `author.publicKeyId` / `author.fingerprint`
 *   版本号        → `version`
 *   可公开片段    → `items[]`（每项自带 kind / seq / 哈希）
 *   完整性摘要    → `merkleRoot`（items 的证据根）
 *   作者签名      → `sig`
 *   访问策略      → `policy`（scope / expiresAt / copyable）
 *   生成时间      → `createdAt`，另带 `protocol` 兼容信息与 `tags`
 *
 * 关于「内容哈希只能证明一致性，不能证明真实性」——规划 §6.4 特意写了这句，
 * 所以在 verify() 的返回值里 `integrity` 与 `authenticity` 是**两个独立的结论**，
 * 不合并成一个 valid 布尔值，免得调用方把「没被篡改」误读成「内容可信」。
 */
import { ACCESS_SCOPE, CONTENT_KINDS, PROTOCOL_VERSION, isAccessScope } from '../shared/protocol.js';
import { contentHashOf, verifyWithPublicKeyId } from './identity.js';

export class ShareError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ShareError';
    this.code = detail.code ?? 'dsh-chat/share-error';
    this.detail = detail;
  }
}

/**
 * 二叉 Merkle 根（规划 §11.2：对大型内容可研究分块哈希或 Merkle 结构）。
 *
 * 奇数个节点时把最后一个复制一份，这是最常见的构造，避免出现「单子节点提升」这类
 * 让不同实现算出不同根的歧义。空列表的根固定为空串哈希，不是 undefined——
 * 否则「空分享」和「字段缺失」在验收时会混在一起。
 */
export function merkleRoot(hashes) {
  if (!Array.isArray(hashes) || hashes.length === 0) return contentHashOf([]);
  let level = [...hashes];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      next.push(contentHashOf([left, right]));
    }
    level = next;
  }
  return level[0];
}

/** 一条会话事件 → 一个分享条目。返回 null 表示这条不该分享。 */
export function toShareItem(record, allowedKinds) {
  if (record.contentKind === null) return null;
  if (!allowedKinds.includes(record.contentKind)) return null;
  const item = {
    kind: record.contentKind,
    sessionSeq: record.seq,
    eventType: record.type,
    at: record.time,
    text: record.text ?? '',
  };
  // 条目自己的内容标识：任何一条被改动，它的哈希和 Merkle 根都会变。
  item.contentId = contentHashOf(item);
  return item;
}

/**
 * 参与签名的部分：去掉 `sig` 自身。
 * `id` **要**参与签名——否则别人可以改掉 id 而签名依然有效。
 */
function signingBody(share) {
  const { sig, ...rest } = share;
  return rest;
}

/**
 * 参与「内容标识」计算的部分：同时去掉 `sig` 和 `id`。
 *
 * 为什么 id 不能参与自己的哈希：`id = hash(内容)` 是一个自指定义。
 * 如果把 id 也算进去，校验时重算的哈希永远和 id 不相等（这正是第一版实现踩的坑）。
 * 所以约定是：**id 是「除 id 与 sig 之外全部字段」的哈希，sig 覆盖「除 sig 之外全部字段」。**
 * 两者分工明确：id 证明内容没被改，sig 证明整条（含 id）确实出自该作者。
 */
function hashingBody(share) {
  const { id, sig, ...rest } = share;
  return rest;
}

/**
 * 分享对象登记表。
 *
 * 刻意不做「版本历史 + 订阅同步」的完整实现（规划 §6.6 把它们放在第一版之后），
 * 但 `version` 与 `supersedes` 字段先留着，这样以后加订阅不需要改数据格式——
 * 规划 §14 明确要求「数据协议需考虑版本兼容」。
 */
export class ShareRegistry {
  #config;
  #identity;
  #consent;
  #redaction;
  #logger;
  #profile;
  #shares = new Map();
  #listeners = new Set();
  #readEvents;
  /**
   * 本机侧索引：分享 id → 源会话 id。
   *
   * 刻意**不**放进分享对象里。会话 id 是本机的稳定标识，放进外发对象就等于把
   * 「哪些分享出自同一条会话 / 同一个人」这条关联线索送给所有缓存节点。
   * 而「复制为新会话」只需要作者本机能反查，所以留在本地一份映射就够了。
   */
  #sourceSessions = new Map();
  #sourceIndex;

  constructor({
    config, identity, consent, redaction, logger = null, profile = () => ({}),
    /** (sessionId) => Promise<ledgerRecord[]>；由 Host 注入，避免本模块直接依赖 DSH。 */
    readEvents = async () => [],
    /** 本地侧索引的落盘位置（JsonDocument）。 */
    sourceIndex = null,
  }) {
    this.#config = config;
    this.#identity = identity;
    this.#consent = consent;
    this.#redaction = redaction;
    this.#logger = logger;
    this.#profile = profile;
    this.#readEvents = readEvents;
    this.#sourceIndex = sourceIndex;
    const stored = sourceIndex?.read?.() ?? {};
    for (const [shareId, sessionId] of Object.entries(stored)) {
      this.#sourceSessions.set(shareId, sessionId);
    }
  }

  /** 反查某个分享的源会话（仅本机有；远端分享返回 null）。 */
  sourceSessionOf(id) {
    return this.#sourceSessions.get(id) ?? null;
  }

  onPublish(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify() {
    for (const listener of this.#listeners) {
      try {
        listener(this.list());
      } catch {
        // 订阅者异常不影响发布流程。
      }
    }
  }

  /**
   * 创建一个分享对象。
   *
   * 前置条件：该会话必须已经通过 consent 授权。
   * 本方法**不**自己授权——「分享」这个用户动作由界面触发 authorize，再调用 create，
   * 和直播保持一致，避免出现「只做了半步」的状态。
   */
  async create(sessionId, {
    title = '',
    scope = ACCESS_SCOPE.SELF,
    mode = null,
    contentKinds = null,
    tags = [],
    expiresInMs = 0,
    copyable = false,
    previewed = false,
  } = {}) {
    if (!isAccessScope(scope)) throw new ShareError(`未知访问范围: ${scope}`, { code: 'dsh-chat/bad-scope' });

    const grant = this.#consent.authorize(sessionId, {
      mode, contentKinds, scope, ttlMs: expiresInMs > 0 ? expiresInMs : undefined,
      previewed, reason: 'share-create',
    });

    const records = await this.#readEvents(sessionId);
    const items = [];
    for (const record of records) {
      const item = toShareItem(record, grant.contentKinds);
      if (!item) continue;

      // 逐条过脱敏；任一条被扣下就跳过它，而不是整单失败。
      // 理由：一条含密钥的回答不该让用户整个分享都发不出去，但那条绝对不能出去。
      const redacted = this.#redaction.apply(item);
      if (redacted.withheld) {
        this.#logger?.warn?.('分享条目被扣下（脱敏未通过）', { sessionId, seq: item.sessionSeq, reasons: redacted.reasons });
        continue;
      }
      items.push(redacted.value);
    }

    if (items.length === 0) {
      throw new ShareError('没有任何可分享的内容（可能全部未勾选或全部被脱敏规则扣下）', {
        code: 'dsh-chat/empty-share', sessionId,
      });
    }

    const profile = this.#profile();
    const share = {
      protocol: PROTOCOL_VERSION,
      version: 1,
      supersedes: null,
      title: typeof title === 'string' && title.trim() ? title.trim() : '未命名会话分享',
      tags: Array.isArray(tags) ? tags.filter((t) => typeof t === 'string' && t.trim()).slice(0, 8) : [],
      author: {
        publicKeyId: this.#identity.publicKeyId,
        fingerprint: this.#identity.fingerprint,
        nickname: profile.nickname ?? null,
        avatar: profile.avatar ?? null,
      },
      createdAt: Date.now(),
      policy: {
        scope: grant.scope,
        mode: grant.mode,
        contentKinds: [...grant.contentKinds],
        copyable: copyable === true,
        /** 规划 §6.2：撤销能阻止未来访问新副本，但不能收回已下载的明文。 */
        expiresAt: expiresInMs > 0 ? Date.now() + expiresInMs : null,
      },
      itemCount: items.length,
      items,
      merkleRoot: merkleRoot(items.map((item) => item.contentId)),
      /** 明确标注：本对象未包含任何工具执行权限或本地路径。 */
      disclosure: {
        containsPaths: false,
        containsToolResults: grant.contentKinds.includes('tool'),
        containsAttachments: grant.contentKinds.includes('attachment'),
        note: '仅包含作者显式勾选并经脱敏的会话内容片段。',
      },
    };

    share.id = contentHashOf(hashingBody(share));
    share.sig = this.#identity.sign(signingBody(share));

    this.#shares.set(share.id, share);
    this.#sourceSessions.set(share.id, sessionId);
    this.#sourceIndex?.write?.(Object.fromEntries(this.#sourceSessions));
    this.#logger?.info?.('已创建分享对象', {
      id: share.id, sessionId, scope: share.policy.scope, items: share.itemCount,
    });
    this.#notify();
    return share;
  }

  /**
   * 校验一个（可能来自远端的）分享对象。
   *
   * 返回两个独立结论，别合并：
   *   integrity   —— 内容有没有被改过（重算哈希 + Merkle 根）
   *   authenticity—— 是不是声明的那个密钥签的
   * 规划 §6.4：两者都为真，也不代表内容真实、正确或安全。
   */
  verify(share) {
    const problems = [];
    if (!share || typeof share !== 'object') {
      return { integrity: false, authenticity: false, problems: ['not-an-object'] };
    }
    if (share.protocol !== PROTOCOL_VERSION) problems.push(`protocol-mismatch:${String(share.protocol)}`);

    // 1) 重算条目哈希与 Merkle 根。
    let integrityOk = true;
    if (!Array.isArray(share.items)) {
      integrityOk = false;
      problems.push('items-missing');
    } else {
      for (const item of share.items) {
        const { contentId, ...rest } = item ?? {};
        if (contentId !== contentHashOf(rest)) {
          integrityOk = false;
          problems.push(`item-tampered:${String(item?.sessionSeq)}`);
          break;
        }
      }
      if (integrityOk) {
        const recomputed = merkleRoot(share.items.map((item) => item.contentId));
        if (recomputed !== share.merkleRoot) {
          integrityOk = false;
          problems.push('merkle-root-mismatch');
        }
      }
      if (share.itemCount !== share.items.length) {
        integrityOk = false;
        problems.push('item-count-mismatch');
      }
    }

    // 2) 重算对象 id：id 定义为「除 id 与 sig 之外全部字段」的哈希。
    if (typeof share.id === 'string') {
      const expectedId = contentHashOf(hashingBody(share));
      if (expectedId !== share.id) {
        integrityOk = false;
        problems.push('object-id-mismatch');
      }
    } else {
      integrityOk = false;
      problems.push('id-missing');
    }

    // 3) 验签。
    const publicKeyId = share.author?.publicKeyId;
    const authenticity = typeof share.sig === 'string' && typeof publicKeyId === 'string'
      ? verifyWithPublicKeyId(publicKeyId, signingBody(share), share.sig)
      : false;
    if (!authenticity) problems.push('signature-invalid');

    return { integrity: integrityOk, authenticity, problems, id: share.id ?? null };
  }

  get(id) {
    return this.#shares.get(id) ?? null;
  }

  list() {
    return [...this.#shares.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((share) => ({
        id: share.id,
        title: share.title,
        author: share.author,
        createdAt: share.createdAt,
        scope: share.policy.scope,
        mode: share.policy.mode,
        itemCount: share.itemCount,
        tags: share.tags,
      }));
  }

  /** 撤销：移除本地副本并让分享列表不再暴露它（规划 §6.2 的「撤销」语义）。 */
  revoke(id, reason = 'user-action') {
    const share = this.#shares.get(id);
    if (!share) return false;
    this.#shares.delete(id);
    this.#logger?.info?.('分享已撤销', { id, reason, revokedAt: new Date().toISOString() });
    this.#notify();
    return true;
  }

  /** 导入一个来自远端的分享对象（只接受通过校验的）。 */
  import(share) {
    const verdict = this.verify(share);
    if (!verdict.integrity || !verdict.authenticity) return { accepted: false, verdict };
    this.#shares.set(share.id, share);
    this.#notify();
    return { accepted: true, verdict };
  }

  /** 供界面用的摘要统计。 */
  get metrics() {
    return {
      count: this.#shares.size,
      byScope: [...this.#shares.values()].reduce((acc, share) => {
        acc[share.policy.scope] = (acc[share.policy.scope] ?? 0) + 1;
        return acc;
      }, {}),
    };
  }
}

export { ACCESS_SCOPE, CONTENT_KINDS, hashingBody, signingBody };
