/**
 * 局域网传输：WebSocket 直连 + UDP 信标发现 + 双向身份握手。
 *
 * 对应规划 §9.3（节点发现与加入网络）与 §9.4（NAT 与连接可达性）的**第一个可用版本**。
 * 规划要求「从多个来源验证节点信息，避免依赖单一入口」，所以这里提供两条入网路径：
 *   1. UDP 广播信标：同一台机器 / 同一局域网内自动互相发现；
 *   2. 手工地址或邀请码：广播不可达时（跨网段、被防火墙拦），由用户粘贴 `host:port`
 *      或一段邀请码——对应规划里「由好友通过二维码或邀请信息分享节点连接信息」。
 *
 * 规划 §9.4 也明确说了 NAT 后面不一定能直连，需要打洞或中继。**本实现不解决 NAT 穿透**，
 * 这是刻意的：先在可达网络上把「发现 → 握手 → 签名消息 → 去重 → 断线重连」跑通并留下证据，
 * 再根据实测结果决定要不要引 libp2p / WebRTC。规划 §18.2 第 4 条就是这个意思。
 *
 * 握手协议（双向证明「我持有这个公钥的私钥」）：
 *   A → B  hello       { nonce: nA, node: {...} }            信封 from=A（已签名）
 *   B → A  hello-ack   { nonce: nB, echo: nA, node: {...} }  信封 from=B，to=A
 *   A → B  hello-ack   { nonce: nA, echo: nB, node: {...} }  信封 from=A，to=B
 * 每一步的签名由信封自身提供；`echo` 把这次交互绑定到**当前这条连接**上，
 * 使得重放一次旧的 hello 无法冒充对方（旧信封的时间戳与 id 也会被 codec 拦下）。
 */
import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';

import { MESSAGE_KIND, PROTOCOL_VERSION, randomId } from '../../shared/protocol.js';
import { fingerprintOfPublicKeyId } from '../identity.js';
import {
  formatPeerAddress, isLoopbackHost, isWildcardHost, parsePeerAddress, pickAdvertisableHost,
} from './address.js';
import { NodeTransport } from './transport.js';
import { connectWebSocket, createWebSocketServer } from './ws.js';

const WS_PATH = '/dsh-chat';

/** 把邀请信息编成一段可粘贴的文本（规划 §9.3）。 */
export function encodeInvite({ publicKeyId, nickname, address }) {
  const json = JSON.stringify({ v: PROTOCOL_VERSION, publicKeyId, nickname: nickname ?? null, address });
  return `dshchat1:${Buffer.from(json, 'utf8').toString('base64url')}`;
}

