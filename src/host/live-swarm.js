/**
 * 直播的观众间分发（swarm / 会话内分发）。
 *
 * ## 这一节要解决的问题
 *
 * 直播时如果**所有观众都直接从发布者拉**，发布者的上行必然成为瓶颈 ——
 * 发布者的家宽上行通常是几十 Mbps，几百个观众根本扛不住。
 * 所以已经收到内容的观众应当**帮助转发下去**。
 *
 * ## 为什么它和"中继"是两件事（这一点决定了默认值能不能开）
 *
 *   **中继**：一个和你毫无关系的陌生人需要「连到你」。你要额外付出上行、
 *           暴露元数据、而且很可能在 NAT 后面根本连不进来。
 *           → 需要可达性实证 + 显式同意 + 预算护栏。
 *
 *   **会话内分发**：你**已经在这个直播里**、**已经收到了**这些数据，
 *           只是把它转给同房间的其他观众。
 *           → 你没有多下载任何东西；用掉的是你本来闲置的上行；
 *             而且这直接决定了这场直播发布者扛不扛得住。
 *
 * 所以：**会话内分发可以默认开启**（规划 §9.2 要求的是"基础功能不被迫贡献"，
 * 而不是"不准贡献"）；中继才需要那套 auto 护栏。
 *
 * ## 诚实的边界：NAT 决定了分发的**扇出**，但不决定"能不能帮上忙"
 *
 * 一个在 NAT 后面的观众能服务谁，仍然受可达性限制（见 docs/reachability-detection.md）：
 *   - **同局域网**的其他观众 —— 直连，最有效（也是现实里最常见的一批观众）；
 *   - **能连到它的**观众 —— 打洞成功、或对方主动出站到它；
 *   - 其余情况 —— 服务不了，但不影响它**替发布者省下一份**。
 *
 * 关键：即使只能服务一个对端，发布者也少发一份。**分发不需要全员可达才有价值。**
 */

import { MESSAGE_KIND } from '../shared/protocol.js';

/** 分发策略。默认值刻意保守但**开启** —— 会话内分发本来就该是默认行为。 */
export const DEFAULT_SWARM_POLICY = Object.freeze({
  /** 是否参与观众间分发。 */
  enabled: true,
  /**
   * 房间小到这个人数以下时不启用分发。
   *
   * 理由：两三个观众时发布者直发更简单、延迟更低，
   * 引入一层转发只是白增跳数。分发是为"人多到发布者扛不住"准备的。
   */
  minRoomSize: 4,
  /** 同时最多服务几个对端（每个对端都要占一条连接与一份上行）。 */
  maxServees: 4,
  /** 每分钟最多转发多少字节；0 表示不限（不建议）。 */
  maxServeBytesPerMinute: 32 * 1024 * 1024,
  /** 单个对端一次最多补多少事件，防止被当成无限回放源。 */
  maxServeEventsPerRequest: 500,
});

/**
 * 观众间分发。
 *
 * 它**不搬字节** —— 搬字节由已有的传输层与 `LiveRoom` 完成。
 * 它只负责三件容易做错的事：
 *   1. **谁知道什么**（可用性广播），
 *   2. **该找谁要**（来源选择），
 *   3. **要不要给、给多少**（服务预算）。
 *
 * 把这三件事独立出来，是因为它们的正确性可以用确定性测试直接断言，
 * 而不必每次都拉起真实网络。
 */
