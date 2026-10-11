/**
 * 网络拓扑矩阵测试。
 *
 * 前面的 `matrix.test.js` 测的是"链路质量"（延迟、丢包表现、断连……），
 * 这里测的是**链路走在哪里**：回环、IPv6 回环、真实局域网网卡、跨地址族。
 *
 * 为什么要分开：这两类问题的失败方式完全不同。
 * 链路质量问题的表现是"慢/断"，拓扑问题的表现是"根本连不上"——
 * 而且拓扑问题（比如地址解析）在回环上永远测不出来。
 *
 * 各拓扑的可得性由运行环境决定，所以每个用例先探测再判定；
 * 探测不到就**跳过并说明原因**，不假装通过。
 */
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { describe, it } from 'node:test';

import { MESSAGE_KIND, makeNode, sleep, waitFor } from './harness.js';

/** 找出本机第一个非回环 IPv4 地址（真实局域网网卡）。 */
function findLanIPv4() {
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return { name, address: address.address };
    }
  }
  return null;
}

/** 探测某个地址能不能真的绑上去。 */
async function canBind(host) {
  const node = makeNode({ nickname: 'probe', listenHost: host });
  try {
    await node.start();
    return node.address;
  } catch {
    return null;
  } finally {
    await node.stop();
  }
}

const cleanups = [];
async function cleanupAll() {
  for (const fn of cleanups.reverse()) await fn().catch(() => {});
  cleanups.length = 0;
}

/** 跑一轮完整的"连接 + 双向数据"，返回实测数据。 */
async function verifyLink(a, b, { label }) {
  await a.transport.connect(b.address);
  await waitFor(() => a.transport.peers().length === 1 && b.transport.peers().length === 1, {
    label: `${label} 双向握手`,
    timeoutMs: 8000,
  });

  const payload = { via: label, body: 'x'.repeat(300) };
  a.send(b.identity.publicKeyId, MESSAGE_KIND.DIRECT_MESSAGE, payload);
  await waitFor(() => b.received.length >= 1, { label: `${label} 收到消息`, timeoutMs: 8000 });

  const got = b.received[0].payload;
  assert.deepEqual(got, payload, `${label} 上的载荷必须逐字节一致`);

  // 反向也走一遍，避免只测了单向
  const back = { via: `${label}-back`, body: 'y'.repeat(300) };
  b.send(a.identity.publicKeyId, MESSAGE_KIND.DIRECT_MESSAGE, back);
  await waitFor(() => a.received.length >= 1, { label: `${label} 反向收到消息`, timeoutMs: 8000 });
  assert.deepEqual(a.received[0].payload, back);

  return { a: a.address, b: b.address };
}

