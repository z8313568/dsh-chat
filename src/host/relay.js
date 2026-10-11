/**
 * 中继（规划 §9.1「中继节点：帮无法直连的设备转发加密通信」、§9.4 NAT 可达性）。
 *
 * ## 为什么必须有中继，而不是"再优化一下直连"
 *
 * 虚拟网络环境已经给出了结论（见 docs/network-testing.md）：
 *   - 两台都在 NAT 后面、目的侧没有端口映射 → **直连必然失败**；
 *   - 全锥形 NAT 下打洞**可行**；**对称 NAT 下打洞不可行**，而这正是移动网络的常态。
 * 也就是说，只要用户里有一部分在对称 NAT 后面，**没有中继就有一部分人永远连不上**。
 *
 * ## 中继怎么工作（关键：双方都只做出站连接）
 *
 * ```
 *   [NAT 后的 A] ──出站──► [公网中继 R] ◄──出站── [NAT 后的 B]
 * ```
 *
 * NAT 永远允许**出站**。所以 A、B 各自主动连到 R，R 在中间转发。
 * 这条路对 A、B 的 NAT 类型不敏感 —— 对称 NAT 也照样能用。
 * R 自己必须是**公网可达**的，否则它也没有意义（见 reachability.js）。
 *
 * ## 中继看不到什么（这条是硬约束，不是承诺）
 *
 * 规划 §5.3 明确要求「中继节点原则上只转发密文，不应拥有读取私聊正文的权限」。
 * 所以中继对每个要转发的信封做一次**分类判断**（`classifyForward`），fail-closed：
 *
 *   - 载荷是密文（X25519+AES-GCM）→ 转发。中继没有接收方私钥，**解不开**；
 *   - 载荷是明确公开的类型（在线状态、公开直播事件、公开分享公告、插件清单）→ 转发；
 *   - **其它一切 → 拒绝转发并计数**。
 *
 * 于是"私聊内容经过中继"这件事在协议层就不成立，而不是"我们承诺不看"。
 *
 * ## 中继仍然能看到什么（必须如实说）
 *
 *   - **元数据**：谁在和谁通信、消息大小、时间、频率；
 *   - 它可以**拒绝服务**、可以记录这些元数据。
 *
 * 规划 §12.5 把"中继节点拒绝服务或记录通信元数据"列为已知威胁 —— 这条没有被消除，
 * 也不应该假装被消除。缓解手段是用户可以选择自己信任的中继、以及可同时使用多个中继。
 */

import { MESSAGE_KIND, RELAY_CONTROL_KINDS, RELAY_PUBLIC_KINDS } from '../shared/protocol.js';
import { isSealedPayload } from './crypto.js';
import { verifyIdentityDocument } from './identity.js';
import { NodeTransport } from './net/transport.js';
import { PunchCoordinator, NAT_TYPE } from './punch.js';
import { isProbeableAddress } from './reachability.js';
import { AttestationBook, OBSERVATION, RelaySelector, ReputationLedger } from './reputation.js';

/** 默认的中继策略。规划 §9.2 要求用户能设置容量与内容类型。 */
export const DEFAULT_RELAY_POLICY = Object.freeze({
  /** 最多同时服务多少个对端。 */
  maxPeers: 32,
  /** 单个信封的字节上限。 */
  maxEnvelopeBytes: 256 * 1024,
  /** 每分钟最多转发的字节数，0 表示不限。 */
  maxForwardBytesPerMinute: 8 * 1024 * 1024,
  /** 登记多久没动静就视为离线。 */
  peerTtlMs: 90 * 1000,
  /** 是否只转发密文与公开内容（关闭它会破坏规划 §5.3，所以默认且强烈建议开启）。 */
  requireSealedForPrivate: true,
});

/**
 * 判断一个信封能不能被中继转发。
 *
 * **这是整个中继的隐私闸门**，所以它只认两件事：密文，或白名单里的公开类型。
 * 未知/新增类型一律拒绝 —— 白名单而不是黑名单，因为上游新增事件类型时，
 * 黑名单会静默放行新东西，白名单只会"少转发"，而少转发的表现是功能缺失，不是隐私泄露。
 */
export function classifyForward(envelope) {
  if (!envelope || typeof envelope !== 'object') return { ok: false, reason: 'not-an-envelope' };
  if (isSealedPayload(envelope.payload)) return { ok: true, reason: 'sealed' };

  const kind = envelope.kind;
  if (!RELAY_PUBLIC_KINDS.includes(kind)) return { ok: false, reason: 'plaintext-refused' };

  // 公开分享要真的公开：scope 不是 public 的不转发。
  if (kind === MESSAGE_KIND.SHARE_ANNOUNCE) {
    const scope = envelope.payload?.share?.policy?.scope;
    if (scope !== 'public') return { ok: false, reason: 'share-not-public' };
  }
  return { ok: true, reason: 'public-kind' };
}

/** 中继的登记表。 */
export class RelayRegistry {
  #peers = new Map(); // publicKeyId → { peerKey, connectionKey, document, registeredAt, lastSeen, forwardedBytes }
  #documents = new Map(); // publicKeyId → 自签名身份文档（原样保存，不加任何字段）
  #keyChanges = new Map(); // publicKeyId → 是否检测到加密密钥变更
  #policy;
  #now;

  constructor({ policy = DEFAULT_RELAY_POLICY, now = () => Date.now() } = {}) {
    this.#policy = { ...DEFAULT_RELAY_POLICY, ...policy };
    this.#now = now;
  }

  get size() {
    return this.#peers.size;
  }

