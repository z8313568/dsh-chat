/**
 * 中继的信誉与选择（规划 §9.5「激励与治理」）。
 *
 * ## 为什么需要它
 *
 * 引入中继之后，用户面对一个新问题：**"我凭什么把流量交给这台机器？"**
 * 中继能看到元数据（谁和谁通信、多大、多频繁），也可以随时拒绝服务。
 * 如果客户端只是"连上第一台见到的中继"，那么一台坏中继可以：
 *   - 把所有人的流量都引到自己这里然后掐断；
 *   - 静静地记录所有人的通信关系。
 *
 * 所以要有**选择**和**记账**。
 *
 * ## 规划 §9.5 明确反对过早引入代币，这里照做
 *
 * 规划原文的倾向是：先做举报/屏蔽/本地黑名单，不要一上来搞复杂的代币奖励。
 * 本模块因此提供一个**本地信誉账本**，而不是链上激励：
 *
 *   1. **本地观察优先**：自己实测到的成功/失败最有价值，权重最高；
 *   2. **他人证明只作参考**：别人签名的观察记录可以听，但不能盖过自己的实测 ——
 *      否则女巫攻击（批量伪造好评）可以直接把一台坏中继刷到榜首；
 *   3. **信誉是历史，不是保证**：一台中继可以一直表现良好，然后在关键时刻作恶。
 *      这一点无法用信誉消除，只能靠多中继并用和用户可选的固定中继来缓解。
 *
 * 这三条都不是"最佳实践"式的说法，而是本模块**代码里就写着**的取舍。
 */

import { MESSAGE_KIND } from '../shared/protocol.js';
import { canonicalBytes } from '../shared/canonical.js';

/** 一次观察记录。 */
export const OBSERVATION = Object.freeze({
  /** 成功转发了一条。 */
  FORWARD_OK: 'forward-ok',
  /** 目标不可达（正常现象，轻微负面）。 */
  UNREACHABLE: 'unreachable',
  /** **拒绝了密文转发** —— 这是协议违背，严重负面。 */
  REFUSED_SEALED: 'refused-sealed',
  /** 登记被拒（可能只是容量满了）。 */
  REGISTER_REFUSED: 'register-refused',
  /** 无理由断开。 */
  DISCONNECTED: 'disconnected',
  /** 转交了伪造的身份文档（签名校验失败）。 */
  FORGED_DOCUMENT: 'forged-document',
});

/** 各类观察对信誉的影响。权重体现"这个行为有多严重"。 */
const WEIGHTS = Object.freeze({
  [OBSERVATION.FORWARD_OK]: { score: 1, reliability: 1 },
  [OBSERVATION.UNREACHABLE]: { score: -0.05, reliability: 1 },
  // 拒绝转发密文 = 它拿了中继的角色却不干活，比直接不可用更糟（用户会以为发出去了）
  [OBSERVATION.REFUSED_SEALED]: { score: -8, reliability: 1 },
  [OBSERVATION.REGISTER_REFUSED]: { score: -0.5, reliability: 1 },
  [OBSERVATION.DISCONNECTED]: { score: -2, reliability: 1 },
  // 伪造文档 = 试图做中间人，最严重
  [OBSERVATION.FORGED_DOCUMENT]: { score: -25, reliability: 1 },
});

/** 中继类型：用户手动指定的应当永远优先，因为它体现的是用户的信任选择。 */
export const RELAY_SOURCE = Object.freeze({
  MANUAL: 'manual',
  DISCOVERED: 'discovered',
  ATTESTED: 'attested',
});

/**
 * 本地信誉账本。
 *
 * 刻意不做持久化以外的花样：它就是"我见过的行为"的流水账。
 */
export class ReputationLedger {
  #entries = new Map(); // peerKey → entry
  #relayServerStats = { bytesForwardedOut: 0, bytesConsumed: 0 };

  /** 记一次观察。 */
  record(peerKey, observation, { detail = null, at = Date.now() } = {}) {
    const weight = WEIGHTS[observation];
    if (!weight) throw new TypeError(`未知的观察类型: ${String(observation)}`);
    let entry = this.#entries.get(peerKey);
    if (!entry) {
      entry = {
        peerKey, score: 0, observations: 0, firstSeenAt: at, lastSeenAt: at,
        counts: {}, /** 连续失败次数，用于指数退避。 */ consecutiveFailures: 0,
      };
      this.#entries.set(peerKey, entry);
    }
    entry.score += weight.score;
    entry.observations += 1;
    entry.lastSeenAt = at;
    entry.counts[observation] = (entry.counts[observation] ?? 0) + 1;