export class LiveSwarm {
  #policy;
  /** roomId → Map(peerKey → { upToSeq, updatedAt, nickname }) */
  #availability = new Map();
  /** 服务预算的时间窗。 */
  #served = [];
  /** 正在服务的对端：roomId → Set(peerKey) */
  #serving = new Map();
  #now;
  #metrics = {
    availabilityUpdates: 0,
    seeks: 0,
    servedFromPeer: 0,
    servedFromOrigin: 0,
    bytesForwarded: 0,
    requestsRefused: 0,
  };

  constructor({ policy = {}, now = () => Date.now() } = {}) {
    this.#policy = { ...DEFAULT_SWARM_POLICY, ...policy };
    this.#now = now;
  }

  get policy() {
    return { ...this.#policy };
  }

  get metrics() {
    const { servedFromPeer, servedFromOrigin } = this.#metrics;
    const pulls = servedFromPeer + servedFromOrigin;
    return {
      ...this.#metrics,
      /**
       * 有多少比例的补数据**没有落在发布者身上**。
       * 这就是分发的价值：越高说明发布者被卸载得越彻底。
       */
      offloadedRatio: pulls > 0 ? servedFromPeer / pulls : null,
    };
  }

  /** 观众广播"我手上有到第几号事件"。 */
  noteAvailability(peerKey, roomId, upToSeq, { nickname = null } = {}) {
    if (typeof peerKey !== 'string' || typeof roomId !== 'string') return false;
    if (!Number.isInteger(upToSeq) || upToSeq < 0) return false;
    let room = this.#availability.get(roomId);
    if (!room) { room = new Map(); this.#availability.set(roomId, room); }
    const previous = room.get(peerKey);
    // 只前进不后退：乱序到达的旧广播不能把可用范围拉回去。
    if (previous && previous.upToSeq >= upToSeq) {
      previous.updatedAt = this.#now();
      return false;
    }
    room.set(peerKey, { upToSeq, updatedAt: this.#now(), nickname });
    this.#metrics.availabilityUpdates += 1;
    return true;
  }

  forget(peerKey) {
    for (const room of this.#availability.values()) room.delete(peerKey);
  }

  /** 某个房间当前的可用性快照（按持有量从多到少）。 */
  availability(roomId, { exclude = [], maxAgeMs = 60_000 } = {}) {
    const room = this.#availability.get(roomId);
    if (!room) return [];
    const deadline = this.#now() - maxAgeMs;
    const skip = new Set(exclude);
    return [...room.entries()]
      .filter(([key, entry]) => !skip.has(key) && entry.updatedAt >= deadline)
      .map(([peerKey, entry]) => ({ peerKey, ...entry }))
      .sort((a, b) => b.upToSeq - a.upToSeq);
  }

  /**
   * 该从哪里补数据。
   *
   * 规则很直白：**在能满足需求的人里挑持有最少的那个**。
   *
   * 为什么不是挑持有最多的：持有最多的那个往往是刚加入不久、正在猛拉的节点，
   * 把大家都推给它，它就是下一个瓶颈。挑"刚好够用"的，负载会自然摊开。
   * 都不够用时才回落到发布者 —— 发布者永远是最后手段，不是第一选择。
   */
  pickSource({ roomId, sinceSeq, originKey, selfKey = null, roomSize = 0 }) {
    this.#metrics.seeks += 1;
    if (!this.#policy.enabled || roomSize < this.#policy.minRoomSize) {
      this.#metrics.servedFromOrigin += 1;
      return { source: originKey, reason: roomSize < this.#policy.minRoomSize ? 'room-too-small' : 'swarm-disabled' };
    }

    const candidates = this.availability(roomId, { exclude: [selfKey, originKey].filter(Boolean) })
      .filter((entry) => entry.upToSeq >= sinceSeq)
      // 正在服务太多对端的不再派活
      .filter((entry) => (this.#serving.get(roomId)?.size ?? 0) < this.#policy.maxServees);

    if (candidates.length === 0) {
      this.#metrics.servedFromOrigin += 1;
      return { source: originKey, reason: 'no-peer-has-it' };
    }

    const chosen = candidates[candidates.length - 1]; // 持有最少的够用者
    this.#metrics.servedFromPeer += 1;
    return { source: chosen.peerKey, reason: 'peer-has-it', upToSeq: chosen.upToSeq };
  }

  /**
   * 要不要服务这个补数据请求。
   *
   * 返回 `{ allow, reason, maxEvents }`。
   * 拒绝时要给出**可解释的原因** —— 对端据此换一个来源，而不是干等。
   */
  shouldServe({ roomId, requesterKey, sinceSeq, latestSeq, roomSize = 0 }) {
    if (!this.#policy.enabled) return { allow: false, reason: 'swarm-disabled' };
    if (roomSize < this.#policy.minRoomSize) return { allow: false, reason: 'room-too-small' };
    if (requesterKey === undefined || requesterKey === null) return { allow: false, reason: 'no-requester' };

    const serving = this.#serving.get(roomId) ?? new Set();
    if (!serving.has(requesterKey) && serving.size >= this.#policy.maxServees) {
      this.#metrics.requestsRefused += 1;
      return { allow: false, reason: 'at-capacity' };
    }

    const budget = this.#policy.maxServeBytesPerMinute;
    if (budget > 0) {
      const used = this.#bytesLastMinute();
      if (used >= budget) {
        this.#metrics.requestsRefused += 1;
        return { allow: false, reason: 'budget-exhausted' };
      }
    }

    const wanted = Math.max(0, (latestSeq ?? 0) - (sinceSeq ?? 0) + 1);
    return {
      allow: true,
      reason: 'ok',
      maxEvents: Math.min(wanted, this.#policy.maxServeEventsPerRequest),
    };
  }

  noteServing(roomId, requesterKey) {
    let serving = this.#serving.get(roomId);
    if (!serving) { serving = new Set(); this.#serving.set(roomId, serving); }
    serving.add(requesterKey);
  }

  noteServeFinished(roomId, requesterKey) {
    this.#serving.get(roomId)?.delete(requesterKey);
  }

  /** 记一次实际转发出去的字节（用于预算）。 */
  noteForwarded(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.#served.push({ at: this.#now(), bytes });
    if (this.#served.length > 1024) this.#served.splice(0, this.#served.length - 1024);
    this.#metrics.bytesForwarded += bytes;
  }

  #bytesLastMinute() {
    const deadline = this.#now() - 60_000;
    this.#served = this.#served.filter((entry) => entry.at >= deadline);
    return this.#served.reduce((sum, entry) => sum + entry.bytes, 0);
  }

  /** 我该对外广播的可用性消息。 */
  availabilityEnvelope(roomId, upToSeq) {
    return { kind: MESSAGE_KIND.LIVE_HAVE, payload: { roomId, upToSeq } };
  }
}

/**
 * 用确定性模拟衡量"分发到底省了多少发布者上行"。
 *
 * 为什么用模拟而不是真实网络：这里要断言的是**分发策略的收益**，
 * 而不是 TCP 的行为（那部分在 test/network/ 里另有覆盖）。
 * 模拟让收益可以被直接量化，而且结果稳定可复现。
 *
 * 模型：`roomSize` 个观众，带宽受限的发布者按轮次把事件推给部分观众，
 * 其余观众从**已经拿到的观众**那里拉。返回发布者实际发出的份数。
 *
 * @returns {{originPushes: number, peerPushes: number, savedRatio: number, rounds: number}}
 */
export function simulateDistribution({ roomSize, policy = {}, reachableFraction = 1, seed = 42 }) {
  const swarm = new LiveSwarm({ policy });
  let state = seed >>> 0;
  const rand = () => {
    // 确定性伪随机：同一个种子必须得到同样的结论。
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const ORIGIN = 'origin';
  const peers = Array.from({ length: roomSize }, (_, i) => `peer-${i}`);
  // 谁可以被别人连到 —— NAT 决定了这个比例，见模块头的说明。
  const reachable = new Set(peers.filter(() => rand() < reachableFraction));

  let upToSeq = 0;
  let originPushes = 0;
  let peerPushes = 0;
  let rounds = 0;
  const target = roomSize * 10; // 每个观众 10 个事件

  // 发布者先服务第一批（否则房间里没有任何人有数据）
  const seedCount = Math.max(1, Math.min(roomSize, Math.ceil(roomSize / 4)));
  for (let i = 0; i < seedCount; i += 1) {
    originPushes += 1;
    swarm.noteAvailability(peers[i], 'room', (upToSeq += 10));
  }

  while (rounds < 100) {
    rounds += 1;
    const pending = peers.filter((peer) => (swarm.availability('room', { exclude: [] })
      .find((entry) => entry.peerKey === peer)?.upToSeq ?? 0) < target);
    if (pending.length === 0) break;

    for (const peer of pending) {
      const have = swarm.availability('room', { exclude: [] })
        .find((entry) => entry.peerKey === peer)?.upToSeq ?? 0;
      const pick = swarm.pickSource({
        roomId: 'room', sinceSeq: have + 1, originKey: ORIGIN, selfKey: peer, roomSize,
      });
      if (pick.source === ORIGIN) {
        originPushes += 1;
        swarm.noteAvailability(peer, 'room', target);
        continue;
      }
      // 从对端拉：只有**发布者之外**的人能连到它才行
      if (!reachable.has(pick.source)) {
        originPushes += 1;
        swarm.noteAvailability(peer, 'room', target);
        continue;
      }
      peerPushes += 1;
      swarm.noteAvailability(peer, 'room', target);
    }
  }

  const total = originPushes + peerPushes;
  return {
    originPushes,
    peerPushes,
    rounds,
    savedRatio: total > 0 ? peerPushes / total : 0,
  };
}