  get policy() {
    return { ...this.#policy };
  }

  /** 登记一个对端。返回是否成功（超出容量会被拒）。 */
  register({ peerKey, connectionKey, document }) {
    this.#sweep();
    const existing = this.#peers.get(peerKey);
    if (!existing && this.#peers.size >= this.#policy.maxPeers) {
      return { ok: false, reason: 'relay-at-capacity' };
    }

    // 文档必须自签名才入库 —— 否则中继可以塞一个假的加密公钥做中间人。
    let accepted = null;
    if (document) {
      const verdict = verifyIdentityDocument(document, { known: this.#documents.get(peerKey) ?? null });
      if (verdict.valid) {
        accepted = document;
        // **原样保存**，绝不往里面加字段。
        // 早先写成 { ...document, keyChanged } —— 多出来的字段会参与签名校验，
        // 于是中继一转交，对方就验不过签名了（"包装一下就破坏被包装对象"，
        // 这在本项目里已经是第三次踩同一个坑）。keyChanged 单独存。
        this.#documents.set(peerKey, document);
        this.#keyChanges.set(peerKey, verdict.keyChanged);
      }
    }

    this.#peers.set(peerKey, {
      peerKey,
      connectionKey,
      registeredAt: existing?.registeredAt ?? this.#now(),
      lastSeen: this.#now(),
      forwardedBytes: existing?.forwardedBytes ?? 0,
      hasDocument: Boolean(accepted) || Boolean(existing?.hasDocument),
    });
    return { ok: true, documentAccepted: Boolean(accepted) };
  }

  unregister(peerKey) {
    return this.#peers.delete(peerKey);
  }

  /** 按连接反查，连接断开时清理。 */
  unregisterByConnection(connectionKey) {
    let removed = 0;
    for (const [peerKey, entry] of [...this.#peers]) {
      if (entry.connectionKey === connectionKey) {
        this.#peers.delete(peerKey);
        removed += 1;
      }
    }
    return removed;
  }

  lookup(peerKey) {
    this.#sweep();
    return this.#peers.get(peerKey) ?? null;
  }

  documentOf(peerKey) {
    return this.#documents.get(peerKey) ?? null;
  }

  /** 该身份的加密密钥是否发生过变更（要提示用户，不能静默接受）。 */
  keyChanged(peerKey) {
    return this.#keyChanges.get(peerKey) === true;
  }

  /** 记账一次转发（用于限速）。 */
  noteForward(peerKey, bytes) {
    const entry = this.#peers.get(peerKey);
    if (entry) {
      entry.lastSeen = this.#now();
      entry.forwardedBytes += bytes;
    }
  }

  /** 汇总负载，供 `RELAY_LOAD` 公告与界面展示。 */
  load() {
    this.#sweep();
    const now = this.#now();
    let bytesLastMinute = 0;
    for (const entry of this.#peers.values()) {
      if (now - entry.lastSeen < 60_000) bytesLastMinute += entry.forwardedBytes;
    }
    return {
      peers: this.#peers.size,
      capacity: this.#policy.maxPeers,
      /** 用"已服务/上限"作为简单的饱和度指标。 */
      saturation: this.#policy.maxPeers > 0 ? this.#peers.size / this.#policy.maxPeers : 0,
      documents: this.#documents.size,
    };
  }

  listPeers() {
    this.#sweep();
    return [...this.#peers.values()].map((entry) => ({ ...entry }));
  }

  /** 清理超时未活动的登记。规划 §9.5：不把短期在线视为永久稳定。 */
  #sweep() {
    const deadline = this.#now() - this.#policy.peerTtlMs;
    for (const [peerKey, entry] of [...this.#peers]) {
      if (entry.lastSeen < deadline) this.#peers.delete(peerKey);
    }
  }
}

/**
 * 中继服务端：跑在一台公网可达的节点上。
 *
 * 它不主动连任何人，只在别人连进来之后提供服务 —— 顺序很重要，
 * 因为这决定了它不需要任何 NAT 穿透能力。
 */
export class RelayServer {
  #transport;
  #identity;
  #registry;
  #logger;
  #policy;
  #metrics = {
    registered: 0, registrationsRejected: 0,
    forwarded: 0, refusedPlaintext: 0, unreachable: 0,
    bytesForwarded: 0, lookups: 0,
    /** 打洞信令：中继只做搬运，不参与连接。 */
    punchSignals: 0, punchReports: 0,
    /** 入站实证。 */
    probesServed: 0, probesRefused: 0,
  };
  /** peerKey → 本机（中继）看到的来源地址。 */
  #observed = new Map();
  /** 入站实证的速率限制：peerKey → 最近若干次探测的时间戳。 */
  #probeHistory = new Map();

  constructor({ transport, identity, logger = null, policy = {} }) {
    this.#transport = transport;
    this.#identity = identity;
    this.#logger = logger;
    this.#policy = { ...DEFAULT_RELAY_POLICY, ...policy };
    this.#registry = new RelayRegistry({ policy: this.#policy });
  }

  get registry() {
    return this.#registry;
  }

  get metrics() {
    return { ...this.#metrics, ...this.#registry.load(), policy: this.#registry.policy };
  }

  /** 挂到传输层的信封流上。返回卸载函数。 */
  attach() {
    const onEnvelope = ({ envelope, peerKey, observedAddress }) => {
      this.noteObservedAddress(peerKey, observedAddress);
      this.#handle(envelope, peerKey);
    };
    const onPeerDown = (peer) => {
      this.#registry.unregisterByConnection(peer.peerKey);
    };
    this.#transport.on('envelope', onEnvelope);
    this.#transport.on('peer-down', onPeerDown);
    return () => {
      this.#transport.off('envelope', onEnvelope);
      this.#transport.off('peer-down', onPeerDown);
    };
  }

  #send(peerKey, kind, payload) {
    try {
      if (kind === MESSAGE_KIND.RELAY_FORWARD || kind === MESSAGE_KIND.RELAY_DOCUMENT) {
        // 控制消息不进分类闸门（它们由本模块自己产出），但仍要计入限速。
        const envelope = this.#seal(kind, payload, peerKey);
        const size = JSON.stringify(envelope).length;
        if (size > this.#policy.maxEnvelopeBytes) return false;
        if (this.#policy.maxForwardBytesPerMinute > 0) {
          const bytesLastMinute = this.#bytesLastMinute();
          if (bytesLastMinute + size > this.#policy.maxForwardBytesPerMinute) {
            this.#logger?.warn?.('中继超过每分钟转发上限，丢弃', { size, bytesLastMinute });
            return false;
          }
        }
        this.#recentForwards.push({ at: Date.now(), bytes: size });
        if (this.#recentForwards.length > 512) this.#recentForwards.splice(0, this.#recentForwards.length - 512);
        this.#registry.noteForward(peerKey, size);
        this.#metrics.bytesForwarded += size;
        return this.#transport.send(peerKey, envelope);
      }
      return this.#transport.send(peerKey, this.#seal(kind, payload, peerKey));
    } catch (error) {
      this.#logger?.warn?.('中继发送失败', { message: error?.message, kind });
      return false;
    }
  }

  /** 最近 60 秒实际转发的字节数。用一个滑动窗口而不是累计值 —— 累计值永远只增不减。 */
  #recentForwards = [];
  #bytesLastMinute() {
    const deadline = Date.now() - 60_000;
    this.#recentForwards = this.#recentForwards.filter((entry) => entry.at >= deadline);
    return this.#recentForwards.reduce((sum, entry) => sum + entry.bytes, 0);
  }

  #seal(kind, payload, to) {
    return this.#codecSeal(kind, payload, to);
  }

  /** 由外部注入的信封封装函数（复用同一个 codec，保证序号与签名一致）。 */
  #codecSeal = () => { throw new Error('RelayServer 未注入 codec'); };

  useSeal(fn) {
    this.#codecSeal = fn;
    return this;
  }

  /** 记下每个对端在本机看来长什么样（NAT 之后就是它的公网端点）。 */
  noteObservedAddress(peerKey, address) {
    if (typeof address === 'string' && address.length > 0) this.#observed.set(peerKey, address);
  }

  #observedAddress(peerKey) {
    return this.#observed.get(peerKey) ?? null;
  }

  /**
   * 真的去连一次，然后如实回报。
   *
   * `ok` 的判据是**握手完成且对端身份正是请求方** —— 不是"TCP 连上了"。
   * 一个连上就断的端口不是可达的证据。
   *
   * 公开（而非私有）是为了能单独测这条判据：单机环境下本机地址不是公网地址，
   * 走完整链路一定会被安全闸门挡在 `refused-non-public-target`，
   * 于是"身份对不上要判失败"这条逻辑就永远测不到。把它暴露出来，
   * 就能用两个真实节点验证成功与身份不匹配两条路径 —— **闸门归闸门，判据归判据。**
   *
   * ⚠️ 调用方必须自己先过 `isProbeableAddress`，否则它就是个端口扫描器。
   */
  async probeInbound(address, expectedPeerKey) {
    const startedAt = Date.now();
    try {
      const peerKey = await this.#transport.connect(address, { timeoutMs: 5000 });
      const elapsedMs = Date.now() - startedAt;
      const matched = peerKey === expectedPeerKey;
      if (!matched) {
        this.#logger?.warn?.('入站实证连上了，但身份对不上', { address, expected: expectedPeerKey, got: peerKey });
      }
      return {
        ok: matched,
        reason: matched ? 'inbound-verified' : 'identity-mismatch',
        elapsedMs,
        /** 如实回报是谁应答的：身份不对时请求方能看出来。 */
        responder: peerKey ?? null,
      };
    } catch (error) {
      return {
        ok: false,
        reason: `unreachable:${error?.code ?? error?.message ?? 'unknown'}`,
        elapsedAtMs: Date.now() - startedAt,
      };
    }
  }

  #handle(envelope, peerKey) {
    if (!envelope || !RELAY_CONTROL_KINDS.includes(envelope.kind)) return;

    switch (envelope.kind) {
      case MESSAGE_KIND.RELAY_REGISTER: {
        const result = this.#registry.register({
          peerKey,
          connectionKey: peerKey,
          document: envelope.payload?.document ?? null,
        });
        if (!result.ok) {
          this.#metrics.registrationsRejected += 1;
          this.#send(peerKey, MESSAGE_KIND.RELAY_REGISTERED, { ok: false, reason: result.reason });
          return;
        }
        this.#metrics.registered += 1;
        this.#send(peerKey, MESSAGE_KIND.RELAY_REGISTERED, {
          ok: true,
          publicKeyId: this.#identity.publicKeyId,
          load: this.#registry.load(),
          policy: {
            maxEnvelopeBytes: this.#policy.maxEnvelopeBytes,
            requireSealedForPrivate: this.#policy.requireSealedForPrivate,
          },
        });
        this.#logger?.info?.('中继登记了对端', { peerKey, peers: this.#registry.size });
        break;
      }

      case MESSAGE_KIND.RELAY_FORWARD: {
        const target = envelope.payload?.to;
        const inner = envelope.payload?.envelope;
        if (typeof target !== 'string' || !inner) return;

        const verdict = classifyForward(inner);
        if (!verdict.ok) {
          // fail-closed：来源不明的明文一律不转发，并记账（这是可被审计的）。
          this.#metrics.refusedPlaintext += 1;
          this.#logger?.warn?.('中继拒绝转发非密文/非公开内容', {
            from: envelope.from, to: target, kind: inner.kind, reason: verdict.reason,
          });
          this.#send(peerKey, MESSAGE_KIND.RELAY_UNREACHABLE, { to: target, reason: `refused:${verdict.reason}` });
          return;
        }

        const record = this.#registry.lookup(target);
        if (!record) {
          this.#metrics.unreachable += 1;
          this.#send(peerKey, MESSAGE_KIND.RELAY_UNREACHABLE, { to: target, reason: 'not-registered' });
          return;
        }

        const size = JSON.stringify(inner).length;
        if (size > this.#policy.maxEnvelopeBytes) {
          this.#send(peerKey, MESSAGE_KIND.RELAY_UNREACHABLE, { to: target, reason: 'envelope-too-large' });
          return;
        }

        // 转发时**原样搬走**内层信封，只是加上"谁发的"这一层转交信息。
        // 中继不碰内层载荷、不做任何改写 —— 改写会破坏端到端签名。
        const ok = this.#send(record.peerKey, MESSAGE_KIND.RELAY_FORWARD, {
          from: envelope.from,
          envelope: inner,
        });
        if (ok) this.#metrics.forwarded += 1;
        else this.#send(peerKey, MESSAGE_KIND.RELAY_UNREACHABLE, { to: target, reason: 'delivery-failed' });
        break;
      }

      case MESSAGE_KIND.RELAY_LOOKUP: {
        this.#metrics.lookups += 1;
        const target = envelope.payload?.peerKey;
        const record = typeof target === 'string' ? this.#registry.lookup(target) : null;
        this.#send(peerKey, MESSAGE_KIND.RELAY_DOCUMENT, {
          peerKey: target ?? null,
          /** 文档是自签名的：中继只能转交，不能伪造。查不到就如实说查不到。 */
          document: record ? this.#registry.documentOf(target) : null,
          online: Boolean(record),
        });
        break;
      }

      case MESSAGE_KIND.RELAY_LOAD: {
        this.#send(peerKey, MESSAGE_KIND.RELAY_LOAD, this.#registry.load());
        break;
      }

      case MESSAGE_KIND.PUNCH_PROBE: {
        /**
         * STUN 那一步：告诉对方"我看到的你的来源地址是什么"。
         *
         * NAT 之后，这个地址就是 NAT 分配给对方的公网端点 ——
         * 而且**只有我们（对端之外的一方）才看得到**，对方自己是看不到的。
         * 这正是打洞需要信令的原因。
         */
        const observed = this.#observedAddress(peerKey);
        this.#send(peerKey, MESSAGE_KIND.PUNCH_ENDPOINT, { observed });
        break;
      }

      case MESSAGE_KIND.PUNCH_OFFER: {
        // 把 A 的候选转交给 B。中继在这里只做搬运，不参与连接。
        const target = envelope.payload?.to;
        const candidates = envelope.payload?.candidates;
        if (typeof target !== 'string' || !Array.isArray(candidates)) return;
        const record = this.#registry.lookup(target);
        if (!record) {
          this.#send(peerKey, MESSAGE_KIND.RELAY_UNREACHABLE, { to: target, reason: 'not-registered' });
          return;
        }
        this.#metrics.punchSignals += 1;
        this.#send(record.peerKey, MESSAGE_KIND.PUNCH_CANDIDATE, {
          from: envelope.from,
          candidates,
          natType: envelope.payload?.natType ?? NAT_TYPE.UNKNOWN,
          /**
           * 附上中继**自己观察到**的发送方端点。
           * 自报的候选可能是内网地址（对方根本到不了），
           * 而中继看到的这个地址一定是对外可见的那个 —— 两者互补。
           */
          observed: this.#observedAddress(envelope.from),
        });
        break;
      }

      case MESSAGE_KIND.REACH_PROBE: {
        /**
         * 入站实证：**中继主动连回请求方一次**，回报能不能连上。
         *
         * 这是唯一能回答"别人能不能连进来"的测试 ——
         * 本机再怎么分析自己的 IP、NAT 类型、防火墙，都只是推断；
         * 只有第三方真的连进来过，才是证据。
         */
        const requested = envelope.payload?.address;
        const reply = (payload) => this.#send(peerKey, MESSAGE_KIND.REACH_RESULT, payload);

        /**
         * **安全闸门：只能探测全球可路由的地址。**
         *
         * 这个接口的本意是"帮我确认我自己能不能被连入"。如果不加限制，
         * 它就是一个**端口扫描器**：任何登记过的对端都能让中继去连
         * 192.168.x.x、127.0.0.1、或者云上的元数据地址 169.254.169.254，
         * 从而把中继当成跳板来探测内网。所以内网/回环/链路本地/CGNAT 一律拒绝，
         * 哪怕请求方说那是它自己的地址。
         */
        if (!isProbeableAddress(requested)) {
          this.#metrics.probesRefused += 1;
          this.#logger?.warn?.('拒绝入站实证：目标不是公网地址', { from: envelope.from, requested });
          reply({ ok: false, reason: 'refused-non-public-target' });
          return;
        }

        // 速率限制：实证要真的建立一个连接，不能让它变成免费的扫描配额。
        const now = Date.now();
        const history = (this.#probeHistory.get(peerKey) ?? []).filter((at) => now - at < 60_000);
        if (history.length >= 5) {
          this.#metrics.probesRefused += 1;
          reply({ ok: false, reason: 'rate-limited' });
          return;
        }
        history.push(now);
        this.#probeHistory.set(peerKey, history);

        this.#metrics.probesServed += 1;
        this.probeInbound(requested, envelope.from)
          .then((result) => reply(result))
          .catch((error) => reply({ ok: false, reason: `probe-error:${error?.message}` }));
        break;
      }

      case MESSAGE_KIND.PUNCH_RESULT: {
        this.#metrics.punchReports += 1;
        this.emit?.('punch-result', { ...envelope.payload, from: envelope.from });
        break;
      }

      default:
        break;
    }
  }
}