/** 解析邀请码。返回 null 表示这不是一个合法邀请码（调用方再当普通地址处理）。 */
export function decodeInvite(code) {
  if (typeof code !== 'string' || !code.startsWith('dshchat1:')) return null;
  try {
    const parsed = JSON.parse(Buffer.from(code.slice('dshchat1:'.length), 'base64url').toString('utf8'));
    // 用统一的地址解析：这里也要能吃下 [v6]:port，否则 IPv6 节点发出的邀请码自己都解不开。
    if (parsePeerAddress(parsed?.address) === null) return null;
    if (typeof parsed.publicKeyId !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export class LanTransport extends NodeTransport {
  #config;
  #identity;
  #codec;
  #logger;
  #nodeInfo;
  #server = null;
  #udp = null;
  #beaconTimer = null;
  /** 是否已经（或正在）停止；用于处理 start/stop 交错的竞态。 */
  #stopping = false;
  #sweepTimer = null;
  /** peerKey(公钥标识) → peer 记录 */
  #peers = new Map();
  /** connection → 会话状态 */
  #sessions = new Map();
  #discovered = new Map();
  #running = false;
  #connecting = new Set();
  #metrics = { connections: 0, handshakes: 0, failedHandshakes: 0, envelopesIn: 0, envelopesOut: 0, discoveries: 0 };

  constructor({ config, identity, codec, logger = null, nodeInfo = () => ({}) }) {
    super();
    this.#config = config;
    this.#identity = identity;
    this.#codec = codec;
    this.#logger = logger;
    // 兜底错误处理接到 logger（基类已经保证"有监听器"，这里只是让它有地方可记）。
    this.setDefaultErrorHandler((error, context) => {
      this.#logger?.warn?.('传输层错误', { message: error?.message, ...(context ?? {}) });
    });
    this.#nodeInfo = nodeInfo;
  }

  get name() {
    return 'lan-websocket';
  }

  get running() {
    return this.#running;
  }

  /**
   * 对外的可拨号地址。
   *
   * 监听地址与通告地址是**两个不同的东西**：`0.0.0.0` 适合监听（所有网卡），
   * 但它不是一个可以拨过去的目标。早先直接把监听地址广播出去，
   * 结果是信标和邀请码里写着 `0.0.0.0:47800` —— 看着正常，拨过去必然失败。
   * 所以对外一律换成具体地址（IPv6 还要补方括号）。
   */
  get address() {
    if (!this.#server) return null;
    const host = this.#config.listen.host;
    if (isWildcardHost(host)) {
      return pickAdvertisableHost(networkInterfaces(), this.#server.port);
    }
    return formatPeerAddress(host, this.#server.port);
  }

  /** 实际绑定的监听地址（界面「节点」页展示这个，便于排查）。 */
  get listenAddress() {
    if (!this.#server) return null;
    return formatPeerAddress(this.#config.listen.host, this.#server.port);
  }

  get metrics() {
    return {
      ...this.#metrics,
      listening: this.address,
      knownPeers: this.#peers.size,
      openConnections: this.#sessions.size,
      discovered: this.#discovered.size,
    };
  }

  /**
   * 启动。
   *
   * 注意这里有一个**容易被忽略的竞态**：`stop()` 可能在 `start()` 还没跑完时就被调用
   * （插件卸载、测试收尾都属于这种情况）。早先的写法是 stop() 看到 `#server` 还是 null
   * 就直接返回，随后 start() 把监听建起来 —— **监听 socket 再也没人关**，
   * 进程因此一直不退出。
   *
   * 现在用一个 `#stopping` 标记把这件事说清楚：启动过程中如果已经被要求停止，
   * 就在建好之后立刻关掉。
   */
  async start() {
    if (this.#running) return;
    this.#stopping = false;
    const server = await createWebSocketServer({
      host: this.#config.listen.host,
      port: this.#config.listen.port,
      path: WS_PATH,
      onConnection: (connection) => this.#onConnection(connection, 'inbound'),
      onError: (error) => this.emit('error', error, { stage: 'ws-server' }),
    });

    // 建好之后先检查：这期间是否已经被要求停止？
    if (this.#stopping) {
      await server.close().catch(() => {});
      this.#logger?.debug?.('启动尚未完成就被要求停止，监听已立即关闭');
      return;
    }

    this.#server = server;
    this.#running = true;
    this.#logger?.info?.('节点已开始监听', { address: this.address, transport: this.name });

    if (this.#config.discovery.enabled) this.#startDiscovery();

    // 手工地址：广播不可达时的兜底入口（规划 §9.3）。
    for (const address of this.#config.discovery.manualPeers) {
      this.connect(address).catch((error) => {
        this.#logger?.warn?.('手工节点连接失败', { address, message: error.message });
      });
    }
  }

  async stop() {
    // 先立标记：如果此时 start() 还在进行中，它会自己把刚建好的监听关掉。
    this.#stopping = true;
    this.#running = false;
    clearInterval(this.#beaconTimer);
    clearInterval(this.#sweepTimer);
    this.#beaconTimer = null;
    this.#sweepTimer = null;

    if (this.#udp) {
      try {
        this.#udp.close();
      } catch {
        // 已经关了。
      }
      this.#udp = null;
    }
    for (const { connection } of this.#sessions.values()) connection.destroy();
    this.#sessions.clear();

    if (this.#server) {
      await this.#server.close();
      this.#server = null;
    }
    for (const peerKey of [...this.#peers.keys()]) {
      this.#peers.delete(peerKey);
      this.emit('peer-down', { peerKey }, 'transport stopped');
    }
    this.#logger?.info?.('节点已停止监听');
  }

  peers() {
    return [...this.#peers.values()].map((peer) => ({ ...peer }));
  }

  /** 当前对外的邀请码（规划 §9.3：由好友分享节点连接信息）。 */
  createInvite() {
    if (!this.address) throw new Error('节点尚未启动，无法生成邀请码');
    return encodeInvite({
      publicKeyId: this.#identity.publicKeyId,
      nickname: this.#nodeInfo().nickname ?? null,
      address: this.address,
    });
  }

  /** 连接一个节点。address 可以是 'host:port' 或 'dshchat1:...' 邀请码。 */
  async connect(address, { timeoutMs = null } = {}) {
    const invite = decodeInvite(address);
    const target = invite?.address ?? address;
    const parsedTarget = parsePeerAddress(target);
    if (parsedTarget === null) {
      throw new Error(`节点地址应为 host:port、[v6]:port 或邀请码，收到: ${String(address)}`);
    }
    if (this.#connecting.has(target)) return null;
    this.#connecting.add(target);
    try {
      // 统一用解析后的 host/port 拼 URL，保证 IPv6 一定带方括号。
      const url = `ws://${formatPeerAddress(parsedTarget.host, parsedTarget.port)}${WS_PATH}`;
      const connection = await connectWebSocket(url, {
        timeoutMs: this.#config.network.connectTimeoutMs,
      });
      // 自己连自己会被服务端握手挡掉（下面 #onConnection 里按公钥比对），这里也提前拦一次。
      const session = this.#onConnection(connection, 'outbound', { expectedPeer: invite?.publicKeyId ?? null });
      // 拨号方主动发起握手。
      this.#sendHello(session);

      /**
       * **必须等握手真正完成再返回。**
       *
       * 早先这里直接 `return session.peerKey ?? null`，而那时对端还没来得及回 hello-ack，
       * 于是永远返回 null。调用方（比如中继客户端）看到 null 就以为连接失败，
       * 后面的登记根本不会发生 —— 症状是"连上了但什么都没发生"。
       * 一个返回 null 的 connect() 比抛错更糟：它让调用方以为自己处理了失败。
       */
      const waitMs = timeoutMs ?? this.#config.network.handshakeTimeoutMs;
      return await Promise.race([
        session.ready,
        new Promise((resolve) => setTimeout(() => resolve(null), waitMs)),
      ]);
    } finally {
      this.#connecting.delete(target);
    }
  }

  send(peerKey, envelope) {
    const peer = this.#peers.get(peerKey);
    if (!peer?.session) return false;
    const ok = peer.session.connection.send(JSON.stringify(envelope));
    if (ok) this.#metrics.envelopesOut += 1;
    return ok;
  }

  // ===== 内部 =====

  #onConnection(connection, direction, { expectedPeer = null } = {}) {
    this.#metrics.connections += 1;
    const session = {
      connection,
      direction,
      expectedPeer,
      peerKey: null,
      authenticated: false,
      /** 握手完成时兑现；connect() 靠它才能诚实地返回 peerKey。 */
      ready: null,
      resolveReady: null,
      nonce: randomId('nonce'),
      /** 带端口的来源地址（打洞要靠它拿到公网端点）。 */
      remoteAddress: connection.remoteEndpoint ?? connection.remoteAddress,
      // 超时值来自配置：不同网络差别很大，不该写死。
      timer: setTimeout(() => {
        if (!session.authenticated) {
          this.#metrics.failedHandshakes += 1;
          this.#logger?.warn?.('握手超时，断开连接', { direction, remote: session.remoteAddress });
          connection.close(1002, 'handshake timeout');
        }
      }, this.#config.network.handshakeTimeoutMs),
    };
    session.ready = new Promise((resolve) => { session.resolveReady = resolve; });
    this.#sessions.set(connection, session);

    connection.on('message', (text) => this.#onMessage(session, text));
    connection.on('close', () => this.#onClose(session));
    connection.on('error', (error) => this.emit('error', error, { stage: 'connection' }));
    return session;
  }

  #sendHello(session) {
    session.connection.send(JSON.stringify(this.#codec.seal(MESSAGE_KIND.HELLO, {
      nonce: session.nonce,
      node: this.#announcement(),
    })));
  }

  #announcement() {
    return {
      protocol: PROTOCOL_VERSION,
      publicKeyId: this.#identity.publicKeyId,
      fingerprint: this.#identity.fingerprint,
      /** 别人要给我发**加密**消息就需要它；这是公钥，可以广播。 */
      encryptionKeyId: this.#identity.encryptionKeyId,
      nickname: this.#nodeInfo().nickname ?? null,
      address: this.address,
      transport: this.name,
      /** 自我介绍：我是否对外提供中继服务、以及负载如何。 */
      relay: this.#nodeInfo().relay ?? null,
    };
  }

  /** 某个对端在**本机看来**的来源地址（NAT 之后就是它的公网端点）。 */
  observedAddressOf(peerKey) {
    for (const session of this.#sessions.values()) {
      if (session.peerKey === peerKey) return session.remoteAddress ?? null;
    }
    return null;
  }

  #onMessage(session, text) {
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      session.connection.close(1003, 'invalid json');
      return;
    }

    // 握手阶段的信封也走完整的签名校验；codec 负责版本、时间、去重、验签。
    const verdict = this.#codec.open(envelope, {
      expectFrom: session.peerKey ?? session.expectedPeer ?? null,
    });
    if (!verdict.ok) {
      this.#logger?.debug?.('信封被 codec 拒绝', { reason: verdict.reason, detail: verdict.detail });
      // 握手阶段的坏信封直接断连；已建立连接的坏信封只丢这一条。
      if (!session.authenticated) {
        session.resolveReady?.(null);
        session.connection.close(1002, `rejected: ${verdict.reason}`);
      }
      return;
    }
    this.#metrics.envelopesIn += 1;

    if (envelope.kind === MESSAGE_KIND.HELLO) {
      this.#onHello(session, envelope);
      return;
    }
    if (envelope.kind === MESSAGE_KIND.HELLO_ACK) {
      this.#onHelloAck(session, envelope);
      return;
    }
    if (!session.authenticated) return; // 未完成握手前不接受业务消息

    const peer = this.#peers.get(session.peerKey);
    if (peer) {
      peer.lastSeen = Date.now();
      peer.envelopeCount += 1;
    }
    // 一并带上"本机看到的来源地址（含端口）"：中继要靠它回答 STUN 式探测，
    // 而 NAT 之后这个地址就是对方的公网端点 —— 对方自己是看不到的。
    this.emit('envelope', {
      envelope,
      peerKey: session.peerKey,
      observedAddress: session.remoteAddress ?? null,
    });
  }

  #onHello(session, envelope) {
    const from = envelope.from;
    if (from === this.#identity.publicKeyId) {
      // 自己连自己：常见于同机双实例误配或信标把自己也发现了。断掉，别形成回环。
      session.connection.close(1000, 'self connection');
      return;
    }
    if (session.authenticated) return; // 重复的 hello，握手已完成
    session.peerKey = from;
    // 回 hello-ack，并带回对方的 nonce 作为「我确实收到了这次握手」的证据。
    session.connection.send(JSON.stringify(this.#codec.seal(MESSAGE_KIND.HELLO_ACK, {
      nonce: session.nonce,
      echo: envelope.payload?.nonce ?? null,
      node: this.#announcement(),
    }, { to: from })));
  }

  #onHelloAck(session, envelope) {
    const payload = envelope.payload ?? {};

    // 第一段 ack（拨号方收到）：校验对方回显了我的 nonce，然后再回一段 ack 结束握手。
    if (!session.authenticated && session.peerKey === null) {
      if (payload.echo !== session.nonce) {
        this.#metrics.failedHandshakes += 1;
        this.#logger?.warn?.('握手失败：echo 与本地 nonce 不匹配');
        session.connection.close(1002, 'nonce mismatch');
        return;
      }
      session.peerKey = envelope.from;
      session.connection.send(JSON.stringify(this.#codec.seal(MESSAGE_KIND.HELLO_ACK, {
        nonce: session.nonce,
        echo: payload.nonce ?? null,
        node: this.#announcement(),
      }, { to: envelope.from })));
      this.#markAuthenticated(session, envelope, payload);
      return;
    }

    // 第二段 ack（服务端收到）：校验对方回显了我的 nonce，握手完成。
    if (session.peerKey !== envelope.from) {
      session.connection.close(1002, 'peer key changed mid-handshake');
      return;
    }
    if (payload.echo !== session.nonce) {
      this.#metrics.failedHandshakes += 1;
      this.#logger?.warn?.('握手失败：服务端收到 echo 不匹配');
      session.connection.close(1002, 'nonce mismatch');
      return;
    }
    this.#markAuthenticated(session, envelope, payload);
  }

  #markAuthenticated(session, envelope, payload) {
    if (session.authenticated) return;

    const peerKey = envelope.from;
    const existing = this.#peers.get(peerKey);
    // 双向同时拨号会各建一条连接。两边都保留「先建立的那条」，
    // 于是 A 的出站连接正是 B 的入站连接——同一条 TCP，双方看法一致，不会出现两条半死不活的连接。
    if (existing?.session && existing.session !== session && !existing.session.connection.closed) {
      this.#logger?.debug?.('该节点已有连接，关闭重复连接', { peerKey, direction: session.direction });
      session.connection.close(1000, 'duplicate connection');
      return;
    }

    session.authenticated = true;
    clearTimeout(session.timer);
    this.#metrics.handshakes += 1;
    session.resolveReady?.(envelope.from);

    const peer = {
      peerKey,
      publicKeyId: peerKey,
      fingerprint: fingerprintOfPublicKeyId(peerKey),
      nickname: payload.node?.nickname ?? null,
      /** 直连握手带来的加密公钥：比"从中继问来"的更可信，因为它来自端到端握手。 */
      encryptionKeyId: typeof payload.node?.encryptionKeyId === 'string' ? payload.node.encryptionKeyId : null,
      /** 对方自报的中继能力（是否对外服务、负载如何）。 */
      relay: payload.node?.relay ?? null,
      address: payload.node?.address ?? session.remoteAddress,
      direction: session.direction,
      transport: this.name,
      connectedAt: existing?.connectedAt ?? Date.now(),
      lastSeen: Date.now(),
      envelopeCount: existing?.envelopeCount ?? 0,
      session,
    };
    this.#peers.set(peerKey, peer);
    this.#logger?.info?.('节点握手完成', {
      peerKey, fingerprint: peer.fingerprint, direction: session.direction, address: peer.address,
    });
    this.emit('peer-up', { ...peer, session: undefined });
  }

  #onClose(session) {
    clearTimeout(session.timer);
    // 连接断开时也兑现，让 connect() 立刻拿到结果而不是干等到超时。
    session.resolveReady?.(null);
    this.#sessions.delete(session.connection);
    if (!session.peerKey) return;
    const peer = this.#peers.get(session.peerKey);
    // 只有「当前这条连接」才代表该节点的在线状态；
    // 重复连接的关闭不能把一个还活着的节点标记成离线。
    if (!peer || peer.session !== session) return;
    this.#peers.delete(session.peerKey);
    this.#logger?.info?.('节点断开', { peerKey: session.peerKey });
    this.emit('peer-down', { peerKey: session.peerKey, fingerprint: peer.fingerprint }, 'connection closed');
  }

  // ===== 发现（规划 §9.3）=====

  #startDiscovery() {
    const port = this.#config.discovery.beaconPort;
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    this.#udp = socket;

    socket.on('error', (error) => {
      // 端口被占用等情况下只警告并降级为「无自动发现」，不影响手工连接。
      this.#logger?.warn?.('UDP 信标不可用，节点发现已降级为手工连接', { message: error.message });
      this.emit('error', error, { stage: 'udp' });
      try {
        socket.close();
      } catch {
        // 已关闭。
      }
      this.#udp = null;
    });

    socket.on('message', (buffer, remote) => {
      let announcement;
      try {
        announcement = JSON.parse(buffer.toString('utf8'));
      } catch {
        return;
      }
      if (announcement?.publicKeyId === this.#identity.publicKeyId) return; // 自己发的
      if (typeof announcement?.address !== 'string') return;

      this.#metrics.discoveries += 1;
      const entry = {
        ...announcement,
        remoteAddress: `${remote.address}:${remote.port}`,
        seenAt: Date.now(),
      };
      this.#discovered.set(announcement.publicKeyId, entry);
      this.emit('discovered', entry);

      // 自动回连：只在还没有这个节点的连接、且不在拨号中时才发起。
      if (this.#config.discovery.autoConnect !== false
        && !this.#peers.has(announcement.publicKeyId)
        && !this.#connecting.has(announcement.address)) {
        this.connect(announcement.address).catch((error) => {
          this.#logger?.debug?.('自动回连失败', { address: announcement.address, message: error.message });
        });
      }
    });

    socket.bind(port, () => {
      try {
        socket.setBroadcast(true);
      } catch {
        // 某些平台/权限下不允许广播，退化为本机回环发现。
      }
      this.#logger?.info?.('UDP 信标已启动', {
        port, host: this.#config.listen.host,
        scope: this.#isLoopback() ? '仅本机' : '局域网',
      });
    });

    const beacon = () => {
      if (!this.#udp || !this.#server) return;
      const payload = Buffer.from(JSON.stringify(this.#announcement()), 'utf8');
      // 始终发给回环地址：同机多实例（阶段 0 的验收场景）靠这条就够。
      this.#udp.send(payload, port, '127.0.0.1', () => {});
      // 监听在非回环地址上时，才额外向局域网广播——避免「只装了个插件就被全网扫到」。
      if (!this.#isLoopback()) {
        try {
          this.#udp.send(payload, port, '255.255.255.255', () => {});
        } catch {
          // 广播失败不影响回环发现。
        }
      }
    };
    beacon();
    this.#beaconTimer = setInterval(beacon, this.#config.discovery.intervalMs);
    this.#beaconTimer.unref?.();

    // 过期清理：规划要求「不把短期在线视为永久稳定」（§14 节点记录）。
    this.#sweepTimer = setInterval(() => {
      const deadline = Date.now() - this.#config.discovery.ttlMs;
      for (const [key, entry] of this.#discovered) {
        if (entry.seenAt < deadline) this.#discovered.delete(key);
      }
    }, this.#config.discovery.intervalMs);
    this.#sweepTimer.unref?.();
  }

  #isLoopback() {
    return isLoopbackHost(this.#config.listen.host);
  }

  /** 当前发现到但尚未连接的候选节点。 */
  discovered() {
    return [...this.#discovered.values()]
      .filter((entry) => !this.#peers.has(entry.publicKeyId))
      .map((entry) => ({ ...entry }));
  }
}