    /**
     * 正向事件重置退避，负向事件累加。但有**两种负向事件不累加**：
     *
     *   UNREACHABLE   —— 目标不在线是网络现实，不是中继的错。
     *                    把它算成"中继连续失败"会让一台好中继因为
     *                    "碰巧对端都离线"而被拉黑。这是把别人的问题记在它头上。
     *   REGISTER_REFUSED —— 通常只是容量满了，属于正常拒绝。
     *
     * 拒绝转发密文与伪造文档则相反：那是**违背职责**，直接按最严重处理。
     */
    if (weight.score > 0) entry.consecutiveFailures = 0;
    else if (observation === OBSERVATION.REFUSED_SEALED || observation === OBSERVATION.FORGED_DOCUMENT) {
      entry.consecutiveFailures = 99;
    } else if (observation === OBSERVATION.UNREACHABLE || observation === OBSERVATION.REGISTER_REFUSED) {
      // 不累加：这不是中继的过失
    } else entry.consecutiveFailures += 1;

    this.#lastDetail = detail;
    return entry;
  }

  #lastDetail = null;

  get(peerKey) {
    return this.#entries.get(peerKey) ?? null;
  }

  list() {
    return [...this.#entries.values()].map((entry) => ({ ...entry, counts: { ...entry.counts } }));
  }

  /** 是否被用户手动拉黑。 */
  isBlocked(peerKey) {
    return this.#entries.get(peerKey)?.blocked === true;
  }

  /** 该中继是否已被判为不可用（严重违规，或连续失败过多次）。 */
  isBlacklisted(peerKey) {
    const entry = this.#entries.get(peerKey);
    if (!entry) return false;
    if (entry.blocked === true) return true;
    if ((entry.counts[OBSERVATION.REFUSED_SEALED] ?? 0) > 0) return true;
    if ((entry.counts[OBSERVATION.FORGED_DOCUMENT] ?? 0) > 0) return true;
    return entry.consecutiveFailures >= 5;
  }

  /** 用户手动拉黑/恢复。 */
  setBlocked(peerKey, blocked) {
    const entry = this.#entries.get(peerKey) ?? this.record(peerKey, OBSERVATION.UNREACHABLE);
    entry.blocked = blocked === true;
    return entry;
  }

  /**
   * 本地贡献账本：我转发出去多少 vs 我消耗了多少。
   *
   * 这是**不使用代币**的激励形式：把"贡献"和"消耗"如实记下来给用户看，
   * 而不是假装能自动结算。规划 §9.5 反对过早引入代币，这条正好对应。
   */
  noteContribution(direction, bytes) {
    if (direction === 'served') this.#relayServerStats.bytesForwardedOut += bytes;
    else this.#relayServerStats.bytesConsumed += bytes;
    return this.contribution();
  }

  contribution() {
    const { bytesForwardedOut, bytesConsumed } = this.#relayServerStats;
    const total = bytesForwardedOut + bytesConsumed;
    return {
      servedBytes: bytesForwardedOut,
      consumedBytes: bytesConsumed,
      /** 正数表示净贡献者，负数表示净消耗者。 */
      balance: bytesForwardedOut - bytesConsumed,
      servedRatio: total > 0 ? bytesForwardedOut / total : null,
    };
  }
}

/**
 * 中继选择器。
 *
 * 打分不是"谁负载低就用谁"，而是把四件事放在一起权衡：
 *   1. **用户手动指定的优先** —— 信任是用户给的，不该被算法覆盖；
 *   2. **对某个目标已知可达的中继优先** —— 上次能通，这次大概率也能通；
 *   3. **本地成功率** —— 实测比任何声明都可靠；
 *   4. **负载** —— 别把大家都挤到同一台上。
 */
export class RelaySelector {
  #ledger;
  /** "目标身份 → 上次成功的中继" 亲和性缓存。 */
  #affinity = new Map();
  #logger;

  constructor({ ledger, logger = null }) {
    this.#ledger = ledger;
    this.#logger = logger;
  }

  noteSuccess(relayPeerKey, targetPeerKey) {
    if (targetPeerKey) this.#affinity.set(targetPeerKey, relayPeerKey);
  }

