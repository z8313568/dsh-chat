/**
 * 最小 RFC6455 WebSocket 实现（服务端 + 客户端）。
 *
 * 为什么自己写而不是装 ws：
 *   - 这个传输层要证明的是「两个本地/局域网实例能安全交换消息」（规划阶段 0 的验收标准），
 *     引入一个网络依赖会让"到底哪一层出问题"变难判断；
 *   - Host 半体是被 esbuild 打包进 lib/index.js 的，多一个运行时依赖就多一份升级风险；
 *   - RFC6455 的握手 + 帧格式是冻结的协议，实现量可控（~300 行），
 *     而且可以用 Node 内置的 WebSocket 客户端做交叉验证（见 test/ws.test.js）。
 *
 * 本实现只覆盖 dsh-chat 需要的部分：文本帧、分片、ping/pong/close。
 * 明确不做：扩展协商（permessage-deflate）、子协议、TLS（局域网直连由上层决定要不要加密）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { connect as netConnect } from 'node:net';

import { unbracketHost } from './address.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

/** 单条消息上限。默认 8 MiB：足够一条长回答，又能挡住内存放大攻击。 */
const DEFAULT_MAX_PAYLOAD = 8 * 1024 * 1024;

function acceptKey(clientKey) {
  return createHash('sha1').update(clientKey + GUID).digest('base64');
}

/** 把一条消息编成帧。客户端必须掩码，服务端必须不掩码——这是 RFC 的强制要求。 */
export function encodeFrame(payload, { opcode = OPCODE.TEXT, mask = false, fin = true } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const length = data.length;
  let headerLength = 2;
  if (length >= 65536) headerLength += 8;
  else if (length > 125) headerLength += 2;
  if (mask) headerLength += 4;

  const frame = Buffer.allocUnsafe(headerLength + length);
  frame[0] = (fin ? 0x80 : 0x00) | opcode;
  let offset = 2;
  if (length >= 65536) {
    frame[1] = 127;
    frame.writeUInt32BE(Math.floor(length / 2 ** 32), 2);
    frame.writeUInt32BE(length >>> 0, 6);
    offset = 10;
  } else if (length > 125) {
    frame[1] = 126;
    frame.writeUInt16BE(length, 2);
    offset = 4;
  } else {
    frame[1] = length;
  }

  if (mask) {
    frame[1] |= 0x80;
    const key = randomBytes(4);
    key.copy(frame, offset);
    offset += 4;
    for (let i = 0; i < length; i += 1) frame[offset + i] = data[i] ^ key[i % 4];
  } else {
    data.copy(frame, offset);
  }
  return frame;
}

/**
 * 增量解析器：TCP 不保证一次 data 事件就是完整帧，所以必须能跨 chunk 累积。
 */
export class FrameParser {
  #buffer = Buffer.alloc(0);
  #fragmentOpcode = null;
  #fragments = [];
  #maxPayload;

  constructor({ maxPayload = DEFAULT_MAX_PAYLOAD } = {}) {
    this.#maxPayload = maxPayload;
  }

