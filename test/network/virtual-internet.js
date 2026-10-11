/**
 * 虚拟互联网：用用户态进程搭出一个有**真实 NAT 语义**的多子网环境。
 *
 * ## 为什么不直接用 Docker / netem
 *
 * 本机 `sudo` 不可用（`dnctl`/`pfctl` 要 root），Docker 守护进程没起（colima 需要拉一个 ~1GB 的
 * 虚拟机镜像）。而且就算能用，容器里的 netem 也只能改链路质量，**改不了"谁能连谁"** ——
 * 而后者才是 P2P 应用真正的生死线。
 *
 * 所以这里自己搭：子网、网关、NAT 表、防火墙规则、端口映射，全部是用户态代码。
 * 它不模拟 IP 层的每一个细节，但它**忠实复现了决定连通性的那些语义**。
 *
 * ## 拓扑模型
 *
 * ```
 *   子网 lan-a (10.0.1.0/24)            子网 lan-b (10.0.2.0/24)
 *     [主机 A 10.0.1.5]                    [主机 B 10.0.2.5]
 *          |                                     |
 *     [网关 gwA 10.0.1.1 / 公网 203.0.113.1]  [网关 gwB 10.0.2.1 / 公网 203.0.113.2]
 *          |                                     |
 *          +─────────── 公网 subnet: wan ────────+
 * ```
 *
 * 关键规则（与真实 NAT 一致）：
 *   1. **出站永远放行**，并因此建立一条动态映射；
 *   2. **入站默认拒绝**，除非有静态端口映射，或存在一条"目的地址正好等于来包源地址"的动态映射；
 *   3. 第 2 条的后半句就是**打洞**（hole punching）的全部原理 —— 双方都先向外发一包，
 *      各自 NAT 里就有了指向对方的映射，对方的包回来时就能穿过；
 *   4. 对称 NAT 下每条出站连接换一个新公网端口，于是对方算不出该往哪打 —— 打洞失败。
 *
 * 这些都是可以用测试断言的真实现象，不是比喻。
 */

import { EventEmitter } from 'node:events';
import { createServer, connect as netConnect } from 'node:net';

import { VirtualLink } from './virtual-link.js';

/**
 * NAT 类型。
 *
 * **这里做过一次修正，值得记下来。** 最初只有 cone/symmetric 两种，把
 * "全锥形"和"受限锥形"混成了一个。这两者在打洞上是**完全不同**的：
 *
 *   全锥形   一条映射对所有人敞开 —— 别人打过来不需要你先发过包
 *   受限锥形 只有你**先发给过的那个地址**才能打进来 —— 这也是打洞可行的情形
 *   对称     每个目的地换一个新公网端口，对方算出来的端口根本对不上 —— 打洞必然失败
 *
 * 混在一起的后果是"全锥形打洞"测试断言的其实是受限锥形的行为（"陌生地址被拒"），
 * 而真正的全锥形不该拒。测试通过了，但测的是另一个东西。
 */
export const NAT_MODE = Object.freeze({
  /** 全锥形：一条映射，任何来源都能打进来。打洞最容易。 */
  CONE: 'cone',
  /** 受限锥形：只有本机先发给过的地址才能打进来。打洞同样可行（双方都会先发）。 */
  RESTRICTED: 'restricted',
  /** 对称：每个目的地一条新映射，对方算不出端口。打洞必然失败（移动网络常态）。 */
  SYMMETRIC: 'symmetric',
  /** 关闭 NAT：入站直接放行（等价于公网主机）。 */
  OPEN: 'open',
});

let portCounter = 41000;
const nextPort = () => {
  portCounter += 1;
  if (portCounter > 60000) portCounter = 41000;
  return portCounter;
};

/** 一个网关（NAT 路由器）。 */
class Gateway extends EventEmitter {
  name;
  lanSubnet;
  wanSubnet;
  mode;
  firewall;
  publicIp;
  /** publicPort → { kind, hostName, hostPort, dstIp, dstPort, createdAt } */
  mappings = new Map();
  /** 每条映射对应的真实监听端口（模拟"公网侧能被连上"） */
  #listeners = new Map();
  /** hostName → { ip } */
  hosts = new Map();
  #internet;
  stats = { outbound: 0, inboundAllowed: 0, inboundBlocked: 0, mappingReused: 0 };

