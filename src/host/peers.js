/**
 * 好友与关注（规划 §5.2）。
 *
 * 规划把这两件事明确区分开：
 *   - **好友**需要双方确认。申请是一条带签名的请求对象，接收方校验来源后再决定。
 *   - **关注**不需要对方同意，用于订阅创作者和公开动态。
 *
 * 规划还特别提醒了可用性边界：「没有在线接收方或可用托管节点时，不能保证即时送达」。
 * 所以这里把「申请」建模成**本地状态 + 尽最大努力送达**：
 * 对方离线时申请留在自己的待发队列里（草稿态），而不是假装已经送达。
 * 界面上「已发出，等待对方上线」和「对方已收到，等待确认」是两种不同的展示。
 */
import { MESSAGE_KIND, isPublicKeyId } from '../shared/protocol.js';

export const RELATION = Object.freeze({
  NONE: 'none',
  OUTGOING: 'outgoing',
  INCOMING: 'incoming',
  FRIEND: 'friend',
  FOLLOWING: 'following',
  BLOCKED: 'blocked',
});

/** 申请投递状态。区分「已写本地」与「对端确认收到」，避免界面说谎。 */
export const DELIVERY = Object.freeze({
  DRAFT: 'draft',
  SENT: 'sent',
  ACKNOWLEDGED: 'acknowledged',
});

export class PeerBook {
  #config;
  #identity;
  #logger;
  #document;
  #listeners = new Set();
  /** 传输层报上来的在线节点：publicKeyId → { fingerprint, nickname, address, lastSeen } */
  #online = new Map();
  #state;

