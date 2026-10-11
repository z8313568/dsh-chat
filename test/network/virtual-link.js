/**
 * 虚拟链路：跑在 UDP 之上的一条**带真实丢包**的可靠字节流。
 *
 * ## 为什么需要自己实现一条"迷你 TCP"
 *
 * 之前的故障注入代理夹在两个 TCP 连接之间，它**没法模拟丢包**：
 * 在字节流里随机丢几个字节，制造的是"数据损坏"，两端的 TCP 栈根本不知道少了东西。
 * 真实的 IP 丢包会被 TCP 重传吸收，上层看到的只是"卡了一下"。
 *
 * 想在本机复现这个现象，唯一的办法是**让丢包发生在一条我自己实现的可靠传输之下**：
 *   应用字节流 → 切段 → 编号 → 经 UDP 发出（这一段会真的丢/延迟/乱序/重复）
 *   → 接收方按序号重组、按序交付 → 缺失的段由发送方超时重传
 *
 * 于是"丢包"变成了应用能真实感受到的东西：**停顿 + 重传后恢复**，
 * 而 100% 丢包就是永远恢复不了。这跟真机上的表现是一致的。
 *
 * 段格式（UDP 载荷）：
 *   [1 字节类型][4 字节序号][4 字节确认号][2 字节载荷长度][载荷]
 *   类型：0=DATA 1=ACK 2=FIN 3=SYN
 *
 * 这是一个刻意做小的实现：滑动窗口、超时重传、按序交付、连接关闭。
 * 它**不是**一个通用 TCP，也不追求拥塞控制正确性；它只需要让"丢包"这件事
 * 对上层真实可见。
 */

import { EventEmitter } from 'node:events';
import { createSocket } from 'node:dgram';

const TYPE = { DATA: 0, ACK: 1, FIN: 2 };
const HEADER = 11; // 1 + 4 + 4 + 2
const DEFAULT_MTU = 1200;

/** 把一段字节切成若干段。 */
function segment(data, mtu) {
  const out = [];
  for (let offset = 0; offset < data.length; offset += mtu) {
    out.push(data.subarray(offset, offset + mtu));
  }
  return out.length > 0 ? out : [Buffer.alloc(0)];
}

function encode(type, seq, ack, payload) {
  const header = Buffer.allocUnsafe(HEADER);
  header[0] = type;
  header.writeUInt32BE(seq >>> 0, 1);
  header.writeUInt32BE(ack >>> 0, 5);
  header.writeUInt16BE(payload.length, 9);
  return Buffer.concat([header, payload]);
}

function decode(buffer) {
  if (buffer.length < HEADER) return null;
  return {
    type: buffer[0],
    seq: buffer.readUInt32BE(1),
    ack: buffer.readUInt32BE(5),
    length: buffer.readUInt16BE(9),
    payload: buffer.subarray(HEADER),
  };
}

/**
 * 一条虚拟链路。
 *
 * 用法：一端 `listen(port)`，另一端 `connect(port)`；两侧都拿到一个
 * `'data'` / `'close'` 事件流，和 net.Socket 的用法一致。
 *
 * 链路质量由 `link` 参数控制，它模拟的是**中间那段网络**：
 *   lossRate      每个 UDP 段独立丢弃的概率（真实丢包）
 *   delayMs/jitterMs  单向传播延迟（每个段独立抖动）
 *   reorderRate   让后发的段先到（UDP 天然允许）
 *   duplicateRate 重复投递
 *   bandwidthBps  链路速率上限
 *   blackholeMs   黑洞窗口：期间所有段直接丢弃（模拟"断了一下但没断开"）
 */