  /** 本网关后面所有主机曾主动发给过的公网地址（受限锥形靠它判断放不放行）。 */
  sentTo = new Set();

  constructor({ name, lanSubnet, wanSubnet, mode, firewall, publicIp, internet }) {
    super();
    this.name = name;
    this.lanSubnet = lanSubnet;
    this.wanSubnet = wanSubnet;
    this.mode = mode;
    this.firewall = firewall ?? { allowInbound: 'mapped-only', blockedPorts: [] };
    this.publicIp = publicIp;
    this.#internet = internet;
  }

  registerHost(name, ip) {
    this.hosts.set(name, { ip });
  }

  /** 分配一个公网端口并挂上真实监听，模拟"这个端口在公网上可达"。 */
  async #openPublicPort(hostName, hostPort, { kind, dstIp = null, dstPort = null, fixedPort = null }) {
    const publicPort = fixedPort ?? nextPort();
    const listener = createServer((socket) => {
      // 有人从公网侧连进来 —— 这里就是 NAT 的入站判决点。
      const decision = this.#decideInbound({ dstPort: publicPort, srcIp: '0.0.0.0', srcPort: 0, socket });
      if (!decision.allowed) {
        this.stats.inboundBlocked += 1;
        this.emit('inbound-blocked', { reason: decision.reason, publicPort, hostName });
        socket.destroy();
        return;
      }
      this.stats.inboundAllowed += 1;
      this.emit('inbound-allowed', { publicPort, hostName, reason: decision.reason });
      const target = netConnect(hostPort, '127.0.0.1');
      socket.pipe(target);
      target.pipe(socket);
      socket.on('error', () => target.destroy());
      target.on('error', () => socket.destroy());
      socket.on('close', () => target.destroy());
      target.on('close', () => socket.destroy());
    });
    await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const entry = { kind, hostName, hostPort, dstIp, dstPort, publicPort, listener, realPort: listener.address().port, createdAt: Date.now() };
    this.mappings.set(publicPort, entry);
    this.#listeners.set(publicPort, listener);
    return entry;
  }

  /** 建立一条静态端口映射（等价于在路由器上做端口转发）。 */
  async addPortMapping(hostName, hostPort, { publicPort = null } = {}) {
    const host = this.hosts.get(hostName);
    if (!host) throw new Error(`网关 ${this.name} 上没有主机 ${hostName}`);
    return this.#openPublicPort(hostName, hostPort, { kind: 'static', fixedPort: publicPort });
  }

  /** 公网侧可拨号的地址（真实监听端口）。 */
  publicAddressFor(publicPort) {
    const entry = this.mappings.get(publicPort);
    return entry ? `127.0.0.1:${entry.realPort}` : null;
  }

  /**
   * 入站判决 —— 整个虚拟互联网里最重要的一段逻辑。
   * @returns {{allowed: boolean, reason: string}}
   */
  #decideInbound({ dstPort, srcIp, srcPort }) {
    const { blockedPorts = [], allowInbound = 'mapped-only' } = this.firewall;

    if (blockedPorts.includes(dstPort)) return { allowed: false, reason: 'firewall-blocked-port' };

    // 没有 NAT 的网关不该被"映射表里有没有这条"拦下 —— 它本来就谁都能连。
    // 这个判断必须放在查映射表**之前**：开了端口映射的公网主机依然谁都能连。
    if (this.mode === NAT_MODE.OPEN) return { allowed: true, reason: 'open-inbound' };

    const mapping = this.mappings.get(dstPort);
    if (mapping) {
      if (mapping.kind === 'static') return { allowed: true, reason: 'static-port-mapping' };

      // 这条动态映射正是"本机主动连向 srcIp:srcPort"时建立的 → 回包当然放行。
      if (mapping.dstIp === srcIp && mapping.dstPort === srcPort) {
        return { allowed: true, reason: 'hole-punched' };
      }

      if (this.mode === NAT_MODE.CONE) {
        // 全锥形：映射一旦建立，**任何人都能往这个端口打**，不需要你先发过包。
        return { allowed: true, reason: 'full-cone-open-mapping' };
      }
      if (this.mode === NAT_MODE.RESTRICTED) {
        // 受限锥形：只有本机**先发给过**的地址才放得进来（端口不限）。
        // 打洞之所以可行，正是因为双方都会先向对方发一包。
        if (this.sentTo.has(srcIp)) return { allowed: true, reason: 'restricted-cone-punched' };
        return { allowed: false, reason: 'restricted-cone-unseen-source' };
      }
      // 对称 NAT：出站换了端口，对方打过来的 5 元组对不上 → 拒绝
      if (this.mode === NAT_MODE.SYMMETRIC) return { allowed: false, reason: 'symmetric-nat-mismatch' };
      return { allowed: false, reason: 'no-matching-mapping' };
    }

    if (allowInbound === true) return { allowed: true, reason: 'open-inbound' };
    return { allowed: false, reason: 'no-mapping' };
  }

  /**
   * 从本网关后面的一台主机发起一条出站连接。
   * @returns {{allowed: true, realPort: number, publicPort: number} | {allowed: false, reason: string}}
   */
  /**
   * 建立一条出站映射并返回它。
   *
   * 从 `dialOut` 里抽出来，是因为**打洞的目标是"公网端点"而不是"可路由的主机"** ——
   * 对方在 NAT 后面，它的 10.0.x.x 根本不可路由，你拨的是 NAT 给它的那个公网 ip:port。
   * 早先复用 dialOut 做这件事，结果 `gatewayOwning('203.0.113.2')` 找不到主机，
   * 直接返回 no-route，`publicPort` 是 undefined，打洞测试全线报 "no-mapping"。
   */
  async openOutbound({ hostName, hostPort, dstPublicIp = null, dstPort = null }) {
    this.stats.outbound += 1;
    if (dstPublicIp) this.sentTo.add(dstPublicIp);

    // 出站一定建立映射（这就是 NAT 的基本行为），除了对称 NAT 每次都换端口。
    let mapping;
    if (this.mode === NAT_MODE.SYMMETRIC) {
      mapping = await this.#openPublicPort(hostName, hostPort, {
        kind: 'dynamic', dstIp: dstPublicIp, dstPort,
      });
    } else {
      /**
       * 全锥形：**一台主机一条映射**，跟目的地无关 —— 这正是"全锥"的含义，
       * 也是它的公网端口稳定、对方算得出来的原因。
       * 受限锥形同样复用（它限制的是"谁能打进来"，不是"用哪个端口出去"）。
       */
      const existing = [...this.mappings.values()].find(
        (entry) => entry.kind === 'dynamic' && entry.hostName === hostName,
      );
      if (existing) {
        this.stats.mappingReused += 1;
        mapping = existing;
      } else {
        mapping = await this.#openPublicPort(hostName, hostPort, { kind: 'dynamic', dstIp: dstPublicIp, dstPort });
      }
    }
    return {
      allowed: true,
      publicPort: mapping.publicPort,
      realPort: mapping.realPort,
      mapping,
    };
  }

  /** STUN 那一步：本机在这个网关后面的公网端点是什么。 */
  async publicEndpoint(hostName, hostPort = 47800) {
    const existing = [...this.mappings.values()].find(
      (entry) => entry.kind === 'dynamic' && entry.hostName === hostName,
    );
    if (existing) return existing.publicPort;
    const result = await this.openOutbound({ hostName, hostPort });
    return result.publicPort;
  }

  async dialOut({ hostName, hostPort, dstIp, dstPort, dstPublicIp, dstPublicRealPort, subnetOf }) {
    const outbound = await this.openOutbound({ hostName, hostPort, dstPublicIp, dstPort });

    // 送到对端网关。对端的入站判决由它自己做。
    const targetGateway = this.#internet.gatewayOwning(dstIp);
    if (!targetGateway) return { allowed: false, reason: 'no-route' };

    return {
      allowed: true,
      gateway: targetGateway,
      publicPort: outbound.publicPort,
      realPort: outbound.realPort,
      dstIp,
      dstPort,
      subnetOf,
    };
  }

  /** 让公网侧连到本网关的某个映射上（模拟"对方拨过来"）。 */
  async connectInbound(publicPort, { srcIp, srcPort }) {
    const entry = this.mappings.get(publicPort);
    if (!entry) return { accepted: false, reason: 'no-mapping' };
    const decision = this.#decideInbound({ dstPort: publicPort, srcIp, srcPort });
    if (!decision.allowed) {
      this.stats.inboundBlocked += 1;
      return { accepted: false, reason: decision.reason };
    }
    this.stats.inboundAllowed += 1;
    return { accepted: true, reason: decision.reason, hostName: entry.hostName, hostPort: entry.hostPort };
  }

  async close() {
    for (const listener of this.#listeners.values()) {
      await new Promise((resolve) => listener.close(resolve)).catch(() => {});
    }
    this.#listeners.clear();
    this.mappings.clear();
  }

  describe() {
    return {
      name: this.name, mode: this.mode, publicIp: this.publicIp,
      lan: this.lanSubnet, wan: this.wanSubnet,
      staticMappings: [...this.mappings.values()].filter((m) => m.kind === 'static')
        .map((m) => ({ host: m.hostName, port: m.publicPort })),
      dynamicMappings: [...this.mappings.values()].filter((m) => m.kind === 'dynamic').length,
      stats: { ...this.stats },
    };
  }
}