  /**
   * 喂入一段字节，返回解析出的完整消息数组。
   * @returns {Array<{opcode: number, payload: Buffer}>}
   */
  push(chunk) {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const messages = [];

    for (;;) {
      const frame = this.#readFrame();
      if (!frame) break;

      if (frame.opcode === OPCODE.CLOSE) {
        messages.push({ opcode: OPCODE.CLOSE, payload: frame.payload });
        continue;
      }
      if (frame.opcode === OPCODE.PING || frame.opcode === OPCODE.PONG) {
        messages.push({ opcode: frame.opcode, payload: frame.payload });
        continue;
      }

      // 分片处理：首帧记下真实 opcode，后续 continuation 帧累积。
      if (frame.opcode === OPCODE.CONTINUATION) {
        if (this.#fragmentOpcode === null) continue; // 没有起始帧的孤儿 continuation，忽略
        this.#fragments.push(frame.payload);
      } else {
        this.#fragmentOpcode = frame.opcode;
        this.#fragments = [frame.payload];
      }

      if (frame.fin) {
        const payload = Buffer.concat(this.#fragments);
        const opcode = this.#fragmentOpcode;
        this.#fragmentOpcode = null;
        this.#fragments = [];
        if (payload.length > this.#maxPayload) {
          throw new Error(`WebSocket 消息超过上限 (${payload.length} > ${this.#maxPayload})`);
        }
        messages.push({ opcode, payload });
      }
    }
    return messages;
  }

  #readFrame() {
    const buffer = this.#buffer;
    if (buffer.length < 2) return null;

    const fin = (buffer[0] & 0x80) !== 0;
    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let length = buffer[1] & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (buffer.length < offset + 2) return null;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length < offset + 8) return null;
      const high = buffer.readUInt32BE(offset);
      const low = buffer.readUInt32BE(offset + 4);
      length = high * 2 ** 32 + low;
      offset += 8;
      if (length > this.#maxPayload) throw new Error(`WebSocket 帧声明长度过大 (${length})`);
    }

    let maskKey = null;
    if (masked) {
      if (buffer.length < offset + 4) return null;
      maskKey = buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buffer.length < offset + length) return null;

    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    if (maskKey) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
    }
    this.#buffer = buffer.subarray(offset + length);
    return { fin, opcode, payload };
  }
}

/**
 * 一条已建立的 WebSocket 连接。
 * 事件：'message'(string) / 'close'(code, reason) / 'error'(Error)
 */
export class WebSocketConnection extends EventEmitter {
  #socket;
  #parser;
  #closed = false;
  #closeSent = false;
  #isClient;
  #maxPayload;

  constructor(socket, { isClient = false, maxPayload = DEFAULT_MAX_PAYLOAD } = {}) {
    super();
    this.#socket = socket;
    this.#isClient = isClient;
    this.#maxPayload = maxPayload;
    this.#parser = new FrameParser({ maxPayload });

    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('close', () => this.#finish(1006, 'socket closed'));
    /**
     * `end` 必须单独处理，这是本条实现里最容易漏掉、也最难查的一个坑：
     *
     * 从 HTTP `upgrade` 事件拿到的 socket 是**半开**语义——对端发了 FIN，本端只会收到
     * `'end'`，而不会收到 `'close'`（本端仍然可写，所以 Node 不认为连接结束了）。
     * 结果是：一方 destroy() 之后，另一方永远认为对方还在线。
     *
     * WebSocket 是在一条流上的全双工协议，收到 FIN 就表示对端不会再发任何数据，
     * 此时必须由本端收尾。这个 bug 是靠「两个真实节点 + 断线重连」的端到端测试暴露的，
     * 单看握手和消息往返是发现不了的。
     */
    socket.on('end', () => {
      this.#finish(1006, 'peer closed the stream');
      socket.destroy();
    });
    socket.on('error', (error) => {
      this.emit('error', error);
      this.#finish(1006, error.message);
    });
  }

  get isClient() {
    return this.#isClient;
  }

  get closed() {
    return this.#closed;
  }

  get remoteAddress() {
    return this.#socket.remoteAddress ?? null;
  }

  /**
   * 带端口的来源地址，形如 `203.0.113.7:51423`。
   *
   * 这个值对打洞至关重要：NAT 之后**只有对端看得到你的公网端口**，你自己看不到。
   * 早先只暴露了 `remoteAddress`（纯 IP、没有端口），于是中继回答 STUN 探测时
   * 给出的是 `127.0.0.1`，解析不出端口 → 打洞协调器静默丢弃 → 每次都是 punch-timeout。
   * 丢在一个"看起来有值、其实缺一半"的字段上。
   */
  get remoteEndpoint() {
    const address = this.#socket.remoteAddress;
    const port = this.#socket.remotePort;
    if (!address || !port) return null;
    // IPv6 要加方括号，否则 `::1:51423` 无法解析。
    const host = address.includes(':') ? `[${address}]` : address;
    return `${host}:${port}`;
  }

  #onData(chunk) {
    let messages;
    try {
      messages = this.#parser.push(chunk);
    } catch (error) {
      // 协议错误必须断开，而不是继续读一个已经错位的字节流。
      this.emit('error', error);
      this.close(1002, 'protocol error');
      return;
    }
    for (const message of messages) {
      if (message.opcode === OPCODE.CLOSE) {
        // RFC6455 §5.5.1：收到 Close 帧后**必须**回一个 Close 帧。
        // 少了这一步，严格实现（比如 Node 内置的 WebSocket）会一直等关闭握手，
        // 表现为 close() 之后再无任何事件——这个 bug 就是被内置客户端对打测出来的。
        const code = message.payload.length >= 2 ? message.payload.readUInt16BE(0) : 1005;
        const reason = message.payload.subarray(2).toString('utf8');
        this.#sendClose(code === 1005 ? 1000 : code, '');
        this.#finish(code, reason);
        try {
          this.#socket.end();
        } catch {
          // 对端可能已经走了。
        }
        return;
      }
      if (message.opcode === OPCODE.PING) {
        this.#write(encodeFrame(message.payload, { opcode: OPCODE.PONG, mask: this.#isClient }));
        continue;
      }
      if (message.opcode === OPCODE.PONG) continue;
      if (message.opcode === OPCODE.TEXT) this.emit('message', message.payload.toString('utf8'));
      else if (message.opcode === OPCODE.BINARY) this.emit('binary', message.payload);
    }
  }