/**
 * 中继客户端：把本机挂到一台或多台公网中继上，并处理转发进来的信封。
 */
export class RelayClient {
  #identity;
  #logger;
  #transport;
  /** relayPeerKey → { address, registered, load, policy, lastSeen } */
  #relays = new Map();
  /** publicKeyId → { viaRelay, lastSeen, document } 通过中继可达的远端 */
  #relayedPeers = new Map();

  #metrics = { registered: 0, forwardedOut: 0, forwardedIn: 0, unreachable: 0, refused: 0 };

  /** 信誉账本与选择器：没有它们就只能"连上第一台见到的中继"。 */
  #ledger;
  #selector;
  #attestations;
  #punch = null;

  constructor({ transport, identity, logger = null, ledger = null, selector = null, attestations = null }) {
    this.#transport = transport;
    this.#identity = identity;
    this.#logger = logger;
    this.#ledger = ledger ?? new ReputationLedger();
    this.#selector = selector ?? new RelaySelector({ ledger: this.#ledger, logger });
    this.#attestations = attestations ?? new AttestationBook();
  }

  get ledger() { return this.#ledger; }
  get selector() { return this.#selector; }
  get attestations() { return this.#attestations; }
  get punch() { return this.#punch; }

  /** 打洞协调器要挂在同一个传输层上。 */
  attachPunch(punch) { this.#punch = punch; return this; }

  get metrics() {
    return {
      ...this.#metrics,
      relays: this.relays(),
      relayedPeers: [...this.#relayedPeers.keys()].length,
    };
  }

  relays() {
    return [...this.#relays.values()].map((entry) => ({ ...entry }));
  }

  hasRelay() {
    return [...this.#relays.values()].some((entry) => entry.registered);
  }

  /** 某个身份是否只能通过中继到达。 */
  isRelayed(peerKey) {
    return this.#relayedPeers.has(peerKey);
  }

  /** 登记为可达（对端用）。 */
  relayedPeerKeys() {
    return [...this.#relayedPeers.keys()];
  }

  /** 通过中继可达的远端明细（界面与上层节点视图用）。 */
  relayedPeers() {
    return [...this.#relayedPeers.entries()].map(([peerKey, info]) => ({ peerKey, ...info }));
  }

  /** 挂上传输层事件。返回卸载函数。 */
  attach() {
    const onEnvelope = ({ envelope, peerKey, observedAddress }) => this.#handle(envelope, peerKey, observedAddress);
    const onPeerUp = (peer) => this.#onPeerUp(peer);
    const onPeerDown = (peer) => this.#onPeerDown(peer);
    this.#transport.on('envelope', onEnvelope);
    this.#transport.on('peer-up', onPeerUp);
    this.#transport.on('peer-down', onPeerDown);
    return () => {
      this.#transport.off('envelope', onEnvelope);
      this.#transport.off('peer-up', onPeerUp);
      this.#transport.off('peer-down', onPeerDown);
    };
  }

  #codecSeal = () => { throw new Error('RelayClient 未注入 codec'); };

  useSeal(fn) {
    this.#codecSeal = fn;
    return this;
  }

  /**
   * 连接一台中继并**等登记完成**。
   *
   * 为什么要等：`registered` 只有在中继回 `relay-registered` 之后才为真，
   * 而 `lookup()` / `forward()` 都要求 `registered === true`。
   * 早先这里连接一建立就返回，调用方紧接着调 `lookup()` 会静默返回 false ——
   * 表现为"什么都查不到"，但代码里没有任何一处报错。这和 `connect()` 早先返回 null
   * 是同一类问题：**异步操作提前返回，让调用方以为成功了。**
   *
   * @returns {Promise<string|null>} 中继的 peerKey；登记被拒或超时返回 null
   */
  async connect(address, { timeoutMs = 8000, source = 'discovered' } = {}) {
    const peerKey = await this.#transport.connect(address);
    if (!peerKey) return null;

    let settle;
    const settled = new Promise((resolve) => { settle = resolve; });
    this.#relays.set(peerKey, {
      peerKey, address, source, registered: false, connectedAt: Date.now(), settle,
    });
    this.#sendRegister(peerKey);

    const result = await Promise.race([
      settled,
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    const entry = this.#relays.get(peerKey);
    if (entry) delete entry.settle;
    return result === peerKey ? peerKey : null;
  }

  #sendRegister(relayPeerKey) {
    try {
      const envelope = this.#codecSeal(MESSAGE_KIND.RELAY_REGISTER, {
        document: this.#identity.document(),
        capabilities: { relay: false },
      }, relayPeerKey);
      this.#transport.send(relayPeerKey, envelope);
    } catch (error) {
      this.#logger?.warn?.('中继登记失败', { message: error?.message });
    }
  }

  #onPeerUp(peer) {
    // 重连之后要重新登记 —— 中继那边会随连接断开清掉记录。
    const entry = this.#relays.get(peer.peerKey);
    if (entry && !entry.registered) this.#sendRegister(peer.peerKey);
  }

  #onPeerDown(peer) {
    if (this.#relays.has(peer.peerKey)) {
      this.#relays.get(peer.peerKey).registered = false;
      // 该中继承载的远端也随之不可达（除非还有别的中继）
      for (const [key, info] of [...this.#relayedPeers]) {
        if (info.viaRelay === peer.peerKey) this.#relayedPeers.delete(key);
      }
    }
  }

  /**
   * 通过中继把一个信封发给某个身份。
   * 依次尝试每台已登记的中继；收到 RELAY_UNREACHABLE 就换下一台。
   * @returns {boolean} 是否至少投出去了一份
   */
  forward(peerKey, envelope) {
    const usable = [...this.#relays.values()].filter((entry) => entry.registered && !this.#ledger.isBlocked(entry.peerKey));
    if (usable.length === 0) return false;

    /**
     * 按选择器打分排序，而不是"全都发一遍"。
     *
     * 早先是无差别地发给所有已登记中继 —— 那样虽然一定能送到，
     * 但每条消息的流量都要乘以中继数量，还会把消息交给用户并不信任的节点。
     * 现在优先用打分最高的那台；它回 unreachable 才换下一台。
     */
    const ranked = this.#selector.rank(usable, peerKey);
    const order = ranked.length > 0 ? ranked.map((item) => item.relay) : usable;

    let sent = false;
    for (const relay of order) {
      try {
        const wrapper = this.#codecSeal(MESSAGE_KIND.RELAY_FORWARD, {
          to: peerKey,
          envelope,
        }, relay.peerKey);
        if (this.#transport.send(relay.peerKey, wrapper)) {
          sent = true;
          this.#metrics.forwardedOut += 1;
          // 目标亲和性：下次同一个目标优先用这台
          this.#selector.noteSuccess(relay.peerKey, peerKey);
          break; // 交给打分最高的那台就够了；它不通会回 unreachable，那时再换
        }
      } catch (error) {
        this.#logger?.warn?.('中继转发失败', { message: error?.message, relay: relay.peerKey });
        this.#ledger.record(relay.peerKey, OBSERVATION.DISCONNECTED);
      }
    }
    return sent;
  }

  /** 换下一台中继重发（收到 unreachable 时调用）。 */
  retryElsewhere(peerKey, envelope, excludePeerKey) {
    const candidates = [...this.#relays.values()]
      .filter((entry) => entry.registered && entry.peerKey !== excludePeerKey && !this.#ledger.isBlocked(entry.peerKey));
    const ranked = this.#selector.rank(candidates, peerKey);
    for (const { relay } of ranked) {
      try {
        const wrapper = this.#codecSeal(MESSAGE_KIND.RELAY_FORWARD, { to: peerKey, envelope }, relay.peerKey);
        if (this.#transport.send(relay.peerKey, wrapper)) return relay.peerKey;
      } catch {
        // 换下一台
      }
    }
    return null;
  }

  /**
   * 向**最佳中继**发一条控制消息（不经 RELAY_FORWARD 包装）。
   *
   * 打洞信令必须走这条路。早先它被当成普通内容塞进 RELAY_FORWARD，
   * 结果是中继的转发闸门判定它是"明文私聊"，直接拒转 ——
   * 打洞信令一个字都出不去，表现为双方都 punch-timeout。
   *
   * 控制消息由中继自己处理，不经过内容闸门（闸门是给"内容"用的）。
   */
  sendControl(kind, payload, { to = undefined } = {}) {
    const usable = [...this.#relays.values()].filter((entry) => entry.registered && !this.#ledger.isBlocked(entry.peerKey));
    if (usable.length === 0) return false;
    const ranked = this.#selector.rank(usable, to ?? null);
    const relay = ranked.length > 0 ? ranked[0].relay : usable[0];
    try {
      return this.#transport.send(relay.peerKey, this.#codecSeal(kind, payload, relay.peerKey));
    } catch (error) {
      this.#logger?.warn?.('控制消息发送失败', { kind, message: error?.message });
      return false;
    }
  }

  /** 向中继查询某个身份的自签名文档。 */
  lookup(peerKey) {
    const relay = [...this.#relays.values()].find((entry) => entry.registered);
    if (!relay) return false;
    try {
      const envelope = this.#codecSeal(MESSAGE_KIND.RELAY_LOOKUP, { peerKey }, relay.peerKey);
      return this.#transport.send(relay.peerKey, envelope);
    } catch {
      return false;
    }
  }

  documentOf(peerKey) {
    return this.#relayedPeers.get(peerKey)?.document ?? null;
  }

  #handle(envelope, peerKey, observedAddress = null) {
    if (!envelope || !RELAY_CONTROL_KINDS.includes(envelope.kind)) return;

    // 只有"我们主动连上去的那台中继"发来的控制消息才可信。
    if (!this.#relays.has(peerKey)) {
      if (envelope.kind === MESSAGE_KIND.RELAY_FORWARD || envelope.kind === MESSAGE_KIND.RELAY_DOCUMENT) {
        this.#metrics.refused += 1;
        this.#logger?.warn?.('来自非中继连接的控制消息，已忽略', { from: peerKey, kind: envelope.kind });
      }
      return;
    }

    switch (envelope.kind) {
      case MESSAGE_KIND.RELAY_REGISTERED: {
        const entry = this.#relays.get(peerKey);
        if (!entry) return;
        entry.registered = envelope.payload?.ok === true;
        entry.load = envelope.payload?.load ?? null;
        entry.policy = envelope.payload?.policy ?? null;
        entry.lastSeen = Date.now();
        if (entry.registered) {
          this.#metrics.registered += 1;
          this.#logger?.info?.('已在中继上登记', { relay: peerKey, address: entry.address });
        } else {
          this.#logger?.warn?.('中继拒绝登记', { relay: peerKey, reason: envelope.payload?.reason });
          this.#ledger.record(peerKey, OBSERVATION.REGISTER_REFUSED, { detail: envelope.payload?.reason });
        }
        // 无论成功还是被拒都兑现，让 connect() 立刻得到结论而不是干等超时。
        entry.settle?.(entry.registered ? peerKey : null);
        this.#transport.emit('relay-state', { relay: peerKey, ...entry });
        break;
      }

      case MESSAGE_KIND.RELAY_FORWARD: {
        const from = envelope.payload?.from;
        const inner = envelope.payload?.envelope;
        if (typeof from !== 'string' || !inner) return;
        this.#metrics.forwardedIn += 1;
        this.#noteRelayedPeer(from, peerKey, envelope.payload?.document ?? null);
        // 把内层信封当作"来自 from 的普通信封"交给上层 —— 上层不需要知道它经过了中继。
        this.#transport.emit('envelope', { envelope: inner, peerKey: from, relayed: true, observedAddress });
        break;
      }

      case MESSAGE_KIND.RELAY_DOCUMENT: {
        const target = envelope.payload?.peerKey;
        if (typeof target !== 'string') return;
        const document = envelope.payload?.document ?? null;
        if (document) {
          const verdict = verifyIdentityDocument(document);
          if (!verdict.valid) {
            // 中继转交了一份签名对不上的文档 —— 它在试图做中间人。
            this.#ledger.record(peerKey, OBSERVATION.FORGED_DOCUMENT, { detail: verdict.problems.join(',') });
            this.#logger?.error?.('中继转交了伪造的身份文档，已记入信誉并拉黑', { relay: peerKey });
            this.#transport.emit('relay-forgery', { relay: peerKey, problems: verdict.problems });
            break;
          }
        }
        if (document) this.#noteRelayedPeer(target, peerKey, document);
        this.#transport.emit('relay-document', {
          peerKey: target,
          document,
          online: envelope.payload?.online === true,
        });
        break;
      }

      case MESSAGE_KIND.RELAY_UNREACHABLE: {
        this.#metrics.unreachable += 1;
        const reason = envelope.payload?.reason ?? 'unknown';
        /**
         * 区分两种"不可达"，它们对信誉的含义完全相反：
         *   not-registered / 目标真的不在线 → 中继没做错什么
         *   refused:plaintext-refused      → **中继违背了职责**（它承诺转发密文却没转），
         *                                     用户会以为消息发出去了，这是静默失败，最该重罚
         */
        if (typeof reason === 'string' && reason.startsWith('refused:')) {
          this.#ledger.record(peerKey, OBSERVATION.REFUSED_SEALED, { detail: reason });
          this.#logger?.error?.('中继拒绝转发密文，已记入信誉并会降低其优先级', { relay: peerKey, reason });
        } else {
          this.#ledger.record(peerKey, OBSERVATION.UNREACHABLE, { detail: reason });
        }
        this.#transport.emit('relay-unreachable', { relay: peerKey, ...envelope.payload });
        break;
      }

      case MESSAGE_KIND.RELAY_LOAD: {
        const entry = this.#relays.get(peerKey);
        if (entry) entry.load = envelope.payload ?? null;
        this.#transport.emit('relay-load', { relay: peerKey, load: envelope.payload ?? null });
        break;
      }

      default:
        /**
         * 打洞控制消息（punch-endpoint / punch-candidate）在这里要**转交出去**。
         *
         * 早先这里是空的 `break`，于是中继回的端点探测结果、对方回的候选地址
         * 全都被静静吃掉 —— 打洞协调器永远收不到东西，表现是每次都 `punch-timeout`，
         * 而且日志里一个字都没有。控制消息被"处理了但没处理"是最难查的一类问题。
         */
        if (typeof envelope.kind === 'string'
          && (envelope.kind.startsWith('punch-') || envelope.kind.startsWith('reach-'))) {
          this.#transport.emit('relay-control', { envelope, peerKey, observedAddress });
        }
        break;
    }
  }

  #noteRelayedPeer(peerKey, relayPeerKey, document) {
    const existing = this.#relayedPeers.get(peerKey);
    const isNew = !existing;
    this.#ledger.record(relayPeerKey, OBSERVATION.FORWARD_OK);
    this.#relayedPeers.set(peerKey, {
      viaRelay: relayPeerKey,
      lastSeen: Date.now(),
      document: document ?? existing?.document ?? null,
    });
    if (isNew) {
      this.#transport.emit('peer-up', {
        peerKey,
        direction: 'relay',
        address: null,
        relayed: true,
        viaRelay: relayPeerKey,
        nickname: document?.nickname ?? null,
      });
    }
  }
}

/**
 * 组合传输层：**直连优先，连不上就走中继**。
 *
 * 对上层（peers / live / share / index.js）而言它只是一个 `NodeTransport`，
 * 不需要知道某条消息是直连送出去的还是中继转的。
 *
 * 「直连优先」不是优化，是隐私与成本上的取舍：直连不经过任何第三方，
 * 也不消耗别人的带宽。只有直连确实不可达时才动用中继。
 */
export class RelayTransport extends NodeTransport {
  #inner;
  #client;
  #logger;
  #server = null;
  #ledger;
  #punch;

  constructor({ inner, identity, logger = null, enableRelayServer = false, policy = {}, punch = {} }) {
    super();
    this.#inner = inner;
    this.#logger = logger;
    this.setDefaultErrorHandler((error, context) => {
      this.#logger?.warn?.('中继传输层错误', { message: error?.message, ...(context ?? {}) });
    });
    this.#ledger = new ReputationLedger();
    this.#client = new RelayClient({ transport: inner, identity, logger, ledger: this.#ledger });
    this.#punch = new PunchCoordinator({
      transport: inner, relayClient: this.#client, identity, logger,
      punchTimeoutMs: punch.timeoutMs ?? 4000,
      dialTimeoutMs: punch.dialTimeoutMs ?? 2500,
    });
    this.#client.attachPunch(this.#punch);
    if (enableRelayServer) {
      this.#server = new RelayServer({ transport: inner, identity, logger, policy });
    }
  }