/** 虚拟互联网。 */
export class VirtualInternet extends EventEmitter {
  #subnets = new Map(); // name → { cidr, hosts: Set<name> }
  #gateways = new Map();
  #hosts = new Map(); // name → { ip, subnet, realPort, gateway }
  #links = new Map(); // "a|b" → quality
  #servers = [];
  stats = { dials: 0, dialsSucceeded: 0, dialsBlocked: 0, bytesRelayed: 0 };

  /** 定义子网。cidr 只取前缀，例如 '10.0.1'。 */
  defineSubnet(name, prefix) {
    this.#subnets.set(name, { name, prefix, hosts: new Set() });
    return this;
  }

  /** 创建网关。 */
  createGateway({ name, lanSubnet, wanSubnet = 'wan', mode = NAT_MODE.CONE, firewall = null, publicIp }) {
    const gateway = new Gateway({
      name, lanSubnet, wanSubnet, mode, firewall,
      publicIp: publicIp ?? `203.0.113.${this.#gateways.size + 1}`,
      internet: this,
    });
    this.#gateways.set(name, gateway);
    return gateway;
  }

  /** 注册一台主机（插件节点就住在这里）。 */
  registerHost(name, { subnet, ip, realPort, gateway }) {
    const host = { name, subnet, ip, realPort, gateway };
    this.#hosts.set(name, host);
    this.#subnets.get(subnet)?.hosts.add(name);
    gateway?.registerHost(name, ip);
    return host;
  }