  score(relay, targetPeerKey = null) {
    const entry = this.#ledger.get(relay.peerKey);
    const reasons = [];
    let score = 100;

    if (relay.source === RELAY_SOURCE.MANUAL) { score += 40; reasons.push('manual:+40'); }
    if (relay.registered) { score += 20; reasons.push('registered:+20'); }
    else { score -= 60; reasons.push('not-registered:-60'); }

    // 目标亲和性：优先用上次成功过的那台
    if (targetPeerKey && this.#affinity.get(targetPeerKey) === relay.peerKey) {
      score += 30; reasons.push('affinity:+30');
    }

    // 本地成功率（观察次数少时向 0.5 收缩，避免"用一次成功"就封神）
    if (entry && entry.observations > 0) {
      const ok = entry.counts[OBSERVATION.FORWARD_OK] ?? 0;
      const bad = (entry.counts[OBSERVATION.UNREACHABLE] ?? 0)
        + (entry.counts[OBSERVATION.DISCONNECTED] ?? 0);
      const shrunk = (ok + 1) / (ok + bad + 2); // 拉普拉斯平滑
      const delta = Math.round((shrunk - 0.5) * 60);
      score += delta;
      reasons.push(`local-success:${delta >= 0 ? '+' : ''}${delta}`);
      if (entry.consecutiveFailures > 0) {
        const penalty = Math.min(40, entry.consecutiveFailures * 8);
        score -= penalty;
        reasons.push(`consecutive-failures:-${penalty}`);
      }
    }

    // 负载：饱和度越高越不该再往上压
    const saturation = relay.load?.saturation;
    if (typeof saturation === 'number' && saturation > 0) {
      const delta = -Math.round(saturation * 30);
      if (delta !== 0) { score += delta; reasons.push(`load:${delta}`); }
    }

    if (this.#ledger.isBlacklisted(relay.peerKey)) { score = -1000; reasons.push('blacklisted'); }

    return { score, reasons };
  }

  /**
   * 排出候选顺序。
   * @returns {Array<{relay: object, score: number, reasons: string[]}>}
   */
  rank(relays, targetPeerKey = null) {
    return relays
      .map((relay) => ({ relay, ...this.score(relay, targetPeerKey) }))
      .filter((item) => item.score > -1000)
      .sort((a, b) => b.score - a.score);
  }

  /** 取最佳的一台；都不合适就返回 null（调用方据此决定是否还能走中继）。 */
  best(relays, targetPeerKey = null) {
    const ranked = this.rank(relays, targetPeerKey);
    return ranked.length > 0 ? ranked[0] : null;
  }
}

/**
 * 中继之间的信誉证明（attestation）。
 *
 * 设计上刻意**让本地观察压过他人证明**。原因很直接：
 * 女巫攻击的成本只是"生成一堆密钥"，而伪造好评的收益是"把所有流量引到一台坏中继上"。
 * 如果他人证明的权重能盖过实测，这个模块就成了攻击工具。
 *
 * 所以：证明只用来**排序候选中我还没试过的那些**，永远不会让一台我实测失败过的中继翻盘。
 */
export class AttestationBook {
  #attestations = new Map(); // relayPeerKey → Map(attesterKey → attestation)
  #limitPerRelay;

  constructor({ limitPerRelay = 64 } = {}) {
    this.#limitPerRelay = limitPerRelay;
  }

  /** 收下一份他人签名过的观察。签名由调用方校验（这里只管去重与计数）。 */
  accept(attestation) {
    const { relayPeerKey, attesterKey } = attestation ?? {};
    if (typeof relayPeerKey !== 'string' || typeof attesterKey !== 'string') return false;
    let bucket = this.#attestations.get(relayPeerKey);
    if (!bucket) { bucket = new Map(); this.#attestations.set(relayPeerKey, bucket); }
    if (!bucket.has(attesterKey) && bucket.size >= this.#limitPerRelay) return false;
    bucket.set(attesterKey, attestation);
    return true;
  }

  /**
   * 汇总某台中继的外部评价。
   * **不返回"信任分"**，只返回样本量与净正面比例 —— 因为样本量小的时候任何分数都是噪音。
   */
  summary(relayPeerKey) {
    const bucket = this.#attestations.get(relayPeerKey);
    if (!bucket || bucket.size === 0) return { samples: 0, positive: 0, ratio: null, trustworthy: false };
    let positive = 0;
    for (const item of bucket.values()) if (item.positive === true) positive += 1;
    const samples = bucket.size;
    return {
      samples,
      positive,
      ratio: positive / samples,
      /** 样本太少就不该被当真 —— 3 条好评说明不了任何事。 */
      trustworthy: samples >= 8,
    };
  }

  /** 生成一份可对外发布的证明（由本机签名，所以别人可以验证来源）。 */
  static build(identity, { relayPeerKey, positive, detail = null }) {
    const body = {
      v: 1,
      kind: MESSAGE_KIND.RELAY_ATTESTATION ?? 'relay-attestation',
      relayPeerKey,
      attesterKey: identity.publicKeyId,
      positive: positive === true,
      detail,
      at: Date.now(),
    };
    return { ...body, sig: identity.sign(body) };
  }
}

/** 计算下一次重试的退避时间（毫秒）。 */
export function backoffMs(attempt, { baseMs = 1000, maxMs = 5 * 60 * 1000 } = {}) {
  const raw = baseMs * 2 ** Math.max(0, attempt);
  return Math.min(maxMs, raw);
}

/** 供调试与界面展示：把信誉账本渲染成可读的行。 */
export function describeLedger(ledger) {
  return ledger.list().map((entry) => ({
    peerKey: entry.peerKey,
    score: Math.round(entry.score * 10) / 10,
    observations: entry.observations,
    blacklisted: ledger.isBlacklisted(entry.peerKey),
    lastSeenAt: entry.lastSeenAt,
    counts: entry.counts,
  })).sort((a, b) => b.score - a.score);
}

/** 观察记录也是签名对象，这样别人能验证本机的证明没被篡改。 */
export function observationDigest(observation) {
  const { sig, ...body } = observation ?? {};
  return canonicalBytes(body);
}
