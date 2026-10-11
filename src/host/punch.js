/**
 * 打洞（规划 §9.4「NAT 与连接可达性」）。
 *
 * ## 打洞到底在做什么
 *
 * NAT 的本质是：**只有你先出站，别人才进得来**。打洞就是利用这一点：
 *
 * ```
 *   1. A、B 各自向中继问"你看到的我的公网端点是什么"   ← 这一步等价于 STUN
 *   2. 双方经中继交换各自的公网端点（信令）
 *   3. A、B **同时**向对方的端点发起连接
 *      → A 的出站让 A 的 NAT 记住了 B，B 的出站让 B 的 NAT 记住了 A
 *      → 于是双方的回包都能穿过各自的 NAT
 *   4. 打通了就直接用；没打通就退回中继
 * ```
 *
 * 打洞不改变可达性，它只是**省钱**：打通用的是两台机器的直连带宽，
 * 不占用中继的带宽，也不让第三方看到元数据。
 *
 * ## 必须说清楚的一条真实限制
 *
 * 本项目的传输层是 **TCP + WebSocket**，而 TCP 打洞比 UDP 打洞脆弱得多：
 *
 *   - UDP 没有握手，双方各发一个包就形成了两条映射，天然适配打洞；
 *   - TCP 需要**同时打开**（simultaneous open）：双方的 SYN 交叉发送，
 *     要求两边 NAT 都愿意转发"不是自己发起的那条连接的第一个包"，
 *     还要操作系统支持 TCP 同时打开。**很多 NAT 和系统不支持。**
 *
 * 所以本实现的态度是：
 *   - 打洞**尽力而为**，成功就省下中继带宽；
 *   - **中继永远是可靠兜底**，打洞失败不影响可用性；
 *   - 对称 NAT 直接跳过打洞（虚拟网络已证明必然失败），不浪费那几百毫秒。
 *
 * 真正稳妥的解法是把传输层换成 UDP（WebRTC / QUIC 那条路）。那是传输层改造，
 * 不在本次范围内 —— 这里不假装打洞在 TCP 上和在 UDP 上一样管用。
 */

import { MESSAGE_KIND } from '../shared/protocol.js';
import { formatPeerAddress, parsePeerAddress } from './net/address.js';

/** NAT 类型推断的结论。 */
export const NAT_TYPE = Object.freeze({
  /** 不同目的地复用同一个公网端口 —— 打洞可行性最高。 */
  CONE: 'cone',
  /** 每个目的地换一个公网端口 —— 对方算不出该往哪打，必然失败。 */
  SYMMETRIC: 'symmetric',
  /** 还没有足够信息（只有一个观察点，或都在同一台机器上）。 */
  UNKNOWN: 'unknown',
  /** 根本没有 NAT（公网主机）。 */
  OPEN: 'open',
});

/**
 * 从多个观察点推断 NAT 类型。
 *
 * 判据是最经典的那条：**同一个本地端口去连不同的目的地，公网端口变不变？**
 *   不变 → 全锥形（打洞可行）
 *   变了 → 对称型（打洞不可行）
 *
 * 需要**至少两个不同来源**的观察才能判断 —— 只有一个观察点时永远得出 unknown，
 * 这正是很多"打洞库"自欺欺人的地方：它们把 unknown 当成可行，
 * 然后每次都白试一轮。
 *
 * @param {Array<{observer: string, host: string, port: number}>} observations
 */