  /** 设置两个子网之间的链路质量。 */
  setLink(subnetA, subnetB, quality) {
    this.#links.set(`${subnetA}|${subnetB}`, quality);
    this.#links.set(`${subnetB}|${subnetA}`, quality);
    return this;
  }

  #linkBetween(subnetA, subnetB) {
    return this.#links.get(`${subnetA}|${subnetB}`) ?? {};
  }

  /** 某个虚拟 IP 属于哪个网关。 */
  gatewayOwning(ip) {
    for (const gateway of this.#gateways.values()) {
      for (const { ip: hostIp } of gateway.hosts.values()) {
        if (hostIp === ip) return gateway;
      }
    }
    return null;
  }

  hostByName(name) {
    return this.#hosts.get(name) ?? null;
  }

  /**
   * 判断一次"从 A 主动连 B 的虚拟地址"能不能成，并给出原因。
   * 这是给测试用的判决函数：不需要真的建立连接就能断言 NAT 语义。
   */
  decide({ fromHost, dstIp, dstPort }) {
    const from = this.#hosts.get(fromHost);
    if (!from) return { allowed: false, reason: 'no-such-host' };

    const dst = [...this.#hosts.values()].find((host) => host.ip === dstIp);
    if (!dst) return { allowed: false, reason: 'no-route' };

    // 同一子网且没有网关隔开 → 直连
    if (dst.subnet === from.subnet && dst.gateway === from.gateway) {
      return { allowed: true, reason: 'same-subnet', dst };
    }

    const dstGateway = dst.gateway;
    if (!dstGateway) return { allowed: true, reason: 'public-host', dst };
    if (dstGateway.mode === NAT_MODE.OPEN) return { allowed: true, reason: 'open-nat', dst };

    // 目的侧有没有一条能匹配的静态映射？
    const staticMapping = [...dstGateway.mappings.values()].find(
      (entry) => entry.kind === 'static' && entry.hostName === dst.name && entry.hostPort === dstPort,
    );
    if (staticMapping) return { allowed: true, reason: 'static-port-mapping', dst, publicPort: staticMapping.publicPort };

    return { allowed: false, reason: 'nat-inbound-blocked', dst, gateway: dstGateway };
  }

  /**
   * 真的在两个模拟主机之间建立一条连接，中间经过网关判决与虚拟链路。
   *
   * 返回 `{ localPort }`：调用方把这个端口当作"目的地址"去拨，
   * 于是整条虚拟路径（NAT 判决 + 链路质量）都会真实生效。
   *
   * 数据通路（两个方向的链路各自独立，和真实网络一样）：
   *
   *   调用方 socket ──► linkOut ──UDP(丢包/延迟/乱序)──► linkIn ──► 目的主机
   *   调用方 socket ◄── linkIn' ◄──UDP(丢包/延迟/乱序)── linkOut' ◄── 目的主机
   */
  async dial({ fromHost, fromHostPort, dstIp, dstPort, onRelay = null }) {
    this.stats.dials += 1;
    const from = this.#hosts.get(fromHost);
    const dst = [...this.#hosts.values()].find((host) => host.ip === dstIp);
    if (!from || !dst) return { accepted: false, reason: 'no-route' };

    const verdict = this.decide({ fromHost, dstIp, dstPort });
    if (!verdict.allowed) {
      this.stats.dialsBlocked += 1;
      this.emit('dial-blocked', { fromHost, dstIp, dstPort, reason: verdict.reason });
      return { accepted: false, reason: verdict.reason };
    }

    // 跨子网才经过虚拟链路；同子网直接本机连通（等价于同一广播域）。
    const quality = from.subnet === dst.subnet ? {} : this.#linkBetween(from.subnet, dst.subnet);

    let resolveSession;
    const sessionReady = new Promise((resolve) => { resolveSession = resolve; });

    const server = createServer((socket) => {
      (async () => {
        // 出方向：调用方 → 链路 → 目的主机
        const uplink = new VirtualLink({ link: quality });
        const downlink = new VirtualLink({ link: quality });
        const uplinkPort = await uplink.listen(0);
        const downlinkPort = await downlink.listen(0);
        uplink.setPeer(downlinkPort);
        downlink.setPeer(uplinkPort);

        const sink = netConnect(dst.realPort, '127.0.0.1');
        sink.on('error', () => {});
        sink.on('connect', () => {
          this.stats.dialsSucceeded += 1;
          this.emit('dial-connected', { fromHost, dstIp, dstPort, reason: verdict.reason });
        });

        socket.on('data', (chunk) => {
          this.stats.bytesRelayed += chunk.length;
          onRelay?.(chunk.length, 'up');
          uplink.write(chunk);
        });
        downlink.on('data', (chunk) => {
          this.stats.bytesRelayed += chunk.length;
          onRelay?.(chunk.length, 'down');
          if (!sink.destroyed) sink.write(chunk);
        });
        sink.on('data', (chunk) => {
          this.stats.bytesRelayed += chunk.length;
          onRelay?.(chunk.length, 'down');
          downlink.write(chunk);
        });
        // uplink 收到的数据 = 目的主机回给我们的方向 → 必须写回调用方的 socket。
        // 之前这里误写成了 sink.write，于是回程数据在环路里打转、调用方永远等不到响应。
        uplink.on('data', (chunk) => {
          this.stats.bytesRelayed += chunk.length;
          onRelay?.(chunk.length, 'down');
          if (!socket.destroyed) socket.write(chunk);
        });

        const teardown = () => {
          uplink.close(); downlink.close();
          if (!sink.destroyed) sink.destroy();
          if (!socket.destroyed) socket.destroy();
        };
        socket.on('close', teardown);
        socket.on('error', teardown);
        sink.on('close', teardown);
        sink.on('error', teardown);

        resolveSession({ uplink, downlink });
      })().catch(() => socket.destroy());
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.#servers.push(server);

    return { accepted: true, localPort: server.address().port, reason: verdict.reason, sessionReady };
  }

  /**
   * 模拟一次**同时打洞**，返回是否成功与原因。
   *
   * 严格按真实顺序建模：
   *   1. A、B 各自先跟**中继**建立一条出站连接 —— 公网端点就是这么知道的（STUN）；
   *   2. 双方交换这两个端点（信令，经中继）；
   *   3. 双方**同时**向对方的公网端点发包；
   *   4. 检查对方的包能不能穿过自己的 NAT。
   *
   * 第 1 步不能省。没有它就没有"对方的公网端点"这个东西，
   * 也就退化成普通直连 —— 而普通直连在 NAT 后面必然失败。
   */
  async attemptHolePunch({ a, b, relayIp = '198.51.100.9' }) {
    const hostA = this.#hosts.get(a);
    const hostB = this.#hosts.get(b);
    if (!hostA || !hostB) return { ok: false, reason: 'no-such-host' };

    const gwA = hostA.gateway;
    const gwB = hostB.gateway;
    if (!gwA || !gwB) return { ok: true, reason: 'no-nat-direct' };
    if (gwA === gwB) return { ok: true, reason: 'same-gateway-lan' };

    // ① 各自先连一次中继 → 拿到自己的公网端点（STUN 就是在这一刻知道答案的）
    const pubA = await gwA.publicEndpoint(a);
    const pubB = await gwB.publicEndpoint(b);

    // ② 双方同时向对方的**公网端点**发起连接
    const dialA = await gwA.openOutbound({
      hostName: a, hostPort: 47800, dstPublicIp: gwB.publicIp, dstPort: pubB,
    });
    const dialB = await gwB.openOutbound({
      hostName: b, hostPort: 47800, dstPublicIp: gwA.publicIp, dstPort: pubA,
    });

    // ③ 对方的包能不能穿进来
    const inA = await gwA.connectInbound(pubA, { srcIp: gwB.publicIp, srcPort: dialB.publicPort });
    const inB = await gwB.connectInbound(pubB, { srcIp: gwA.publicIp, srcPort: dialA.publicPort });

    if (inA.accepted && inB.accepted) {
      return { ok: true, reason: 'punched', publicPortA: pubA, publicPortB: pubB, inboundA: inA.reason, inboundB: inB.reason };
    }
    const blockedBy = !inA.accepted ? gwA.name : gwB.name;
    const reason = !inA.accepted ? inA.reason : inB.reason;
    return {
      ok: false, reason, blockedBy,
      modeA: gwA.mode, modeB: gwB.mode,
      /**
       * 对称 NAT 下打洞失败是**必然**的，不是运气问题：
       * 出站换端口，对方按 STUN 得到的那个端口发过来，5 元组对不上。
       * 这类网络下只能靠中继。
       */
      needsRelay: gwA.mode === NAT_MODE.SYMMETRIC || gwB.mode === NAT_MODE.SYMMETRIC,
    };
  }

  async close() {
    for (const server of this.#servers) await new Promise((resolve) => server.close(resolve)).catch(() => {});
    this.#servers = [];
    for (const gateway of this.#gateways.values()) await gateway.close();
  }

  describe() {
    return {
      subnets: [...this.#subnets.values()].map((s) => ({ name: s.name, prefix: s.prefix, hosts: [...s.hosts] })),
      gateways: [...this.#gateways.values()].map((g) => g.describe()),
      hosts: [...this.#hosts.values()].map((h) => ({ name: h.name, ip: h.ip, subnet: h.subnet })),
      stats: { ...this.stats },
    };
  }
}
