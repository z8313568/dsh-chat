/**
 * WebSocket 实现的交叉验证。
 *
 * 关键点：**用 Node 内置的 WebSocket 客户端**去连我们手写的服务端。
 * 如果只有我们自己的客户端连我们自己的服务端，两边可以「一起错」——
 * 握手算错、掩码漏做、长度字段写错，都可能自洽通过。拿一个独立实现来对打，
 * 才说明这个 RFC6455 实现是真的。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { FrameParser, connectWebSocket, createWebSocketServer, encodeFrame } from '../src/host/net/ws.js';

/** 等待一个事件，并在超时后失败——避免测试挂住而不是报错。 */
function once(emitter, event, { timeoutMs = 5000, label = event } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${label} 超时`)), timeoutMs);
    emitter.addEventListener?.(event, (value) => {
      clearTimeout(timer);
      resolve(value);
    }, { once: true });
    emitter.on?.(event, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

describe('RFC6455 WebSocket', () => {
  let server;
  const received = [];

  before(async () => {
    server = await createWebSocketServer({
      host: '127.0.0.1',
      port: 0,
      path: '/dsh-chat',
      onConnection: (connection) => {
        connection.on('message', (text) => {
          received.push(text);
          // 回显，前缀证明这条确实经过了服务端。
          connection.send(`echo:${text}`);
        });
      },
    });
  });

  after(async () => {
    await server?.close();
  });

  it('接受 Node 内置 WebSocket 客户端的握手与消息', async () => {
    const url = `ws://127.0.0.1:${server.port}/dsh-chat`;
    const socket = new WebSocket(url);

    const echoed = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('内置客户端交互超时')), 5000);
      socket.addEventListener('open', () => socket.send('你好 dsh-chat'));
      socket.addEventListener('message', (event) => {
        clearTimeout(timer);
        resolve(event.data);
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('内置客户端报错'));
      });
    });

    assert.equal(echoed, 'echo:你好 dsh-chat');
    assert.deepEqual(received, ['你好 dsh-chat']);

    // 必须等 close 真正完成再结束用例：否则底层连接会留着，
    // 测试进程不退出，而 `node --test` 在子进程退出前不打印任何结果——
    // 表现就是「什么都不输出地卡住」，非常难查。
    const closed = once(socket, 'close', { label: '内置客户端 close' });
    socket.close();
    await closed;
  });

  it('自研客户端可以连上自研服务端并往返', async () => {
    const connection = await connectWebSocket(`ws://127.0.0.1:${server.port}/dsh-chat`);
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('自研客户端交互超时')), 5000);
      connection.on('message', (text) => {
        clearTimeout(timer);
        resolve(text);
      });
      connection.send('ping-from-own-client');
    });
    assert.equal(reply, 'echo:ping-from-own-client');

    const closed = once(connection, 'close', { label: '自研客户端 close' });
    connection.close();
    await closed;
  });

  it('拒绝非 101 的握手目标（错误路径）', async () => {
    await assert.rejects(
      () => connectWebSocket(`ws://127.0.0.1:${server.port}/wrong-path`, { timeoutMs: 2000 }),
      /握手被拒绝|404/,
    );
  });

  it('帧解析器能跨 chunk 重组，并处理 126/127 长度分支', () => {
    // 说明：这里刻意**不**对 70KB 帧逐字节喂入。解析器内部是「单一缓冲 + 读偏移」，
    // 逐字节喂一个 70KB 帧会产生 O(n²) 的拼接量（约 2.4GB 拷贝），那是测试写法的问题，
    // 不是解析器的问题——真实网络里 chunk 是 64KB 级别的。
    // 下面按「切在真正危险的位置」来切，比逐字节更能说明问题。
    const cases = [
      { label: '短帧(逐字节)', size: 10, split: () => 1 },
      { label: '两字节长度(不齐三段)', size: 200, split: (i) => [1, 3, 2][i] ?? 7 },
      { label: '八字节长度(头部单切)', size: 70000, split: (i) => (i === 0 ? 10 : 65536) },
    ];
    for (const { label, size, split } of cases) {
      const parser = new FrameParser();
      const frame = encodeFrame(Buffer.from('x'.repeat(size)), { opcode: 0x1, mask: true });
      const messages = [];
      let offset = 0;
      let piece = 0;
      while (offset < frame.length) {
        const take = Math.min(split(piece), frame.length - offset);
        messages.push(...parser.push(frame.subarray(offset, offset + take)));
        offset += take;
        piece += 1;
      }
      assert.equal(messages.length, 1, `${label} 应解析出恰好一条消息`);
      assert.equal(messages[0].payload.length, size, `${label} 载荷长度应正确`);
    }
  });

  it('分片消息被正确重组', () => {
    const parser = new FrameParser();
    const first = encodeFrame(Buffer.from('前半'), { opcode: 0x1, fin: false });
    const second = encodeFrame(Buffer.from('后半'), { opcode: 0x0, fin: true });
    assert.deepEqual(parser.push(first), [], '分片未结束时不应产出消息');
    const messages = parser.push(second);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].payload.toString('utf8'), '前半后半');
  });
});
