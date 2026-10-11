/**
 * 网络条件矩阵测试。
 *
 * 每个用例都是一次完整的真实链路：两个独立的 `LanTransport` 节点（真实 TCP、
 * 真实 WebSocket、真实 Ed25519 握手），中间夹一个按需注入故障的 TCP 代理。
 *
 * 覆盖的链路条件：
 *   延迟 / 抖动 / 分片 / 带宽限制 / 黑洞（丢包但不关连接）/ 连接重置 /
 *   半关闭 / 握手超时 / 字节损坏 / 并发连接 / 反复断连重连
 *
 * 每个用例都同时断言两件事：
 *   1. **连接行为**（该成功的成功、该失败的失败得干净）；
 *   2. **数据完整性**（收到的载荷哈希与发出的完全一致，且没有重复）。
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  MESSAGE_KIND, connectThroughProxy, digest, makeNode, sleep, teardown, waitFor,
} from './harness.js';

/**
 * 清理账本，**每个用例结束后立刻清空**。
 *
 * 一开始是"所有用例共用一个账本、在文件末尾统一清理"。结果是每个用例的代理和节点
 * 都还活着，十几个代理的定时器一起跑，事件循环被压满 —— 表现是越靠后的用例越慢，
 * 最后那个"高延迟 + 分片"的极端场景直接超时。
 *
 * 这类问题的症状很容易被误读成"被测代码在这个场景下不行"，
 * 所以修法要写清楚：**每条用例自己收尾，不要攒到最后。**
 */
let pending = [];
beforeEach(() => { pending = []; });
afterEach(async () => {
  for (const fn of pending.reverse()) await fn().catch(() => {});
  pending = [];
});

function track(resources) {
  pending.push(() => teardown(resources));
  return resources;
}

/**
 * 通过一条（可能很差的）链路收发 N 条消息，返回实测数据。
 * 这是所有场景共用的"业务动作"。
 */
async function exchange(a, b, { count = 5, size = 48, timeoutMs = 8000 } = {}) {
  const peerKey = b.identity.publicKeyId;
  const sent = [];
  for (let i = 0; i < count; i += 1) {
    const payload = { seq: i, body: `m${i}-`.padEnd(size, 'x') };
    const envelope = a.send(peerKey, MESSAGE_KIND.DIRECT_MESSAGE, payload);
    sent.push({ id: envelope.id, payload });
  }
  await waitFor(() => b.received.length >= count, {
    label: `B 收到 ${count} 条消息`,
    timeoutMs,
  });
  // 去重检查：同一条信封 id 不应出现两次
  const ids = b.received.map((item) => item.envelope.id);
  return {
    sent: sent.map((s) => s.payload),
    received: b.received.map((item) => item.payload),
    duplicateIds: ids.length - new Set(ids).size,
  };
}

