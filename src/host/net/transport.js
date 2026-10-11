/**
 * 传输层抽象（规划 §10.1 第 4 层、§13.2「可调研的技术方向」）。
 *
 * 规划明确要求：技术选型要按实测结果决定，而不是一开始就把 libp2p / WebRTC / IPFS
 * 全引进来（§18.2 第 4 条）。所以这一层先定义**接口**，把「用哪种网络」变成可替换的零件：
 *
 *   NodeTransport（本文件）
 *     ├── LanTransport      —— 局域网直连 + UDP 信标发现（本阶段的实现，见 lan.js）
 *     └── (未来) Libp2pTransport / WebRtcTransport / RelayTransport
 *
 * 上层的 peers / live / share 只依赖这个接口，不依赖任何具体网络实现。
 * 换传输实现时，上层代码不需要改——这正是规划 §9.4「具体技术取舍应以验证结果为准」的落地方式。
 */
import { EventEmitter } from 'node:events';

/**
 * 传输层事件契约（所有实现都必须发这几种）：
 *   'envelope'   ({ envelope, peerKey })     收到通过验签的信封
 *   'peer-up'    (peer)                      某个节点完成身份握手
 *   'peer-down'  (peer, reason)              连接断开
 *   'discovered' (announcement)              发现候选节点（尚未连接）
 *   'error'      (Error, context)            传输层内部错误
 */
export class NodeTransport extends EventEmitter {
  constructor() {
    super();
    /**
     * 默认兜底监听器 —— 这一行是必须的，不是保险起见。
     *
     * `EventEmitter` 在**没有任何 'error' 监听器**时，`emit('error')` 会**抛异常**。
     * 于是一个再普通不过的网络事件（对端重置连接、打洞时被去重关掉的那条重复连接）
     * 就能掀掉整个进程。本项目已经在别处踩过一次同样的坑（故障注入代理的定时器里）。
     *
     * 挂一个只记日志的监听器，调用方仍然可以再加自己的监听器正常处理错误。
     */
    this.on('error', (error, context) => {
      this.#defaultErrorHandler?.(error, context);
    });
  }

  #defaultErrorHandler = null;

  /** 让子类把兜底错误接到自己的 logger 上。 */
  setDefaultErrorHandler(handler) {
    this.#defaultErrorHandler = handler;
    return this;
  }

  /** @returns {string} 传输实现名，界面「节点」页展示用。 */
  get name() {
    return 'abstract';
  }

  /** @returns {Promise<void>} 开始监听与发现。 */
  async start() {
    throw new Error('NodeTransport.start 未实现');
  }

  /** @returns {Promise<void>} 停止一切网络活动，释放端口与定时器。 */
  async stop() {
    throw new Error('NodeTransport.stop 未实现');
  }

  /** 主动连接一个节点。address 形如 'host:port' 或邀请码。 */
  async connect(address) {
    throw new Error(`NodeTransport.connect 未实现（${address}）`);
  }

  /** 向一个已连接的节点定向发送。 */
  send(peerKey, envelope) {
    throw new Error(`NodeTransport.send 未实现（${peerKey}）`);
  }

  /** 向所有已连接的节点发送。 */
  broadcast(envelope) {
    for (const peer of this.peers()) {
      this.send(peer.peerKey, envelope);
    }
  }

  /** @returns {Array<object>} 当前已连接的节点。 */
  peers() {
    return [];
  }

  get running() {
    return false;
  }
}

/**
 * 进程内传输：用于单元测试和「同一进程里模拟两个节点」。
 *
 * 它存在的意义不是省事，而是让上层逻辑（好友、直播、分享）能在不碰真实网络的前提下
 * 被高频测试；真实网络路径由 LanTransport 的端到端测试覆盖。
 */
export class MemoryTransport extends NodeTransport {
  /** 进程内的总线：key 是"网络名"，值是 Set<MemoryTransport>。 */
  static #networks = new Map();

  #network;
  #key;
  #peers = new Map();

  constructor({ network = 'default', key }) {
    super();
    this.#network = network;
    this.#key = key;
  }

  get name() {
    return 'memory';
  }

  get running() {
    return MemoryTransport.#networks.get(this.#network)?.has(this) ?? false;
  }

  async start() {
    let members = MemoryTransport.#networks.get(this.#network);
    if (!members) {
      members = new Set();
      MemoryTransport.#networks.set(this.#network, members);
    }
    members.add(this);
    // 互相接线：新加入者能被已有成员看到，也能看到已有成员。
    for (const other of members) {
      if (other === this) continue;
      this.#wire(other);
      other.#wire(this);
    }
  }

  #wire(other) {
    if (this.#peers.has(other.#key)) return;
    this.#peers.set(other.#key, other);
    queueMicrotask(() => {
      this.emit('peer-up', { peerKey: other.#key, address: 'memory', direction: 'memory' });
    });
  }

  async stop() {
    const members = MemoryTransport.#networks.get(this.#network);
    members?.delete(this);
    for (const peerKey of [...this.#peers.keys()]) {
      this.#peers.delete(peerKey);
      this.emit('peer-down', { peerKey }, 'transport stopped');
    }
  }

  async connect(address) {
    const other = MemoryTransport.#networks.get(this.#network)?.values().next().value;
    if (!other || other === this) throw new Error(`memory 网络 "${this.#network}" 中没有其它节点`);
    this.#wire(other);
    other.#wire(this);
    return other.#key;
  }

  send(peerKey, envelope) {
    const peer = this.#peers.get(peerKey);
    if (!peer) throw new Error(`memory: 未连接 ${peerKey}`);
    queueMicrotask(() => {
      peer.emit('envelope', { envelope, peerKey: this.#key });
    });
  }

  peers() {
    return [...this.#peers.keys()].map((peerKey) => ({
      peerKey, address: 'memory', direction: 'memory', connectedAt: Date.now(),
    }));
  }
}
