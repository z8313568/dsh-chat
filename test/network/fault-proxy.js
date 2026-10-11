/**
 * TCP 故障注入代理——网络测试环境的核心零件。
 *
 * 它夹在两个节点之间：`节点A → 本代理 → 节点B`，可以按需制造各种恶劣链路。
 *
 * 这个文件里有三条**必须守住**的约束。它们不是理论洁癖，每一条都是被真实的假失败逼出来的：
 *
 * ── 1. 不能把"字节流损坏"说成"丢包" ────────────────────────────────
 * 真实 IP 丢包由 TCP 自动重传，上层看不见。所以普通 TCP 代理**无法**模拟丢包：
 * 在代理里随机丢字节，制造的是**字节流损坏**，两端 TCP 都不知道少了一段。
 * 因此两类现象分开、分别命名：
 *   真实可模拟：延迟/抖动、黑洞（卡住但不关连接）、RST、半关闭、带宽限制、分片、慢建连
 *   仅供健壮性测试：字节损坏（corruptRate）
 *
 * ── 2. 不能把字节流打乱顺序 ──────────────────────────────────────
 * TCP 保证流内有序。给每个分片独立抽延迟会造出乱序 —— 一个现实中不存在的网络。
 * 踩过的坑：`{jitterMs:120, chunkSize:7}` 必然失败，而单独用任一参数都正常，
 * 看起来像"服务端不够健壮"，差点让我去改一个本来没问题的 HTTP 解析路径。
 *
 * ── 3. 延迟按「一次写」算，不按「一个分片」算 ──────────────────────
 * 一个 450 字节的信封被切成 65 个分片、各自独立延迟，等价于 MTU=7 字节的网络。
 * 结果是握手从应有的 ~160ms 变成 ~800ms，机器一忙就抖到超时，
 * 又一次伪装成"被测代码在恶劣网络下不行"。
 * 现在：延迟按原始 write 算一次；分片只是这次 write 内部按 `chunkSpacingMs` 拉开，
 * 用来逼出对端的帧重组路径。
 *
 * 顺序由三层共同保证：整批只调度一次 → 批间用 `#reserve` 单调排队 → 批内分片顺序发出。
 */

import { EventEmitter } from 'node:events';
import { connect as netConnect, createServer } from 'node:net';

/** 无故障。 */
export const NO_FAULTS = Object.freeze({});