  #write(frame) {
    if (this.#closed) return false;
    try {
      this.#socket.write(frame);
      return true;
    } catch (error) {
      this.emit('error', error);
      return false;
    }
  }

  /** 发送一条文本消息。 */
  send(text) {
    return this.#write(encodeFrame(text, { opcode: OPCODE.TEXT, mask: this.#isClient }));
  }

  sendBinary(buffer) {
    return this.#write(encodeFrame(buffer, { opcode: OPCODE.BINARY, mask: this.#isClient }));
  }

  ping(payload = Buffer.alloc(0)) {
    return this.#write(encodeFrame(payload, { opcode: OPCODE.PING, mask: this.#isClient }));
  }

  /** 发一个 Close 帧（只发一次）。 */
  #sendClose(code, reason) {
    if (this.#closeSent) return;
    this.#closeSent = true;
    const reasonBytes = Buffer.from(reason, 'utf8').subarray(0, 123);
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    this.#write(encodeFrame(payload, { opcode: OPCODE.CLOSE, mask: this.#isClient }));
  }

  /** 主动关闭：发 Close 帧、标记关闭、结束 socket。幂等。 */
  close(code = 1000, reason = '') {
    if (this.#closed) return;
    this.#sendClose(code, reason);
    this.#finish(code, reason);
    try {
      this.#socket.end();
    } catch {
      // 已经断了就算了。
    }
  }

  #finish(code, reason) {
    if (this.#closed) return;
    this.#closed = true;
    this.emit('close', code, reason);
  }

  /** 立即摧毁底层 socket。用于插件卸载，不给对端回 close 帧的机会。 */
  destroy() {
    this.#finish(1006, 'destroyed');
    try {
      this.#socket.destroy();
    } catch {
      // 已经断了。
    }
  }
}

/**
 * 起一个 WebSocket 服务端。
 * @returns {Promise<{port:number, host:string, close:()=>Promise<void>, connections:Set}>}
 */
export function createWebSocketServer({
  host = '127.0.0.1',
  port = 0,
  path = '/dsh-chat',
  maxPayload = DEFAULT_MAX_PAYLOAD,
  onConnection = () => {},
  onError = () => {},
} = {}) {
  const connections = new Set();

  const server = createServer((req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dsh-chat: 这是一个 WebSocket 端点，请使用 Upgrade 握手。\n');
  });

  server.on('upgrade', (req, socket) => {
    const requestPath = (req.url ?? '/').split('?')[0];
    if (requestPath !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    const version = req.headers['sec-websocket-version'];
    if (typeof key !== 'string' || version !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '\r\n',
    ].join('\r\n'));
    socket.setNoDelay(true);

    const connection = new WebSocketConnection(socket, { isClient: false, maxPayload });
    connections.add(connection);
    connection.on('close', () => connections.delete(connection));
    connection.on('error', (error) => onError(error, connection));
    try {
      onConnection(connection, req);
    } catch (error) {
      onError(error, connection);
      connection.close(1011, 'handler failed');
    }
  });

  server.on('error', onError);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const address = server.address();
      resolve({
        host: typeof address === 'object' && address ? address.address : host,
        port: typeof address === 'object' && address ? address.port : port,
        connections,
        /**
         * 关闭服务端。
         *
         * 注意必须**强制**断开底层 socket：只发 close 帧的话，对端（尤其是浏览器）
         * 可能不回 close 帧，`server.close()` 就会一直等这些连接，插件卸载时表现为卡死。
         * 所以先礼貌地发 close 帧，再 destroy 掉 socket。
         */
        close: () => new Promise((done) => {
          for (const connection of connections) connection.close(1001, 'server shutting down');
          server.close(() => done());
          // 同 tick 内不强杀，给 close 帧一点时间写出去。
          setImmediate(() => {
            try {
              server.closeAllConnections?.();
            } catch {
              // 老版本 Node 没有这个方法，靠下面的 destroy 兜底。
            }
            for (const connection of connections) connection.destroy();
          });
        }),
      });
    });
  });
}