export function inferNatType(observations) {
  const valid = (observations ?? []).filter(
    (item) => item && typeof item.host === 'string' && Number.isFinite(item.port),
  );
  if (valid.length === 0) return { type: NAT_TYPE.UNKNOWN, reason: 'no-observation', observations: [] };

  /**
   * 回环地址这条判断要放在"观察点够不够"**之前**。
   *
   * 区分 cone / symmetric 需要至少两个观察点（要看端口变不变），
   * 但"看到的是 127.0.0.1"这件事本身就已经说明没有 NAT 了 ——
   * 这不需要第二个观察点就能确定。放在后面会让单中继的本机环境报 unknown，
   * 而实际结论是明确的 open。
   */
  const allLoopback = valid.every((item) => isLoopback(item.host));
  if (allLoopback) return { type: NAT_TYPE.OPEN, reason: 'loopback-no-nat', observations: valid };

  if (valid.length === 1) {
    return { type: NAT_TYPE.UNKNOWN, reason: 'only-one-observer', observations: valid };
  }

  const ports = new Set(valid.map((item) => item.port));
  const hosts = new Set(valid.map((item) => item.host));
  if (ports.size === 1 && hosts.size === 1) {
    return { type: NAT_TYPE.CONE, reason: 'same-mapping-for-all-destinations', observations: valid };
  }
  if (ports.size > 1) {
    return { type: NAT_TYPE.SYMMETRIC, reason: 'mapping-differs-per-destination', observations: valid };
  }
  // 公网 IP 相同但端口相同 —— 也算全锥形
  return { type: NAT_TYPE.CONE, reason: 'consistent-mapping', observations: valid };
}

function isLoopback(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost' || host.startsWith('127.');
}

/** 打洞是否值得一试。 */
export function shouldAttemptPunch(natType) {
  switch (natType) {
    case NAT_TYPE.SYMMETRIC: return { attempt: false, reason: 'symmetric-nat-cannot-punch' };
    case NAT_TYPE.UNKNOWN: return { attempt: true, reason: 'unknown-nat-worth-trying' };
    case NAT_TYPE.CONE: return { attempt: true, reason: 'cone-nat' };
    case NAT_TYPE.OPEN: return { attempt: true, reason: 'no-nat' };
    default: return { attempt: true, reason: 'unrecognized' };
  }
}

/**
 * 打洞协调器。
 *
 * 它只负责"协调"，真正拨号还是走传输层的 `connect()` ——
 * 这样打洞成功之后拿到的是一条**完全正常的**节点连接（同样的签名握手、
 * 同样的加密），上层不需要区分"这条是打洞来的还是直连来的"。
 */
export class PunchCoordinator {
  #transport;
  #relayClient;
  #logger;
  #identity;
  #codecSeal;

  /** 中继 peerKey → 它观察到的我的公网端点 */
  #observations = new Map();
  /** 正在进行的打洞：peerKey → { resolve, candidates, attempts, startedAt } */
  #pending = new Map();
  /** 对方报来的候选：peerKey → [address] */
  #candidates = new Map();