export class FaultProxy extends EventEmitter {
  #server = null;
  #targetHost;
  #targetPort;
  #faults;
  #sockets = new Set();
  #timers = new Set();
  #immediates = new Set();
  /** 每个方向的"下一批允许开始的时刻"，朴素但足够地保证了不乱序。 */
  #nextSendAt = new Map();
  #lastError = null;
  #stats = {
    connections: 0,
    bytesUp: 0,
    bytesDown: 0,
    chunksUp: 0,
    chunksDown: 0,
    delayedChunks: 0,
    corruptedChunks: 0,
    stalledMs: 0,
    resets: 0,
    halfCloses: 0,
    /** 定时回调里被吞掉的异常数量。为 0 才说明这条链路真的没出错。 */
    callbackErrors: 0,
  };

  constructor({ targetHost = '127.0.0.1', targetPort, faults = NO_FAULTS } = {}) {
    super();
    this.#targetHost = targetHost;
    this.#targetPort = targetPort;
    this.#faults = faults;
  }

  get port() {
    return this.#server?.address()?.port ?? null;
  }

  get address() {
    return this.port === null ? null : `127.0.0.1:${this.port}`;
  }

  get stats() {
    return { ...this.#stats };
  }

  get lastError() {
    return this.#lastError;
  }

  /**
   * 下一个事件循环轮次执行。
   *
   * 分片之间需要一个"让出控制权"的间隔，才能让对端把每个分片当成独立的 `data` 事件读走
   * （否则多次 `write` 会被 TCP 合并成一次读取，帧重组路径就测不到）。
   * 用 `setImmediate` 而不是 `setTimeout(…, 1)`：同样是让出控制权，
   * 但一轮事件循环远快于 1ms 定时器 —— 逐字节分片场景下这是 450 个定时器和
   * 450 次 setImmediate 的差别，前者要 450ms 以上，后者几乎瞬时。
   */
  #soon(fn) {
    const handle = setImmediate(() => {
      this.#immediates.delete(handle);
      try {
        fn();
      } catch (error) {
        this.#stats.callbackErrors += 1;
        this.#lastError = error;
        if (this.listenerCount('error') > 0) this.emit('error', error);
      }
    });
    this.#immediates.add(handle);
    return handle;
  }

  /** 延迟执行。异常只记账；只有在确实有监听器时才往上抛。 */
  #later(fn, ms) {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      try {
        fn();
      } catch (error) {
        this.#stats.callbackErrors += 1;
        this.#lastError = error;
        // EventEmitter 在没有 'error' 监听器时会让 emit('error') 本身抛错，
        // 那等于把异常从定时器里再扔一次 —— 必须避免。
        if (this.listenerCount('error') > 0) this.emit('error', error);
      }
    }, ms);
    this.#timers.add(timer);
    return timer;
  }

  /**
   * 为一个方向预约一段链路时间，返回可以开始发送的时刻。
   * `at` 单调不减，这就是"注入不会造成乱序"的全部保证。
   */
  #reserve(key, delayMs, { strict = false } = {}) {
    const now = Date.now();
    const last = this.#nextSendAt.get(key) ?? 0;
    const at = Math.max(now + Math.max(0, delayMs), strict ? last + 1 : last);
    this.#nextSendAt.set(key, at);
    return at;
  }

  async start() {
    this.#server = createServer((client) => this.#onConnection(client));
    this.#server.on('error', (error) => {
      this.#stats.callbackErrors += 1;
      this.#lastError = error;
      if (this.listenerCount('error') > 0) this.emit('error', error);
    });
    await new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(0, '127.0.0.1', () => {
        this.#server.off('error', reject);
        resolve();
      });
    });
    return this;
  }

  #onConnection(client) {
    this.#stats.connections += 1;
    this.#sockets.add(client);
    client.on('error', () => {});
    client.on('close', () => this.#sockets.delete(client));

    const upstream = netConnect(this.#targetPort, this.#targetHost);
    this.#sockets.add(upstream);
    upstream.on('error', () => {});
    upstream.on('close', () => this.#sockets.delete(upstream));

    const {
      connectDelayMs = 0, latencyMs = 0, jitterMs = 0, chunkSize = 0, chunkSpacingMs = 0,
      corruptRate = 0, bandwidthBps = 0, resetAfterMs = 0, halfCloseAfterMs = 0,
      stallAfterMs = 0, stallForMs = 0, stallEveryMs = 0, stallDurationMs = 0,
    } = this.#faults;

    let frozenUntil = 0;
    const isFrozen = () => Date.now() < frozenUntil;
    const freeze = (ms) => {
      frozenUntil = Math.max(frozenUntil, Date.now() + ms);
      this.#stats.stalledMs += ms;
    };

    if (stallAfterMs > 0) this.#later(() => freeze(stallForMs), stallAfterMs);
    if (stallEveryMs > 0) {
      const tick = () => {
        freeze(stallDurationMs);
        this.#later(tick, stallEveryMs);
      };
      this.#later(tick, stallEveryMs);
    }

    /** 转发一次 write。 */
    const forward = (to, chunk, direction) => {
      if (to.destroyed || !to.writable) return;
      let data = chunk;

      if (corruptRate > 0 && Math.random() < corruptRate) {
        data = Buffer.from(data);
        data[Math.floor(Math.random() * data.length)] ^= 0xff;
        this.#stats.corruptedChunks += 1;
      }

      const pieces = [];
      if (chunkSize > 0 && data.length > chunkSize) {
        for (let offset = 0; offset < data.length; offset += chunkSize) {
          pieces.push(data.subarray(offset, offset + chunkSize));
        }
      } else {
        pieces.push(data);
      }

      const latencyDelay = latencyMs + (jitterMs > 0 ? Math.random() * jitterMs : 0);
      const bandwidthDelay = bandwidthBps > 0 ? Math.round((data.length / bandwidthBps) * 1000) : 0;
      const spacer = pieces.length > 1 ? chunkSpacingMs : 0;
      const at = this.#reserve(direction, latencyDelay + bandwidthDelay + pieces.length * spacer);
      if (latencyDelay + bandwidthDelay > 0) this.#stats.delayedChunks += 1;

      const writePiece = (index) => {
        if (index >= pieces.length) return;
        if (to.destroyed || !to.writable) return;
        if (isFrozen()) {
          // 冻结期间压住整批的剩余部分。重新排队用 strict，确保排到已预约的最后，
          // 否则它会插到已经在队列里的字节前面 —— 又是一次乱序。
          const waitMs = Math.max(5, frozenUntil - Date.now());
          this.#reserve(direction, waitMs, { strict: true });
          this.#later(() => writePiece(index), waitMs);
          return;
        }
        const piece = pieces[index];
        try {
          to.write(piece);
        } catch {
          return; // 对端刚好关闭：正常竞态。
        }
        if (direction === 'up') {
          this.#stats.bytesUp += piece.length;
          this.#stats.chunksUp += 1;
        } else {
          this.#stats.bytesDown += piece.length;
          this.#stats.chunksDown += 1;
        }
        if (index + 1 >= pieces.length) return;
        if (spacer > 0) this.#later(() => writePiece(index + 1), spacer);
        else this.#soon(() => writePiece(index + 1));
      };

      this.#later(() => writePiece(0), Math.max(0, at - Date.now()));
    };

    const pipe = (from, to, direction) => {
      from.on('data', (chunk) => forward(to, chunk, direction));
      // 半关闭要透传，否则上层的"对端已断开"检测就失效了。
      from.on('end', () => {
        if (!to.destroyed && to.writable) to.end();
      });
      from.on('close', () => {
        if (!to.destroyed) to.destroy();
      });
    };

    const begin = () => {
      pipe(client, upstream, 'up');
      pipe(upstream, client, 'down');

      if (resetAfterMs > 0) {
        this.#later(() => {
          this.#stats.resets += 1;
          // RST 而不是 FIN：对端的表现完全不同（ECONNRESET vs 优雅结束）。
          client.resetAndDestroy?.() ?? client.destroy();
          upstream.resetAndDestroy?.() ?? upstream.destroy();
        }, resetAfterMs);
      }
      if (halfCloseAfterMs > 0) {
        this.#later(() => {
          this.#stats.halfCloses += 1;
          // 只发 FIN、不关本端：模拟"对端走了但连接还半开着"。
          upstream.end();
        }, halfCloseAfterMs);
      }
    };

    if (connectDelayMs > 0) {
      // 建连被拖慢时客户端可能先发数据：先停读，等建好再放行，避免丢字节。
      client.pause();
      upstream.once('connect', () => {
        this.#later(begin, connectDelayMs);
        this.#later(() => client.resume(), connectDelayMs);
      });
    } else {
      upstream.once('connect', begin);
    }
    upstream.once('error', () => client.destroy());
  }

  async close() {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    for (const handle of this.#immediates) clearImmediate(handle);
    this.#immediates.clear();
    for (const socket of this.#sockets) {
      try {
        socket.destroy();
      } catch {
        // 已经断了。
      }
    }
    this.#sockets.clear();
    if (this.#server) {
      const server = this.#server;
      this.#server = null;
      await new Promise((resolve) => server.close(resolve));
    }
  }
}

/** 便捷构造：起一个注入指定故障的代理。 */
export async function startFaultProxy({ targetPort, faults = NO_FAULTS, targetHost = '127.0.0.1' }) {
  const proxy = new FaultProxy({ targetHost, targetPort, faults });
  await proxy.start();
  return proxy;
}