  constructor({ config, identity, logger = null, document = null }) {
    this.#config = config;
    this.#identity = identity;
    this.#logger = logger;
    this.#document = document;
    this.#state = document?.read() ?? { relations: {}, requests: {} };
    if (!this.#state.relations) this.#state.relations = {};
    if (!this.#state.requests) this.#state.requests = {};
  }

  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #persist() {
    this.#document?.write(this.#state);
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // 界面订阅者异常不影响关系状态。
      }
    }
  }

  #requireKey(key, label = '公钥标识') {
    if (!isPublicKeyId(key)) throw new TypeError(`${label}不合法: ${String(key)}`);
    if (key === this.#identity.publicKeyId) throw new TypeError('不能对自己执行该操作');
  }

  /** 传输层握手成功时调用。 */
  markOnline(peer) {
    this.#online.set(peer.peerKey, {
      fingerprint: peer.fingerprint ?? null,
      nickname: peer.nickname ?? null,
      address: peer.address ?? null,
      lastSeen: Date.now(),
    });
    this.#persist();
  }

  markOffline(peerKey) {
    if (this.#online.delete(peerKey)) this.#persist();
  }

  isOnline(key) {
    return this.#online.has(key);
  }

  /** 发出好友申请。注意这只是本地记录 + 待发消息，不代表对方已收到。 */
  requestFriend(key, { note = '', delivered = false } = {}) {
    this.#requireKey(key, '好友申请目标');
    if (this.#state.relations[key] === RELATION.BLOCKED) {
      throw new Error('已拉黑该身份，需先解除拉黑');
    }
    this.#state.relations[key] = RELATION.OUTGOING;
    this.#state.requests[key] = {
      direction: 'outgoing',
      note: typeof note === 'string' ? note.slice(0, 200) : '',
      at: Date.now(),
      delivery: delivered ? DELIVERY.SENT : DELIVERY.DRAFT,
    };
    this.#logger?.info?.('已发出好友申请', { to: key, delivered });
    this.#persist();
    return this.describe(key);
  }

  /** 记录收到的好友申请（来自网络）。 */
  receiveFriendRequest(key, { note = '' } = {}) {
    this.#requireKey(key, '好友申请来源');
    if (this.#state.relations[key] === RELATION.BLOCKED) return null;
    if (this.#state.relations[key] === RELATION.FRIEND) return this.describe(key);
    this.#state.relations[key] = RELATION.INCOMING;
    this.#state.requests[key] = {
      direction: 'incoming',
      note: typeof note === 'string' ? note.slice(0, 200) : '',
      at: Date.now(),
      delivery: DELIVERY.ACKNOWLEDGED,
    };
    this.#logger?.info?.('收到好友申请', { from: key });
    this.#persist();
    return this.describe(key);
  }

  /** 接受好友申请（规划 §5.2：需要双方确认）。 */
  acceptFriend(key) {
    this.#requireKey(key, '好友目标');
    this.#state.relations[key] = RELATION.FRIEND;
    const request = this.#state.requests[key];
    if (request) request.resolvedAt = Date.now();
    this.#logger?.info?.('已成为好友', { with: key });
    this.#persist();
    return this.describe(key);
  }

  /** 拒绝（保留记录但不建立关系）。 */
  rejectFriend(key) {
    this.#requireKey(key, '好友目标');
    if (this.#state.relations[key] === RELATION.FRIEND) {
      throw new Error('已经是好友；请用删除好友');
    }
    this.#state.relations[key] = RELATION.NONE;
    delete this.#state.requests[key];
    this.#persist();
    return this.describe(key);
  }

  removeFriend(key) {
    if (this.#state.relations[key] !== RELATION.FRIEND) return this.describe(key);
    this.#state.relations[key] = RELATION.NONE;
    delete this.#state.requests[key];
    this.#persist();
    return this.describe(key);
  }

  /**
   * 拉黑（规划 §9.5「提供举报、屏蔽和本地黑名单」）。
   * 拉黑是本地决定，不需要对方同意，且优先级高于其它一切关系。
   */
  block(key, reason = '') {
    this.#requireKey(key, '拉黑目标');
    this.#state.relations[key] = RELATION.BLOCKED;
    this.#state.requests[key] = { direction: 'blocked', reason: String(reason).slice(0, 200), at: Date.now() };
    this.#logger?.info?.('已拉黑', { key, reason });
    this.#persist();
    return this.describe(key);
  }

  unblock(key) {
    if (this.#state.relations[key] === RELATION.BLOCKED) {
      this.#state.relations[key] = RELATION.NONE;
      delete this.#state.requests[key];
      this.#persist();
    }
    return this.describe(key);
  }

  follow(key) {
    this.#requireKey(key, '关注目标');
    // 关注不覆盖好友关系：一个人可以既是我好友又是我关注的人。
    const current = this.#state.relations[key];
    this.#state.relations[key] = current === RELATION.FRIEND ? RELATION.FRIEND : RELATION.FOLLOWING;
    this.#state.requests[key] = { ...(this.#state.requests[key] ?? {}), following: true, followedAt: Date.now() };
    this.#persist();
    return this.describe(key);
  }

  unfollow(key) {
    const request = this.#state.requests[key];
    if (request?.following) {
      delete request.following;
      if (this.#state.relations[key] === RELATION.FOLLOWING) this.#state.relations[key] = RELATION.NONE;
      this.#persist();
    }
    return this.describe(key);
  }

  isFollowing(key) {
    return this.#state.requests[key]?.following === true;
  }

  /** 合并「关系 + 在线状态」的完整视图，界面直接用这个。 */
  describe(key) {
    const relation = this.#state.relations[key] ?? RELATION.NONE;
    const request = this.#state.requests[key] ?? {};
    const online = this.#online.get(key) ?? null;
    return {
      peerKey: key,
      relation,
      following: request.following === true,
      note: request.note ?? '',
      requestAt: request.at ?? null,
      delivery: request.delivery ?? null,
      blockReason: relation === RELATION.BLOCKED ? (request.reason ?? '') : '',
      online: online !== null,
      nickname: online?.nickname ?? null,
      fingerprint: online?.fingerprint ?? null,
      lastSeen: online?.lastSeen ?? null,
    };
  }

  /** 全部有关系的身份（好友、关注、待处理、已拉黑）。 */
  list() {
    const keys = new Set([
      ...Object.keys(this.#state.relations).filter((k) => this.#state.relations[k] !== RELATION.NONE),
      ...Object.keys(this.#state.requests).filter((k) => this.#state.requests[k]?.following),
    ]);
    return [...keys].map((key) => this.describe(key)).sort((a, b) => {
      // 在线优先，其次好友优先，最后按名字——和常见 IM 的排序直觉一致。
      if (a.online !== b.online) return a.online ? -1 : 1;
      if ((a.relation === RELATION.FRIEND) !== (b.relation === RELATION.FRIEND)) {
        return a.relation === RELATION.FRIEND ? -1 : 1;
      }
      return (a.nickname ?? a.peerKey).localeCompare(b.nickname ?? b.peerKey);
    });
  }

  /** 该身份是否允许向我发起私聊（拉黑即拒收）。 */
  acceptsMessagesFrom(key) {
    return this.#state.relations[key] !== RELATION.BLOCKED;
  }

  /** 是否是我的好友（只有好友之间允许私聊，规划 §5.3）。 */
  isFriend(key) {
    return this.#state.relations[key] === RELATION.FRIEND;
  }

  /** 好友申请的网络消息类型（供上层组装信封）。 */
  static requestKind() {
    return MESSAGE_KIND.FRIEND_REQUEST;
  }

  get metrics() {
    const all = this.list();
    return {
      friends: all.filter((p) => p.relation === RELATION.FRIEND).length,
      following: all.filter((p) => p.following).length,
      incoming: all.filter((p) => p.relation === RELATION.INCOMING).length,
      outgoing: all.filter((p) => p.relation === RELATION.OUTGOING).length,
      blocked: all.filter((p) => p.relation === RELATION.BLOCKED).length,
      online: all.filter((p) => p.online).length,
    };
  }
}