  #metrics = {
    probes: 0, offers: 0, candidatesReceived: 0,
    attempts: 0, succeeded: 0, failed: 0, skipped: 0,
  };

  /** 打洞的超时：太短会误判，太长会让用户干等（中继本来就能用）。 */
  #punchTimeoutMs;
  #dialTimeoutMs;

  constructor({ transport, relayClient, identity, logger = null, punchTimeoutMs = 4000, dialTimeoutMs = 2500 }) {
    this.#transport = transport;
    this.#relayClient = relayClient;
    this.#identity = identity;
    this.#logger = logger;
    this.#punchTimeoutMs = punchTimeoutMs;
    this.#dialTimeoutMs = dialTimeoutMs;
  }

  get metrics() {
    return { ...this.#metrics, natType: this.natType(), observations: [...this.#observations.values()] };
  }

  useCodecSeal(fn) {
    this.#codecSeal = fn;
    return this;
  }

  /** 当前推断出的 NAT 类型。 */
  natType() {
    return inferNatType([...this.#observations.entries()].map(([observer, endpoint]) => ({
      observer, host: endpoint.host, port: endpoint.port,
    })));
  }

  /**
   * 我自己的候选端点，按"先试哪个"排序：
   *
   *   1. **本机监听地址** —— 没有 NAT、或做了端口映射时，这个直接就能连上；
   *   2. 各中继**观察到的公网端点** —— 在 NAT 后面时这才是对方该拨的地址。
   *
   * 第 1 条曾经被漏掉，后果值得记下来：只有观察端点时，拨的其实是
   * **本机连中继那条出站连接用的临时端口**，而那个端口上没有监听任何东西 ——
   * 于是打洞必然超时。真实 NAT 下这个映射指向的也是出站 socket 而不是监听 socket，
   * 所以"只靠观察端点"这条路本身就不成立。
   *
   * 必须说清楚的限制：本实现无法把出站 socket 绑到监听端口上（那才是
   * UDP 打洞、或者说 TCP 同时打开，真正依赖的东西）。所以这里的打洞本质是
   * **"交换候选地址，挑一个能通的"**，NAT 穿透能力受这一条限制。
   * 打洞失败不影响可用性 —— 中继永远是兜底。
   */
  localCandidates() {
    const seen = new Set();
    const out = [];

    const listen = this.#transport.address;
    if (typeof listen === 'string' && listen.length > 0) {
      seen.add(listen);
      out.push(listen);
    }

    for (const endpoint of this.#observations.values()) {
      const address = formatPeerAddress(endpoint.host, endpoint.port);
      if (seen.has(address)) continue;
      seen.add(address);
      out.push(address);
    }
    return out;
  }

  /**
   * 挂上中继控制消息。返回卸载函数。
   *
   * 注意监听的是 `relay-control` 而不是 `envelope`：
   * 打洞信令是**中继自己的控制消息**，由 RelayClient 拆出来后转交，
   * 不是普通的业务信封。监听 envelope 的话什么都收不到。
   */
  attach() {
    const onControl = ({ envelope, peerKey }) => this.#handle(envelope, peerKey);
    this.#transport.on('relay-control', onControl);
    return () => this.#transport.off('relay-control', onControl);
  }

  /** 向所有已登记的中继询问"你看到的我的公网端点是什么"（STUN 那一步）。 */
  probe() {
    let sent = 0;
    for (const relay of this.#relayClient.relays()) {
      if (!relay.registered) continue;
      try {
        this.#transport.send(relay.peerKey, this.#codecSeal(MESSAGE_KIND.PUNCH_PROBE, {}, relay.peerKey));
        sent += 1;
      } catch (error) {
        this.#logger?.warn?.('端点探测发送失败', { message: error?.message });
      }
    }
    if (sent > 0) this.#metrics.probes += sent;
    return sent;
  }

  /**
   * 尝试与某个身份打洞。
   *
   * @returns {Promise<{ok: boolean, reason: string, address?: string, elapsedMs: number}>}
   *   失败**不是错误**：调用方接着走中继即可。这里不抛异常，因为"打不通"
   *   是完全正常的网络现实，不该被当成异常处理。
   */
  async punchWith(peerKey, { timeoutMs = this.#punchTimeoutMs } = {}) {
    const startedAt = Date.now();

    if (!this.#relayClient.hasRelay()) {
      this.#metrics.skipped += 1;
      return { ok: false, reason: 'no-relay-for-signaling', elapsedMs: 0 };
    }

    const nat = this.natType();
    const verdict = shouldAttemptPunch(nat.type);
    if (!verdict.attempt) {
      // 对称 NAT 下打洞必然失败（虚拟网络已证明），直接跳过，省掉几百毫秒的干等。
      this.#metrics.skipped += 1;
      return { ok: false, reason: verdict.reason, natType: nat.type, elapsedMs: Date.now() - startedAt };
    }

    // 端点探测是**补充**，不再阻塞打洞：监听地址本来就已经是一个候选。
    // 早先在这里干等 250ms 才继续，而等来的那个端口根本没人监听 ——
    // 既慢又没用。
    if (this.#observations.size === 0) this.probe();

    let settle;
    const result = new Promise((resolve) => { settle = resolve; });
    this.#pending.set(peerKey, { settle, startedAt, candidates: this.#candidates.get(peerKey) ?? [] });

    // 把候选经中继发给对方；对方收到后也会同时开始拨号。
    this.#sendOffer(peerKey);

    const timer = setTimeout(() => {
      const entry = this.#pending.get(peerKey);
      if (!entry) return;
      this.#pending.delete(peerKey);
      this.#metrics.failed += 1;
      entry.settle({ ok: false, reason: 'punch-timeout', elapsedMs: Date.now() - startedAt });
    }, timeoutMs);

    const outcome = await result;
    clearTimeout(timer);
    this.#pending.delete(peerKey);
    return { ...outcome, natType: nat.type, elapsedMs: Date.now() - startedAt };
  }

  #sendOffer(peerKey) {
    const candidates = this.localCandidates();
    // 信令必须走一条双方都能到达的通道，中继正好是。但它是**控制消息**，
    // 不能被当成内容塞进 RELAY_FORWARD —— 那样会被中继的明文闸门拒掉。
    const sent = this.#relayClient.sendControl(MESSAGE_KIND.PUNCH_OFFER, {
      to: peerKey,
      candidates,
      natType: this.natType().type,
      at: Date.now(),
    }, { to: peerKey });
    if (sent) this.#metrics.offers += 1;
    else this.#logger?.warn?.('打洞信令没能发出（没有可用中继）', { peerKey });
    return sent;
  }

  /**
   * 收到对方的候选后**同时**拨号。
   *
   * "同时"是要点：只有双方都在对方 NAT 上留下映射，回包才穿得过。
   * 单方面拨号等于普通直连，对 NAT 后的对端必然失败。
   */
  async #dialCandidates(peerKey, candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    this.#metrics.attempts += 1;

    const attempts = candidates.map(async (address) => {
      const parsed = parsePeerAddress(address);
      if (!parsed) return null;
      try {
        const key = await this.#transport.connect(address, { timeoutMs: this.#dialTimeoutMs });
        return key === peerKey ? address : null;
      } catch {
        return null;
      }
    });

    const results = await Promise.all(attempts);
    const mine = results.find((address) => address !== null);
    if (mine) return mine;

    /**
     * 我拨出去没成，但**对方可能同时拨通了我**。
     *
     * 打洞是双向同时进行的，两条连接里任意一条建立起来就算成功。
     * 只盯着"我这条拨号的结果"会漏掉另一半 —— 双方各自只看到自己失败，
     * 于是都把结论写成"打洞失败"，然后一起退回中继（明明已经直连了）。
     */
    if (this.#transport.peers().some((peer) => peer.peerKey === peerKey)) {
      return 'peer-initiated';
    }
    return null;
  }

  #handle(envelope, relayPeerKey) {
    if (!envelope) return;

    switch (envelope.kind) {
      case MESSAGE_KIND.PUNCH_ENDPOINT: {
        const observed = envelope.payload?.observed;
        if (!observed) return;
        const parsed = parsePeerAddress(observed);
        if (!parsed) return;
        this.#observations.set(relayPeerKey, { host: parsed.host, port: parsed.port });
        this.#transport.emit('punch-endpoint', { observer: relayPeerKey, observed, natType: this.natType() });
        break;
      }

      case MESSAGE_KIND.PUNCH_CANDIDATE: {
        // 对方的候选经中继送达。**必须校验内层信封的来源**：
        // 中继虽然解不开内容，但它可以谎报"这是谁发的"。
        const from = envelope.payload?.from;
        const candidates = envelope.payload?.candidates;
        if (typeof from !== 'string' || !Array.isArray(candidates)) return;
        this.#metrics.candidatesReceived += 1;
        this.#candidates.set(from, candidates);
        this.#transport.emit('punch-candidate', { peerKey: from, candidates });

        const entry = this.#pending.get(from);
        if (!entry) {
          /**
           * 我没有在打洞，但对方想跟我打 —— **必须回应**，否则对方永远等不到我的候选。
           *
           * 早先这里直接 return，于是"单方面发起打洞"（比如上层调 ensureReachable
           * 试一下能不能直连）必然超时：对方发了 offer，我收了，但我什么都不回。
           * 打洞是双向协议，收到请求就要应答。
           *
           * 不会无限来回：只有"没有 pending"的一方才回，而它回完之后
           * 对方是有 pending 的，不会再回。
           */
          this.#sendOffer(from);
          this.#dialCandidates(from, candidates).catch(() => {});
          return;
        }
        // 对方也在打洞 → 我也拨过去。这是"同时"的另一半。
        this.#dialCandidates(from, candidates).then((address) => {
          const settle = entry.settle;
          if (!settle) return;
          if (address) {
            this.#metrics.succeeded += 1;
            settle({ ok: true, reason: 'punched', address });
          } else {
            this.#metrics.failed += 1;
            settle({ ok: false, reason: 'all-candidates-failed' });
          }
        }).catch(() => {});
        break;
      }

      default:
        break;
    }
  }
}