describe('网络条件矩阵', () => {
  it('① 理想链路：基线，握手 + 消息往返 + 数据完整', async () => {
    const r = track(await connectThroughProxy({ faults: {} }));
    const started = Date.now();
    const result = await exchange(r.a, r.b, { count: 8 });

    assert.equal(result.duplicateIds, 0, '不应有重复消息');
    assert.deepEqual(result.received, result.sent, '载荷必须逐字节一致');
    console.log(`    链接 ${r.link}`);
    console.log(`    8 条消息往返耗时 ${Date.now() - started}ms，载荷哈希 ${digest(result.received)}`);
  });

  it('② 高延迟 150ms：仍能完成握手与数据交换', async () => {
    const r = track(await connectThroughProxy({ faults: { latencyMs: 150 } }));
    const result = await exchange(r.a, r.b, { count: 4 });
    assert.deepEqual(result.received, result.sent);
    console.log(`    150ms 单向延迟下 4 条消息完成，载荷哈希 ${digest(result.received)}`);
  });

  it('③ 高抖动 20~500ms：仍能完成握手与数据交换', async () => {
    const r = track(await connectThroughProxy({ faults: { latencyMs: 20, jitterMs: 480 } }));
    const result = await exchange(r.a, r.b, { count: 4 });
    assert.deepEqual(result.received, result.sent);
    console.log(`    抖动 20~500ms 下 4 条消息完成，载荷哈希 ${digest(result.received)}`);
  });

  it('④ 逐字节分片：帧重组正确（逼出所有"半帧"路径）', async () => {
    const r = track(await connectThroughProxy({ faults: { chunkSize: 1 } }));
    const result = await exchange(r.a, r.b, { count: 3, size: 120 });
    assert.deepEqual(result.received, result.sent, '逐字节分片下数据必须完全一致');
    console.log(`    每 1 字节一次转发，3 条 120 字节消息完整，代理共转发 ${r.proxy.stats.chunksDown} 个上行分片`);
  });

  it('⑤ 带宽限制 32KB/s：大消息最终送达且完整', async () => {
    const r = track(await connectThroughProxy({ faults: { bandwidthBps: 32 * 1024 } }));
    const started = Date.now();
    const result = await exchange(r.a, r.b, { count: 1, size: 16 * 1024 });
    const elapsed = Date.now() - started;
    assert.deepEqual(result.received, result.sent);
    console.log(`    16KB 载荷在 32KB/s 链路上耗时 ${elapsed}ms（代理转发 ${r.proxy.stats.bytesDown} 字节）`);
  });

  it('⑥ 黑洞 1.5 秒：冻结期间不丢数据，恢复后照常送达', async () => {
    // 建立连接之后再冻结，模拟"链路卡住一会儿但连接没断"——这是真实丢包的表现形式
    // （TCP 会重传，上层看到的就是"卡住"）。
    const b = makeNode({ nickname: 'B' });
    await b.start();
    const a = makeNode({ nickname: 'A' });
    await a.start();
    const proxy = await (await import('./fault-proxy.js')).startFaultProxy({
      targetPort: Number(b.address.split(':').pop()),
      faults: { stallAfterMs: 300, stallForMs: 1500 },
    });
    track({ a, b, proxy });
    await a.transport.connect(proxy.address);
    await waitFor(() => a.transport.peers().length === 1, { label: '握手完成', timeoutMs: 4000 });

    await sleep(400); // 让冻结窗口开始
    const result = await exchange(a, b, { count: 3 });
    assert.deepEqual(result.received, result.sent, '冻结不该导致数据损坏或丢失');
    console.log(`    冻结 1.5s 后 3 条消息仍完整送达；代理累计冻结 ${proxy.stats.stalledMs}ms`);
  });

  it('⑦ 连接被重置（RST）：对端判定离线，随后可重新连上', async () => {
    const r = track(await connectThroughProxy({ faults: { resetAfterMs: 600 } }));
    await waitFor(() => r.b.peersDown.length >= 1, { label: 'B 检测到 A 离线', timeoutMs: 5000 });
    assert.equal(r.b.transport.peers().length, 0, 'RST 之后 B 不应还认为 A 在线');

    // 换一条干净链路重连，证明"断线不崩、能恢复"
    await r.proxy.close();
    const clean = await (await import('./fault-proxy.js')).startFaultProxy({
      targetPort: Number(r.b.address.split(':').pop()), faults: {},
    });
    r.proxy = clean;
    await r.a.transport.connect(clean.address);
    await waitFor(() => r.b.transport.peers().length === 1, { label: '重连成功', timeoutMs: 5000 });
    console.log(`    RST 后重连成功；B 记录的离线次数 ${r.b.peersDown.length}`);
  });

  it('⑧ 半关闭（只发 FIN）：对端必须判定离线（回归：曾经的"永远在线"bug）', async () => {
    const r = track(await connectThroughProxy({ faults: { halfCloseAfterMs: 600 } }));
    await waitFor(() => r.b.peersDown.length >= 1, { label: 'B 检测到半关闭并判定离线', timeoutMs: 5000 });
    assert.equal(r.b.transport.peers().length, 0);
    console.log('    半关闭被正确识别为离线（HTTP upgrade socket 的半开语义）');
  });

  it('⑨ 握手被拖过超时：connect() 如实返回 null，且之后仍能正常连接', async () => {
    /**
     * 这个用例暴露过一次"测试假通过"，值得记下来。
     *
     * 早先它用"连上后冻结 3 秒"来制造握手超时，而当时的 `connect()` 是**立即返回**的，
     * 于是断言 `peers().length === 0` 立刻就成立 —— 测试通过了，但它通过的原因
     * 是"握手还没开始"，而不是"握手超时被正确处理"。
     *
     * 后来 `connect()` 改成等握手真正有结果再返回，这个假通过就破了。
     * 同时暴露出原来的场景**根本不会触发握手超时**：冻结期间 HTTP 握手本身被推迟，
     * 而对端的握手计时器要等 HTTP 请求到达才开始计时，冻结结束时计时才刚起步。
     *
     * 现在改用高延迟链路：单程 1.2 秒，而握手上限只有 0.8 秒 ——
     * 双方都来不及在限期内完成身份交换，必然超时。
     */
    const b = makeNode({ nickname: 'B', handshakeTimeoutMs: 800 });
    await b.start();
    const a = makeNode({ nickname: 'A', connectTimeoutMs: 8000, handshakeTimeoutMs: 800 });
    await a.start();
    const proxy = await (await import('./fault-proxy.js')).startFaultProxy({
      targetPort: Number(b.address.split(':').pop()),
      faults: { latencyMs: 1200 },
    });
    track({ a, b, proxy });

    // 可能返回 null，也可能在连接阶段就抛错 —— 两者都是"干净失败"，都不该崩。
    let outcome = null;
    let threw = null;
    try {
      outcome = await a.transport.connect(proxy.address);
    } catch (error) {
      threw = error;
    }
    assert.equal(outcome, null, `被拖过握手上限时 connect() 必须如实返回 null，实际 ${String(outcome)}`);
    assert.equal(a.transport.peers().length, 0, '超时后不应残留半成品连接');

    // 换干净链路，证明超时没有把节点搞坏
    await proxy.close();
    const clean = await (await import('./fault-proxy.js')).startFaultProxy({
      targetPort: Number(b.address.split(':').pop()), faults: {},
    });
    track({ proxy: clean });
    const recovered = await a.transport.connect(clean.address);
    assert.equal(recovered, b.identity.publicKeyId, '超时之后必须仍能正常连接');
    console.log(`    1.2s 延迟 vs 0.8s 握手上限 → connect() 返回 null${threw ? `（或抛错：${threw.message.slice(0, 24)}）` : ''}；`
      + '换干净链路后连接恢复正常');
  });

  it('⑩ 字节流损坏：握手被干净拒绝，不崩溃、不误投递', async () => {
    const b = makeNode({ nickname: 'B' });
    await b.start();
    const a = makeNode({ nickname: 'A' });
    await a.start();
    const proxy = await (await import('./fault-proxy.js')).startFaultProxy({
      targetPort: Number(b.address.split(':').pop()), faults: { corruptRate: 1 },
    });
    track({ a, b, proxy });

    // 100% 损坏下握手不可能成功。**关键不是"失败"，而是"失败得干净"**：
    // 应该是一个可捕获的拒绝（101 校验不过），而不是未捕获异常或进程崩溃。
    let rejected = null;
    try {
      await a.transport.connect(proxy.address);
      // 也可能 TCP 层就断了、connect 成功但握手拿不到对端，等一会儿再判定
      await sleep(800);
    } catch (error) {
      rejected = error;
    }
    assert.ok(
      rejected !== null || a.transport.peers().length === 0,
      '损坏链路上不应建立出任何"成功的"连接',
    );
    // 没有把损坏内容当成有效信封投递上去
    assert.equal(b.received.length, 0, '损坏的字节流不应产生任何有效消息');
    assert.equal(a.received.length, 0);
    assert.equal(b.transport.peers().length, 0);

    // 进程仍然可用：换干净链路能连上
    await proxy.close();
    const clean = await (await import('./fault-proxy.js')).startFaultProxy({
      targetPort: Number(b.address.split(':').pop()), faults: {},
    });
    track({ proxy: clean });
    await a.transport.connect(clean.address);
    await waitFor(() => b.transport.peers().length === 1, { label: '损坏之后仍能正常连接', timeoutMs: 5000 });
    console.log(`    损坏链路上握手被拒绝（${rejected ? rejected.message.slice(0, 40) : '未能建立连接'}），`
      + '零有效消息投递；换干净链路后连接恢复正常');
  });

  it('⑪ 高延迟 + 分片叠加：恶劣组合下数据仍完整', async () => {
    // 这一组的握手正常约 800ms（实测中位数），但它是所有用例里最重的一组：
    // 一条 450 字节的信封会被切成 65 个分片，每个分片各自带 80~200ms 抖动。
    // 机器负载高时会明显变慢，所以给它更宽的窗口，并把实测值打出来。
    const r = track(await connectThroughProxy({
      faults: { latencyMs: 80, jitterMs: 120, chunkSize: 7, bandwidthBps: 256 * 1024 },
    }));
    const result = await exchange(r.a, r.b, { count: 4, size: 200, timeoutMs: 25000 });
    assert.deepEqual(result.received, result.sent, '组合恶劣条件下数据必须一致');
    console.log(`    80ms+120ms 抖动 + 7 字节分片 + 256KB/s：4 条消息完整，哈希 ${digest(result.received)}`);
  });

  it('⑫ 多节点并发：8 个节点同时连入同一节点，全部完成握手', async () => {
    const hub = makeNode({ nickname: 'hub' });
    await hub.start();
    const clients = [];
    const proxies = [];
    track({
      a: { stop: async () => { for (const c of clients) await c.stop(); } },
      b: hub,
      proxy: { close: async () => { for (const p of proxies) await p.close(); } },
    });

    const faults = [
      {}, { latencyMs: 40 }, { chunkSize: 3 }, { jitterMs: 100 },
      { bandwidthBps: 64 * 1024 }, { latencyMs: 10, chunkSize: 11 }, {}, { jitterMs: 30 },
    ];
    for (let i = 0; i < 8; i += 1) {
      const client = makeNode({ nickname: `c${i}` });
      await client.start();
      const proxy = await (await import('./fault-proxy.js')).startFaultProxy({
        targetPort: Number(hub.address.split(':').pop()), faults: faults[i],
      });
      clients.push(client);
      proxies.push(proxy);
      client.transport.connect(proxy.address).catch(() => {});
    }

    await waitFor(() => hub.transport.peers().length === 8, { label: '8 个节点全部握手完成', timeoutMs: 12000 });
    assert.equal(hub.transport.metrics.handshakes, 8);

    // 每个客户端各发一条，验证 hub 能全部收齐且来自不同发送者
    for (const client of clients) {
      client.send(hub.identity.publicKeyId, MESSAGE_KIND.PRESENCE, { nickname: client.nickname });
    }
    await waitFor(() => hub.received.length >= 8, { label: 'hub 收齐 8 条', timeoutMs: 8000 });
    const senders = new Set(hub.received.map((item) => item.envelope.from));
    assert.equal(senders.size, 8, '8 条消息应来自 8 个不同身份');
    console.log(`    8 个并发节点（各自不同链路条件）全部握手成功，hub 收到来自 ${senders.size} 个身份的消息`);
  });

  it('⑬ 反复断连重连 8 轮：不泄漏、最终稳定', async () => {
    const b = makeNode({ nickname: 'B' });
    await b.start();
    const a = makeNode({ nickname: 'A' });
    await a.start();
    track({ a, b, proxy: { close: async () => {} } });

    for (let round = 0; round < 8; round += 1) {
      const proxy = await (await import('./fault-proxy.js')).startFaultProxy({
        targetPort: Number(b.address.split(':').pop()), faults: {},
      });
      await a.transport.connect(proxy.address);
      await waitFor(() => b.transport.peers().length >= 1, { label: `第 ${round + 1} 轮连接`, timeoutMs: 4000 });
      await proxy.close();
      await waitFor(() => b.transport.peers().length === 0, { label: `第 ${round + 1} 轮断开`, timeoutMs: 4000 });
    }

    assert.equal(a.transport.peers().length, 0);
    assert.equal(b.transport.peers().length, 0);
    assert.ok(b.transport.metrics.handshakes >= 8, `应有至少 8 次成功握手，实际 ${b.transport.metrics.handshakes}`);
    console.log(`    8 轮断连重连完成：B 累计握手 ${b.transport.metrics.handshakes} 次，`
      + `当前连接数 ${b.transport.metrics.openConnections}，无残留`);
  });
});