describe('网络拓扑矩阵', () => {
  it('① 回环 IPv4：127.0.0.1 ↔ 127.0.0.1（基线）', async () => {
    const a = makeNode({ nickname: 'A', listenHost: '127.0.0.1' });
    const b = makeNode({ nickname: 'B', listenHost: '127.0.0.1' });
    cleanups.push(() => a.stop(), () => b.stop());
    await a.start();
    await b.start();
    const result = await verifyLink(a, b, { label: 'loopback-v4' });
    console.log(`    A=${result.a}  B=${result.b}  双向数据完整`);
    await cleanupAll();
  });

  it('② 回环 IPv6：::1 ↔ ::1（地址解析必须能处理方括号）', async () => {
    const addressOfA = await canBind('::1');
    if (addressOfA === null) {
      console.log('    ⏭ 本机不支持绑定 ::1，跳过');
      return;
    }
    const a = makeNode({ nickname: 'A', listenHost: '::1' });
    const b = makeNode({ nickname: 'B', listenHost: '::1' });
    cleanups.push(() => a.stop(), () => b.stop());
    await a.start();
    await b.start();

    assert.match(b.address, /^\[::1\]:\d+$/, `IPv6 地址必须带方括号，实际: ${b.address}`);
    const result = await verifyLink(a, b, { label: 'loopback-v6' });
    console.log(`    A=${result.a}  B=${result.b}  IPv6 双向数据完整`);
    await cleanupAll();
  });

  it('③ 真实局域网网卡：绑定 en 地址并从回环连过去', async () => {
    const lan = findLanIPv4();
    if (!lan) {
      console.log('    ⏭ 本机没有非回环 IPv4 地址，跳过');
      return;
    }
    const a = makeNode({ nickname: 'A', listenHost: '127.0.0.1' });
    const b = makeNode({ nickname: 'B', listenHost: lan.address });
    cleanups.push(() => a.stop(), () => b.stop());
    await a.start();
    await b.start();

    assert.match(b.address, new RegExp(`^${lan.address.replace(/\./g, '\\.')}:\\d+$`));
    const result = await verifyLink(a, b, { label: `lan-${lan.name}` });
    console.log(`    A=${result.a}（回环）→ B=${result.b}（${lan.name}）  跨接口数据完整`);
    await cleanupAll();
  });

  it('④ 同一局域网地址两端互连：走真实网卡而不是 lo0', async () => {
    const lan = findLanIPv4();
    if (!lan) {
      console.log('    ⏭ 本机没有非回环 IPv4 地址，跳过');
      return;
    }
    const a = makeNode({ nickname: 'A', listenHost: lan.address });
    const b = makeNode({ nickname: 'B', listenHost: lan.address });
    cleanups.push(() => a.stop(), () => b.stop());
    await a.start();
    await b.start();
    const result = await verifyLink(a, b, { label: `lan-both-${lan.name}` });
    console.log(`    A=${result.a}  B=${result.b}（都在 ${lan.name} 上）双向数据完整`);
    await cleanupAll();
  });

  it('⑤ 双栈下的跨地址族主动连接：IPv4 监听节点可以拨到 IPv6 监听节点', async () => {
    // 这里最初的假设是错的，值得写下来：
    // 我以为"监听在 127.0.0.1 的节点连不上监听在 ::1 的节点"，于是写了个断言"应当失败"。
    // 实际上**出站连接不依赖本端监听地址** —— 拨号方会按目标地址新建一个 IPv6 socket，
    // 所以同一台双栈主机上这是能通的。真正连不通的是"纯 IPv4 网络里的机器去连纯 IPv6 地址"，
    // 那需要两台机器和两种网络，单机测不了（见 docs/network-testing.md 的不可测清单）。
    const addressOfB = await canBind('::1');
    if (addressOfB === null) {
      console.log('    ⏭ 本机不支持 ::1，跳过');
      return;
    }
    const a = makeNode({ nickname: 'A', listenHost: '127.0.0.1' });
    const b = makeNode({ nickname: 'B', listenHost: '::1' });
    cleanups.push(() => a.stop(), () => b.stop());
    await a.start();
    await b.start();

    const result = await verifyLink(a, b, { label: 'dual-stack-v4-to-v6' });
    console.log(`    A=${result.a}（IPv4 监听）→ B=${result.b}（IPv6 监听）双向数据完整`);
    await cleanupAll();
  });

  it('⑥ 局域网 UDP 信标发现：两个实例在真实网卡上互相发现', async () => {
    const lan = findLanIPv4();
    if (!lan) {
      console.log('    ⏭ 本机没有非回环 IPv4 地址，跳过');
      return;
    }
    // 用一个不常用的端口，避免与正在运行的 DSH 插件实例（47899）互相干扰。
    const beaconPort = 47911;
    // autoConnect 必须打开：否则"互相发现"这件事不会变成连接，测的就不是完整链路了。
    const a = makeNode({ nickname: 'lan-A', listenHost: lan.address, discovery: true, autoConnect: true, beaconPort });
    const b = makeNode({ nickname: 'lan-B', listenHost: lan.address, discovery: true, autoConnect: true, beaconPort });
    cleanups.push(() => a.stop(), () => b.stop());
    await a.start();
    await b.start();

    // 不手工 connect：这里要证明的正是"它们自己找到对方"。
    await waitFor(() => a.transport.peers().length === 1 && b.transport.peers().length === 1, {
      label: '局域网信标自动互连',
      timeoutMs: 20000,
    });
    const peerOfA = a.transport.peers()[0];
    assert.equal(peerOfA.peerKey, b.identity.publicKeyId);
    assert.match(peerOfA.address, new RegExp(`^${lan.address.replace(/\./g, '\\.')}:\\d+$`),
      '信标里带的应当是真实网卡地址');
    console.log(`    通过 ${lan.address} 上的 UDP 信标互相发现并自动握手成功`);
    await cleanupAll();
  });

  it('⑦ 信标端口被占用时降级为手工连接，而不是让节点起不来', async () => {
    // 先用一个 udp4 socket 占住端口，再让节点在这个端口上开信标。
    const squatter = createSocket({ type: 'udp4', reuseAddr: false });
    const taken = await new Promise((resolve) => {
      squatter.once('error', () => resolve(false));
      squatter.bind(47912, '127.0.0.1', () => resolve(true));
    });
    if (!taken) {
      console.log('    ⏭ 无法占住测试端口，跳过');
      return;
    }
    try {
      const a = makeNode({ nickname: 'A', discovery: true, beaconPort: 47912 });
      cleanups.push(() => a.stop());
      await a.start(); // 不应抛错
      assert.equal(a.transport.running, true, '信标不可用时节点仍应正常监听');
      assert.ok(a.transport.address, 'TCP 监听不应受 UDP 信标失败影响');

      // 手工连接仍然可用
      const b = makeNode({ nickname: 'B' });
      cleanups.push(() => b.stop());
      await b.start();
      await b.transport.connect(a.address);
      await waitFor(() => b.transport.peers().length === 1, { label: '手工连接仍可用', timeoutMs: 5000 });
      console.log(`    信标端口被占用时节点照常启动（${a.transport.address}），手工连接可用`);
    } finally {
      squatter.close();
      await cleanupAll();
    }
  });
});

describe('地址解析（拓扑问题的真正来源）', () => {
  it('IPv6 地址必须带方括号，两端格式一致', async () => {
    const { formatPeerAddress, parsePeerAddress, isPeerAddress, isLoopbackHost } = await import('../../src/host/net/address.js');

    assert.equal(formatPeerAddress('::1', 8080), '[::1]:8080');
    assert.equal(formatPeerAddress('127.0.0.1', 80), '127.0.0.1:80');
    assert.deepEqual(parsePeerAddress('[::1]:8080'), { host: '::1', port: 8080 });
    assert.deepEqual(parsePeerAddress('127.0.0.1:80'), { host: '127.0.0.1', port: 80 });

    // 没加方括号的 IPv6 是歧义的，必须拒绝而不是猜
    assert.equal(parsePeerAddress('::1:8080'), null);
    assert.equal(isPeerAddress('::1:8080'), false);
    assert.equal(isPeerAddress('[::1]:8080'), true);

    // 非法端口
    assert.equal(parsePeerAddress('1.2.3.4:0'), null);
    assert.equal(parsePeerAddress('1.2.3.4:99999'), null);
    assert.equal(parsePeerAddress('nonsense'), null);
    assert.equal(parsePeerAddress(null), null);

    assert.equal(isLoopbackHost('[::1]'), true);
    assert.equal(isLoopbackHost('::1'), true);
    assert.equal(isLoopbackHost('192.168.3.90'), false);
  });
});