/**
 * 连一个 WebSocket 服务端。解析 101 响应后把 socket 交给 WebSocketConnection。
 */
export function connectWebSocket(url, { maxPayload = DEFAULT_MAX_PAYLOAD, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`非法 WebSocket URL: ${url}`));
      return;
    }
    if (parsed.protocol !== 'ws:') {
      reject(new Error(`只支持 ws:// ，收到 ${parsed.protocol}`));
      return;
    }

    const key = randomBytes(16).toString('base64');
    // `URL.hostname` 对 IPv6 保留方括号（'[::1]'），交给 net.connect 会失败，必须先去掉。
    const socket = netConnect(Number(parsed.port || 80), unbracketHost(parsed.hostname));
    let handshakeBuffer = Buffer.alloc(0);
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`连接 ${url} 超时`));
    }, timeoutMs);

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };

    socket.on('error', fail);
    socket.once('connect', () => {
      socket.write([
        `GET ${parsed.pathname || '/dsh-chat'} HTTP/1.1`,
        `Host: ${parsed.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '\r\n',
      ].join('\r\n'));
    });

    const onHandshakeData = (chunk) => {
      handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
      const end = handshakeBuffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const head = handshakeBuffer.subarray(0, end).toString('utf8');
      const rest = handshakeBuffer.subarray(end + 4);
      socket.off('data', onHandshakeData);

      const statusLine = head.split('\r\n')[0] ?? '';
      if (!/ 101 /.test(statusLine)) return fail(new Error(`握手被拒绝: ${statusLine}`));
      const expected = acceptKey(key);
      if (!head.includes(expected)) return fail(new Error('Sec-WebSocket-Accept 校验失败'));

      settled = true;
      clearTimeout(timer);
      const connection = new WebSocketConnection(socket, { isClient: true, maxPayload });
      if (rest.length > 0) socket.emit('data', rest);
      resolve(connection);
    };
    socket.on('data', onHandshakeData);
  });
}

export { OPCODE, acceptKey, DEFAULT_MAX_PAYLOAD };