  get name() {
    return this.#server ? 'lan+relay' : 'lan+relay-client';
  }

  get running() {
    return this.#inner.running;
  }

  get address() {
    return this.#inner.address;
  }

  get listenAddress() {
    return this.#inner.listenAddress;
  }

  /** 直接可达的节点（不含通过中继可达的）。 */
  get directTransport() {
    return this.#inner;
  }

  get relayClient() {
    return this.#client;
  }

  get relayServer() {
    return this.#server;
  }

  /** 注入信封封装函数（中继控制消息需要签名，用的是同一个 codec）。 */
  get ledger() { return this.#ledger; }
  get punch() { return this.#punch; }
  get selector() { return this.#client.selector; }

  useCodecSeal(fn) {
    this.#client.useSeal(fn);
    this.#server?.useSeal(fn);
    this.#punch.useCodecSeal(fn);
    return this;
  }

  #dispose = () => {};

  async start() {
    const disposeClient = this.#client.attach();
    const disposeServer = this.#server?.attach() ?? null;
    const disposePunch = this.#punch.attach();

    // 把内层事件转发出去，并补上"通过中继可达"的节点。
    /**
     * 要透传给上层的内部事件。
     * 早先漏了 punch-*，于是打洞协调器在工作、但外界一个事件都收不到 ——
     * 表现是测试里 `punch-endpoint` 永远不触发。**协调器在跑不等于事件出得来。**
     */
    const forwardEvents = [
      'peer-up', 'peer-down', 'discovered', 'error', 'envelope',
      'punch-endpoint', 'punch-candidate',
    ];
    const handlers = new Map();
    for (const event of forwardEvents) {
      const handler = (...args) => this.emit(event, ...args);
      handlers.set(event, handler);
      this.#inner.on(event, handler);
    }

    // 中间层事件（relay-state / relay-document / relay-unreachable / relay-load）也要透传。
    const relayEvents = ['relay-state', 'relay-document', 'relay-unreachable', 'relay-load', 'relay-control'];
    const relayHandlers = new Map();
    for (const event of relayEvents) {
      const handler = (payload) => {
        if (event === 'relay-document') {
          this.emit('peer-up', {
            peerKey: payload.peerKey, direction: 'relay', relayed: true, nickname: payload.document?.nickname ?? null,
          });
        }
        this.emit(event, payload);
      };
      relayHandlers.set(event, handler);
      this.#inner.on(event, handler);
    }

    this.#dispose = () => {
      disposeClient();
      disposeServer?.();
      disposePunch();
      for (const [event, handler] of handlers) this.#inner.off(event, handler);
      for (const [event, handler] of relayHandlers) this.#inner.off(event, handler);
    };

    await this.#inner.start();
    return this;
  }

  /** 接入一台中继。`source: manual` 的会永远优先于自动发现的。 */
  async addRelay(address, { source = 'manual' } = {}) {
    const peerKey = await this.#client.connect(address, { source });
    if (peerKey) this.#logger?.info?.('已连接中继', { address, peerKey });
    return peerKey;
  }

  /**
   * 尝试与某个身份打洞（打通就省下中继带宽）。
   * **失败不是错误** —— 打不通就继续走中继，可用性不受影响。
   */
  async punchWith(peerKey) {
    const outcome = await this.#punch.punchWith(peerKey);
    if (outcome.ok) {
      this.#logger?.info?.('打洞成功，已切换为直连', { peerKey, address: outcome.address });
      this.#client.ledger.noteContribution('punch-saved', 0);
      this.emit('punch-result', { peerKey, ...outcome });
    } else {
      this.#logger?.debug?.('打洞未成功，继续使用中继', { peerKey, reason: outcome.reason });
      this.emit('punch-result', { peerKey, ...outcome });
    }
    return outcome;
  }

  /**
   * 入站实证：请一台中继真的连回来一次。
   *
   * 这是唯一能证明"别人能连进来"的手段。本机的 IP 分析、NAT 类型推断、
   * 防火墙猜测全都只是推断 —— 只有第三方真的连上了，才算证据。
   *
   * @param {string} address 本机对外宣称的地址（host:port 或 [v6]:port）
   * @returns {Promise<{ok: boolean, reason: string, relay?: string, elapsedMs?: number}>}
   */
  async proveReachable(address, { timeoutMs = 8000 } = {}) {
    const usable = this.#client.relays().filter((entry) => entry.registered);
    if (usable.length === 0) {
      return { ok: false, reason: 'no-relay-to-probe-with' };
    }
    if (!isProbeableAddress(address)) {
      // 本机地址不是公网地址时，根本没有必要（也不可能）被实证成功。
      return { ok: false, reason: 'local-address-not-public', address };
    }

    const startedAt = Date.now();
    const relay = this.#client.selector.rank(usable)[0]?.relay ?? usable[0];

    let settle;
    const answered = new Promise((resolve) => { settle = resolve; });
    const onControl = ({ envelope, peerKey }) => {
      if (envelope.kind !== MESSAGE_KIND.REACH_RESULT || peerKey !== relay.peerKey) return;
      settle({ relay: relay.peerKey, ...envelope.payload });
    };
    this.#inner.on('relay-control', onControl);

    try {
      this.#client.sendControl(MESSAGE_KIND.REACH_PROBE, { address });
      const result = await Promise.race([
        answered,
        new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: 'probe-timeout' }), timeoutMs)),
      ]);
      this.emit('reach-probe', { address, ...result });
      return { ...result, elapsedMs: result.elapsedMs ?? Date.now() - startedAt };
    } finally {
      this.#inner.off('relay-control', onControl);
    }
  }

  /** 与某个身份通信前的完整策略：先试直连，再试打洞，最后中继。 */
  async ensureReachable(peerKey) {
    if (this.#inner.peers().some((peer) => peer.peerKey === peerKey)) {
      return { route: 'direct', reason: 'already-connected' };
    }
    const punch = await this.punchWith(peerKey);
    if (punch.ok) return { route: 'direct', reason: 'punched', address: punch.address };
    if (this.#client.isRelayed(peerKey)) return { route: 'relay', reason: 'already-registered' };
    return { route: 'relay', reason: punch.reason };
  }

  async stop() {
    this.#dispose();
    await this.#inner.stop();
  }

  async connect(address) {
    return this.#inner.connect(address);
  }

  /**
   * 统一节点视图：直连的 + 通过中继可达的。
   * 上层据此展示"谁在线"，不需要区分链路类型 —— 但每条记录都带 `relayed` 标记，
   * 好让界面能如实说明"这台是通过中继连上的"。
   */
  peers() {
    const direct = this.#inner.peers();
    const seen = new Set(direct.map((peer) => peer.peerKey));
    const relayed = this.#client.relayedPeers()
      .filter((peer) => !seen.has(peer.peerKey))
      .map((peer) => ({
        peerKey: peer.peerKey,
        direction: 'relay',
        relayed: true,
        viaRelay: peer.viaRelay,
        address: null,
        connectedAt: null,
        lastSeen: peer.lastSeen ?? null,
        nickname: peer.document?.nickname ?? null,
        encryptionKeyId: peer.document?.encryptionKeyId ?? null,
      }));
    return [...direct, ...relayed];
  }

  /** 直连优先，失败再走中继。 */
  send(peerKey, envelope) {
    const direct = this.#inner.peers().some((peer) => peer.peerKey === peerKey);
    if (direct) return this.#inner.send(peerKey, envelope);
    return this.#client.forward(peerKey, envelope);
  }

  broadcast(envelope) {
    for (const peer of this.peers()) this.send(peer.peerKey, envelope);
  }

  discovered() {
    return this.#inner.discovered?.() ?? [];
  }

  createInvite() {
    return this.#inner.createInvite();
  }

  get metrics() {
    return {
      inner: this.#inner.metrics,
      relay: this.#client.metrics,
      relayServer: this.#server?.metrics ?? null,
    };
  }
}