export class VirtualLink extends EventEmitter {
  #socket;
  #peer = null;
  #link;
  #stats = {
    segmentsSent: 0, segmentsReceived: 0, segmentsDelivered: 0,
    droppedByLoss: 0, droppedByBlackhole: 0, retransmits: 0,
    duplicates: 0, reordered: 0, bytesDelivered: 0, stalls: 0,
  };

  /** 发送侧 */
  #nextSeq = 0;
  #unacked = new Map(); // seq → { buffer, sentAt, attempts }
  #rtoMs;
  #windowSize;
  #retransmitTimer = null;

  /** 接收侧 */
  #expectedSeq = 0;
  #outOfOrder = new Map(); // seq → Buffer
  #pendingAck = false;

  #closed = false;
  /** 可复现的伪随机源：网络测试必须能重跑出同样的结果。 */
  #seed;

  constructor({ link = {}, rtoMs = 100, windowSize = 64 } = {}) {
    super();
    this.#link = {
      lossRate: 0, delayMs: 0, jitterMs: 0, reorderRate: 0, duplicateRate: 0,
      bandwidthBps: 0, blackholeMs: 0, mtu: DEFAULT_MTU,
      ...link,
    };
    this.#rtoMs = rtoMs;
    this.#windowSize = windowSize;
    this.#blackholeUntil = 0;
    // 用固定种子，而不是 Math.random：丢包测试如果每次都不同，就没法判断
    // "失败是链路造成的还是运气不好"。mulberry32，够用且完全确定。
    this.#seed = (link.seed ?? 0x9e3779b9) >>> 0;
  }

  /** 确定性伪随机，返回 [0,1)。 */
  #rand() {
    this.#seed = (this.#seed + 0x6d2b79f5) >>> 0;
    let t = this.#seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  #blackholeUntil = 0;
  #lastSendAt = 0;

  get stats() {
    return { ...this.#stats };
  }

  get linkQuality() {
    return { ...this.#link };
  }

  /** 开始监听（作为链路的一端）。 */
  listen(port = 0) {
    return new Promise((resolve, reject) => {
      this.#socket = createSocket({ type: 'udp4', reuseAddr: true });
      this.#socket.on('error', reject);
      this.#socket.on('message', (message, remote) => this.#onDatagram(message, remote));
      this.#socket.bind(port, '127.0.0.1', () => {
        this.#socket.off('error', reject);
        resolve(this.#socket.address().port);
      });
    });
  }

  /** 主动连接另一端。 */
  setPeer(port) {
    this.#peer = { port, address: '127.0.0.1' };
    this.#startRetransmitTimer();
  }

  #applyBlackhole() {
    if (this.#link.blackholeMs > 0 && Date.now() >= this.#blackholeUntil) {
      this.#blackholeUntil = Date.now() + this.#link.blackholeMs;
    }
  }

  /** 送入要发送的字节（等价于 socket.write）。 */
  write(data) {
    if (this.#closed) return false;
    this.#applyBlackhole();
    for (const piece of segment(Buffer.from(data), this.#link.mtu)) {
      const seq = this.#nextSeq++;
      this.#unacked.set(seq, { buffer: piece, sentAt: Date.now(), attempts: 0 });
      this.#transmit(seq);
    }
    this.#startRetransmitTimer();
    return true;
  }

  /** 真正把一段放到"线上"——所有故障注入都在这里发生。 */
  #transmit(seq) {
    const entry = this.#unacked.get(seq);
    if (!entry || !this.#peer) return;
    entry.sentAt = Date.now();
    entry.attempts += 1;

    // 黑洞：段直接消失，但不关连接 —— 这正是"丢包"在 TCP 上的表现。
    if (Date.now() < this.#blackholeUntil) {
      this.#stats.droppedByBlackhole += 1;
      return;
    }

    // 真实丢包：每个段独立丢弃。接收方不会收到，发送方靠超时重传补上。
    if (this.#link.lossRate > 0 && this.#rand() < this.#link.lossRate) {
      this.#stats.droppedByLoss += 1;
      return;
    }

    const delay = this.#link.delayMs + (this.#link.jitterMs > 0 ? this.#rand() * this.#link.jitterMs : 0);
    // 乱序：让一部分段晚发，于是后发的先到。
    const reorderPenalty = this.#link.reorderRate > 0 && this.#rand() < this.#link.reorderRate
      ? this.#link.delayMs + 50 + this.#rand() * 100
      : 0;

    // 带宽：按字节数排队（简单的速率整形）。
    const bandwidthDelay = this.#link.bandwidthBps > 0
      ? Math.round((entry.buffer.length / this.#link.bandwidthBps) * 1000)
      : 0;

    // 单调发送时刻，保证"链路上的延迟"不会变成"无限乱序"（真实网络里乱序是有限的）。
    const now = Date.now();
    const at = Math.max(now + delay + reorderPenalty + bandwidthDelay, this.#lastSendAt + 1);
    this.#lastSendAt = at;

    const send = () => {
      if (this.#closed || !this.#socket) return;
      try {
        this.#stats.segmentsSent += 1;
        const datagram = encode(TYPE.DATA, seq, this.#expectedSeq, entry.buffer);
        this.#socket.send(datagram, this.#peer.port, this.#peer.address, () => {});
        if (this.#link.duplicateRate > 0 && this.#rand() < this.#link.duplicateRate) {
          this.#stats.duplicates += 1;
          this.#socket.send(datagram, this.#peer.port, this.#peer.address, () => {});
        }
      } catch {
        // 关闭过程中的发送：忽略。定时器里的异常没人接，必须在这里挡住。
      }
    };
    const wait = Math.max(0, at - now);
    if (wait === 0) send();
    else setTimeout(send, wait).unref?.();
  }

  #startRetransmitTimer() {
    if (this.#retransmitTimer || this.#closed) return;
    this.#retransmitTimer = setInterval(() => this.#checkRetransmit(), Math.max(10, Math.floor(this.#rtoMs / 2)));
    this.#retransmitTimer.unref?.();
  }

  #checkRetransmit() {
    if (this.#closed) return;
    const now = Date.now();
    for (const [seq, entry] of [...this.#unacked]) {
      // 超时退避：这是"重传代价"的来源，也是丢包让传输变慢的真实原因。
      // 但上限压到 4 倍：退避太狠会让 50% 丢包这种场景慢到不可用，
      // 那是实现缺陷而不是网络现象。（真实 TCP 的退避更温和，且靠快速重传补救。）
      if (now - entry.sentAt < this.#rtoMs * Math.min(4, 1 + entry.attempts * 0.5)) continue;
      this.#stats.retransmits += 1;
      this.#stats.stalls += 1;
      this.#transmit(seq);
    }
    if (this.#unacked.size === 0 && this.#retransmitTimer) {
      clearInterval(this.#retransmitTimer);
      this.#retransmitTimer = null;
    }
  }

  #sendAck() {
    if (!this.#peer || !this.#socket || this.#closed) return;
    this.#stats.segmentsSent += 1;
    const ack = encode(TYPE.ACK, 0, this.#expectedSeq, Buffer.alloc(0));
    const delay = this.#link.delayMs + (this.#link.jitterMs > 0 ? this.#rand() * this.#link.jitterMs : 0);
    const dispatch = () => {
      if (this.#closed || !this.#socket) return;
      try {
        this.#socket.send(ack, this.#peer.port, this.#peer.address, () => {});
      } catch {
        // socket 已经关了：正常竞态。
      }
    };
    if (delay > 0) setTimeout(dispatch, delay).unref?.();
    else dispatch();
  }

  #onDatagram(message, remote) {
    if (!this.#peer) {
      // 被动方第一次收到包时记住对端（等价于 accept 的来源地址）
      this.#peer = { port: remote.port, address: remote.address };
      this.#startRetransmitTimer();
    }
    this.#stats.segmentsReceived += 1;
    const packet = decode(message);
    if (!packet) return;

    if (packet.type === TYPE.ACK) {
      for (const [seq] of [...this.#unacked]) {
        // 累计确认：所有 <= ack 的段都算送达（用无符号环绕比较）
        if (((seq - packet.ack) >>> 0) >= 0x80000000) this.#unacked.delete(seq);
      }
      return;
    }

    if (packet.type !== TYPE.DATA) return;

    if (packet.seq === this.#expectedSeq) {
      this.#deliver(packet.payload);
      this.#expectedSeq = (this.#expectedSeq + 1) >>> 0;
      // 把缓存里连续的后继段也交付出去
      for (;;) {
        const next = this.#outOfOrder.get(this.#expectedSeq);
        if (next === undefined) break;
        this.#outOfOrder.delete(this.#expectedSeq);
        this.#deliver(next);
        this.#expectedSeq = (this.#expectedSeq + 1) >>> 0;
      }
      this.#sendAck();
    } else if (((packet.seq - this.#expectedSeq) >>> 0) < 0x80000000) {
      // 已经收到过的重复段：重新确认，防止对端超时重传
      this.#stats.duplicates += 1;
      this.#sendAck();
    } else {
      // 未来的段：缓存等待缺口补齐
      if (!this.#outOfOrder.has(packet.seq)) {
        this.#outOfOrder.set(packet.seq, packet.payload);
        this.#stats.reordered += 1;
      }
      this.#sendAck();
    }
  }

  #deliver(payload) {
    this.#stats.segmentsDelivered += 1;
    this.#stats.bytesDelivered += payload.length;
    if (payload.length > 0) this.emit('data', Buffer.from(payload));
  }

  /** 主动关闭。 */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#retransmitTimer) clearInterval(this.#retransmitTimer);
    this.#retransmitTimer = null;
    const socket = this.#socket;
    this.#socket = null;
    try {
      socket?.close();
    } catch {
      // 已关闭。
    }
    this.emit('close');
  }
}
