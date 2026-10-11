/**
 * 虚拟网络环境下的真实场景测试。
 *
 * 这一组针对的正是之前报告里"单机测不了"的那部分：
 * NAT 穿透、跨网段、防火墙、真实丢包、IPv4-only 主机、广播域隔离。
 *
 * 现在它们**可以测**了 —— 不是因为物理网络变了，而是因为把决定连通性的那些语义
 * 用用户态代码如实搭了出来（见 virtual-internet.js 的说明）。
 */
import assert from 'node:assert/strict';
import { createServer, connect as netConnect } from 'node:net';
import { afterEach, describe, it } from 'node:test';

import { NAT_MODE, VirtualInternet } from './virtual-internet.js';
import { VirtualLink } from './virtual-link.js';

let internet = null;
const extras = [];

afterEach(async () => {
  // 注意：有些清理函数是同步的（比如 client.destroy() 返回 undefined），
  // 直接 .catch 会炸。统一包一层 Promise.resolve。
  for (const fn of extras.reverse()) await Promise.resolve().then(fn).catch(() => {});
  extras.length = 0;
  await internet?.close().catch(() => {});
  internet = null;
});

/**
 * 搭一个典型家用拓扑：
 *
 *   lan-a(10.0.1) ── gwA(公网 203.0.113.1) ── wan ── gwB(公网 203.0.113.2) ── lan-b(10.0.2)
 */
function buildHomeTopology({ modeA = NAT_MODE.CONE, modeB = NAT_MODE.CONE, firewallA = null, firewallB = null } = {}) {
  internet = new VirtualInternet();
  internet.defineSubnet('lan-a', '10.0.1');
  internet.defineSubnet('wan', '203.0.113');
  internet.defineSubnet('lan-b', '10.0.2');

  const gwA = internet.createGateway({
    name: 'gwA', lanSubnet: 'lan-a', mode: modeA, firewall: firewallA, publicIp: '203.0.113.1',
  });
  const gwB = internet.createGateway({
    name: 'gwB', lanSubnet: 'lan-b', mode: modeB, firewall: firewallB, publicIp: '203.0.113.2',
  });
  internet.registerHost('A', { subnet: 'lan-a', ip: '10.0.1.5', realPort: 0, gateway: gwA });
  internet.registerHost('B', { subnet: 'lan-b', ip: '10.0.2.5', realPort: 0, gateway: gwB });
  return { gwA, gwB };
}

describe('虚拟网络：NAT 语义', () => {
  it('① 同一子网内可以直连（基线）', () => {
    const { gwA } = buildHomeTopology();
    internet.registerHost('A2', { subnet: 'lan-a', ip: '10.0.1.6', realPort: 0, gateway: gwA });
    // （下面这条断言依赖 A2 已注册；早先漏了注册，结果 reason 是 no-route 而不是 same-subnet）
    const verdict = internet.decide({ fromHost: 'A', dstIp: '10.0.1.6', dstPort: 47800 });
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.reason, 'same-subnet');
  });

  it('② 跨 NAT 主动拨号：目的侧没有端口映射 → 被拒绝（这就是真实 NAT 的行为）', () => {
    buildHomeTopology();
    const verdict = internet.decide({ fromHost: 'A', dstIp: '10.0.2.5', dstPort: 47800 });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, 'nat-inbound-blocked');
    assert.equal(verdict.gateway.name, 'gwB');
  });

  it('③ 目的侧做了端口映射 → 可以连上（端口转发的效果）', async () => {
    const { gwB } = buildHomeTopology();
    await gwB.addPortMapping('B', 47800, { publicPort: 47800 });
    const verdict = internet.decide({ fromHost: 'A', dstIp: '10.0.2.5', dstPort: 47800 });
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.reason, 'static-port-mapping');
    assert.equal(verdict.publicPort, 47800);
  });

  it('④ 双侧 NAT：只有一侧映射仍然连不上（必须目的侧有映射）', async () => {
    const { gwA } = buildHomeTopology();
    await gwA.addPortMapping('A', 47800, { publicPort: 47800 });
    // A 自己有映射，但 B 没有 → A 主动连 B 依然被 gwB 拒绝
    assert.equal(internet.decide({ fromHost: 'A', dstIp: '10.0.2.5', dstPort: 47800 }).allowed, false);
  });

  it('⑤ 出站建立的映射能让对端打回来（打洞的核心）', async () => {
    const { gwA } = buildHomeTopology();
    const outbound = await gwA.dialOut({
      hostName: 'A', hostPort: 47800,
      dstIp: '10.0.2.5', dstPort: 47800,
      dstPublicIp: '203.0.113.2', dstPublicRealPort: 0, subnetOf: 'lan-a',
    });
    assert.equal(outbound.allowed, true, '出站永远放行');
    const publicPortOfA = outbound.publicPort;

    // 源地址与 A 出站的目的地一致（203.0.113.2）→ 正是这条映射对应的对端，放行
    const inbound = await gwA.connectInbound(publicPortOfA, { srcIp: '203.0.113.2', srcPort: 47800 });
    assert.equal(inbound.accepted, true);
    assert.equal(inbound.reason, 'hole-punched');
    console.log(`    出站建立的映射（公网端口 ${publicPortOfA}）放行了对应端的回连`);
  });

  it('⑤b 全锥形与受限锥形对"陌生地址"的处理不同 —— 这正是打洞能力的差别', async () => {
    /**
     * 这里修正过一次模型错误，值得记下来。
     *
     * 最初只区分 cone / symmetric 两种，于是"全锥形"测试里断言的
     * 「陌生地址被拒」其实是**受限锥形**的行为。真正的全锥形对任何来源都敞开 ——
     * 这也是它打洞最容易的原因。测试当时是通过的，但测的是另一个东西。
     */
    const fullCone = buildHomeTopology({ modeA: NAT_MODE.CONE });
    const outCone = await fullCone.gwA.dialOut({
      hostName: 'A', hostPort: 47800, dstIp: '10.0.2.5', dstPort: 47800,
      dstPublicIp: '203.0.113.2', dstPublicRealPort: 0, subnetOf: 'lan-a',
    });
    const strangerOnCone = await fullCone.gwA.connectInbound(outCone.publicPort, { srcIp: '203.0.113.99', srcPort: 47800 });
    assert.equal(strangerOnCone.accepted, true);
    assert.equal(strangerOnCone.reason, 'full-cone-open-mapping');
    await internet.close();

    const restricted = buildHomeTopology({ modeA: NAT_MODE.RESTRICTED });
    const outRestricted = await restricted.gwA.dialOut({
      hostName: 'A', hostPort: 47800, dstIp: '10.0.2.5', dstPort: 47800,
      dstPublicIp: '203.0.113.2', dstPublicRealPort: 0, subnetOf: 'lan-a',
    });
    const strangerOnRestricted = await restricted.gwA.connectInbound(outRestricted.publicPort, { srcIp: '203.0.113.99', srcPort: 47800 });
    assert.equal(strangerOnRestricted.accepted, false);
    assert.equal(strangerOnRestricted.reason, 'restricted-cone-unseen-source');

    // 但受限锥形对"本机先发给过的地址"仍然放行 —— 所以它照样能打洞
    const known = await restricted.gwA.connectInbound(outRestricted.publicPort, { srcIp: '203.0.113.2', srcPort: 9999 });
    assert.equal(known.accepted, true);
    console.log('    全锥形：陌生地址也放行；受限锥形：只放行本机先发给过的地址（两者都能打洞）');
  });

  it('⑥ 对称 NAT 下打洞失败（这就是移动网络下 P2P 连不上的原因）', async () => {
    /**
     * 这个用例也修正过一次。
     *
     * 原来的写法是"手工造一个源地址正好等于映射目的地的包，断言被拒"。
     * 但对称 NAT **恰恰会放行这种包** —— 它只接受来自那条映射对应目的地的流量。
     * 所以断言错了：失败不是因为"这个包被拒"，而是因为**对方根本不知道要用哪个端口**。
     *
     * 正确的建模是走完整的打洞流程（先 STUN 拿公网端点，再互相打），
     * 让"端口对不上"这个真实原因自己浮现出来。
     */
    const { gwA } = buildHomeTopology({ modeA: NAT_MODE.SYMMETRIC });
    internet.registerHost('B', { subnet: 'lan-b', ip: '10.0.2.5', realPort: 47800, gateway: internet.gatewayOwning('10.0.2.5') });

    const punch = await internet.attemptHolePunch({ a: 'A', b: 'B' });
    assert.equal(punch.ok, false, '对称 NAT 下打洞必须失败');
    assert.equal(punch.needsRelay, true, '并且必须明确指出"这类网络需要中继"');
    console.log(`    对称 NAT：打洞失败（${punch.reason}，被 ${punch.blockedBy} 挡住）→ 只能走中继`);

    // 对照：全锥形下同样的流程能打通
    await internet.close();
    buildHomeTopology({ modeA: NAT_MODE.CONE, modeB: NAT_MODE.CONE });
    internet.registerHost('B', { subnet: 'lan-b', ip: '10.0.2.5', realPort: 47800, gateway: internet.gatewayOwning('10.0.2.5') });
    const conePunch = await internet.attemptHolePunch({ a: 'A', b: 'B' });
    assert.equal(conePunch.ok, true);
    assert.equal(conePunch.reason, 'punched');
    console.log(`    对照 · 全锥形：同样的流程打通（${conePunch.inboundA}）`);
    await gwA.close();
  });

  it('⑦ 全锥形 NAT 会复用同一目标的映射（于是公网端口稳定、对方算得出来）', async () => {
    const { gwA } = buildHomeTopology();
    const first = await gwA.dialOut({ hostName: 'A', hostPort: 47800, dstIp: '10.0.2.5', dstPort: 47800, dstPublicIp: '203.0.113.2', dstPublicRealPort: 0, subnetOf: 'lan-a' });
    const second = await gwA.dialOut({ hostName: 'A', hostPort: 47800, dstIp: '10.0.2.5', dstPort: 47800, dstPublicIp: '203.0.113.2', dstPublicRealPort: 0, subnetOf: 'lan-a' });
    assert.equal(first.publicPort, second.publicPort, '同一目标应复用映射');
    assert.equal(gwA.stats.mappingReused, 1);
  });

  it('⑧ 无 NAT（公网主机）可以直接被连上', () => {
    buildHomeTopology();
    internet.defineSubnet('dmz', '198.51.100');
    const gwPub = internet.createGateway({ name: 'gwPub', lanSubnet: 'dmz', mode: NAT_MODE.OPEN, publicIp: '198.51.100.1' });
    internet.registerHost('C', { subnet: 'dmz', ip: '198.51.100.9', realPort: 0, gateway: gwPub });
    const verdict = internet.decide({ fromHost: 'A', dstIp: '198.51.100.9', dstPort: 47800 });
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.reason, 'open-nat');
  });
});

describe('虚拟网络：防火墙', () => {
  it('① 防火墙按端口拦截入站，即使有端口映射也拦', async () => {
    const { gwB } = buildHomeTopology({
      firewallB: { allowInbound: 'mapped-only', blockedPorts: [47800] },
    });
    await gwB.addPortMapping('B', 47800, { publicPort: 47800 });
    const inbound = await gwB.connectInbound(47800, { srcIp: '203.0.113.1', srcPort: 40000 });
    assert.equal(inbound.accepted, false);
    assert.equal(inbound.reason, 'firewall-blocked-port');
  });

  it('② 放行其它端口时正常通过 —— 失败是"按规则"的，不是一刀切', async () => {
    const { gwB } = buildHomeTopology({
      firewallB: { allowInbound: 'mapped-only', blockedPorts: [47800] },
    });
    await gwB.addPortMapping('B', 47801, { publicPort: 47801 });
    const inbound = await gwB.connectInbound(47801, { srcIp: '203.0.113.1', srcPort: 40000 });
    assert.equal(inbound.accepted, true);
  });

  it('③ 没有映射时的拒绝原因可区分（no-mapping vs firewall）', async () => {
    const { gwB } = buildHomeTopology();
    const noMapping = await gwB.connectInbound(47800, { srcIp: '203.0.113.1', srcPort: 40000 });
    assert.equal(noMapping.reason, 'no-mapping');
  });
});

describe('虚拟链路：真实丢包', () => {
  /**
   * 通过一条虚拟链路搬 N 字节，返回耗时、收到的内容与两端链路统计。
   * 所有丢包/乱序测试都走这一个函数，保证比较的是同一件事。
   */
  async function transfer({ link, bytes = 4096, timeoutMs = 15000, chunkSize = 256, rtoMs = 100 } = {}) {
    let received = Buffer.alloc(0);
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });

    const server = createServer((socket) => {
      socket.on('data', (chunk) => {
        received = Buffer.concat([received, chunk]);
        if (received.length >= bytes) resolveDone();
      });
      socket.on('error', () => {});
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    // 固定种子：同样的链路参数必须每次跑出同样的结果。
    // 网络测试如果每次随机，就没法判断"失败是链路造成的还是运气不好"。
    const uplink = new VirtualLink({ link: { seed: 12345, ...link }, rtoMs });
    const downlink = new VirtualLink({ link: { seed: 54321, ...link }, rtoMs });
    const upPort = await uplink.listen(0);
    const downPort = await downlink.listen(0);
    uplink.setPeer(downPort);
    downlink.setPeer(upPort);

    const target = netConnect(server.address().port, '127.0.0.1');
    target.on('error', () => {});
    downlink.on('data', (chunk) => { if (!target.destroyed) target.write(chunk); });
    uplink.on('data', () => {}); // 单向传输，反程不校验

    const payload = Buffer.alloc(bytes);
    for (let i = 0; i < bytes; i += 1) payload[i] = i % 251;

    const startedAt = Date.now();
    // 注意这里的切片长度必须和步长一致。
    // 早先步长改成 256 却漏改切片（仍是 512），于是每段与上一段重叠 ——
    // 接收方拿到的是"重叠拼接"的字节流，连 0% 丢包的基线都对不上。
    for (let offset = 0; offset < payload.length; offset += chunkSize) {
      uplink.write(payload.subarray(offset, offset + chunkSize));
    }

    const timer = setTimeout(() => resolveDone(), timeoutMs);
    await done;
    clearTimeout(timer);
    const elapsed = Date.now() - startedAt;

    const stats = { up: uplink.stats, down: downlink.stats };
    uplink.close(); downlink.close(); target.destroy();
    await new Promise((resolve) => server.close(resolve));

    return { elapsed, received, expected: payload, stats };
  }

  it('① 无丢包：数据完整送达（基线）', async () => {
    const result = await transfer({ link: {} });
    assert.equal(result.received.length, result.expected.length);
    assert.ok(result.received.equals(result.expected), '内容必须逐字节一致');
    console.log(`    4KB 无损链路：${result.elapsed}ms`);
  });

  it('② 丢包 20%：靠重传补齐，数据仍然逐字节一致', async () => {
    const result = await transfer({ link: { lossRate: 0.2, delayMs: 5 } });
    assert.ok(result.received.equals(result.expected), '丢包不能导致内容损坏');
    assert.ok(result.stats.up.droppedByLoss > 0, '应当真的丢了包（否则这个测试没意义）');
    assert.ok(result.stats.up.retransmits > 0, '应当发生了重传');
    console.log(`    丢包 20%：真实丢弃 ${result.stats.up.droppedByLoss} 段，重传 ${result.stats.up.retransmits} 次，`
      + `耗时 ${result.elapsed}ms，内容完全一致`);
  });

  it('③ 丢包 50%：仍然能送达，只是明显变慢（重传代价可见）', async () => {
    // 50% 丢包是很极端的链路（正常网络远达不到），重传次数会成倍上升，
    // 所以给它更宽的窗口；重点看的是"内容一致"和"确实变慢了"这两件事。
    const clean = await transfer({ link: { delayMs: 5 }, timeoutMs: 30000 });
    const lossy = await transfer({ link: { lossRate: 0.5, delayMs: 5 }, timeoutMs: 30000 });
    assert.ok(lossy.received.equals(lossy.expected), '高丢包下内容仍需一致');
    assert.ok(lossy.elapsed > clean.elapsed, `高丢包应更慢：${lossy.elapsed}ms vs ${clean.elapsed}ms`);
    console.log(`    丢包 50%：耗时 ${lossy.elapsed}ms（无损 ${clean.elapsed}ms），`
      + `重传 ${lossy.stats.up.retransmits} 次，内容一致`);
  });

  it('④ 丢包 100%：完全送不到，且不会假装成功', async () => {
    const result = await transfer({ link: { lossRate: 1 }, bytes: 1024, timeoutMs: 2500 });
    assert.equal(result.received.length, 0, '全丢时不应有任何字节被交付');
    assert.ok(result.stats.up.droppedByLoss > 0);
    console.log(`    丢包 100%：${result.elapsed}ms 内零交付，重传 ${result.stats.up.retransmits} 次后仍在等（符合预期）`);
  });

  it('⑤ 黑洞窗口：期间卡住，恢复后自动补齐（这就是"断了一下"的真实表现）', async () => {
    const result = await transfer({ link: { blackholeMs: 1200, delayMs: 5 } });
    assert.ok(result.received.equals(result.expected), '黑洞结束后必须补齐且内容一致');
    assert.ok(result.stats.up.droppedByBlackhole > 0, '应当真的经历了黑洞');
    console.log(`    黑洞 1.2s：丢弃 ${result.stats.up.droppedByBlackhole} 段，重传 ${result.stats.up.retransmits} 次，`
      + `最终 ${result.elapsed}ms 完整送达`);
  });

  it('⑥ 乱序 + 重复投递：接收方按序重组，内容不受影响', async () => {
    const result = await transfer({ link: { reorderRate: 0.4, duplicateRate: 0.3, delayMs: 5 } });
    assert.ok(result.received.equals(result.expected), '乱序与重复都不能破坏内容');
    assert.ok(result.stats.down.reordered > 0, '应当真的发生了乱序');
    console.log(`    乱序 40% + 重复 30%：重组 ${result.stats.down.reordered} 段，`
      + `重复 ${result.stats.down.duplicates} 段，内容逐字节一致`);
  });

  it('⑦ 高延迟 + 抖动：仍然完整，只是慢', async () => {
    const result = await transfer({ link: { delayMs: 30, jitterMs: 60 } });
    assert.ok(result.received.equals(result.expected));
    console.log(`    30ms+60ms 抖动：4KB 用 ${result.elapsed}ms，内容一致`);
  });
});

describe('虚拟网络：端到端（跨 NAT 的真实数据通路）', () => {
  it('端口映射之后，跨 NAT 的字节流可以真实跑通', async () => {
    const { gwB } = buildHomeTopology();
    // 目的主机 B：起一个真实的 TCP 服务
    const echo = createServer((socket) => socket.on('data', (chunk) => socket.write(chunk)));
    await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve));
    extras.push(() => new Promise((resolve) => echo.close(resolve)));
    internet.registerHost('B', { subnet: 'lan-b', ip: '10.0.2.5', realPort: echo.address().port, gateway: gwB });
    await gwB.addPortMapping('B', 47800, { publicPort: 47800 });

    const dial = await internet.dial({ fromHost: 'A', fromHostPort: 47800, dstIp: '10.0.2.5', dstPort: 47800 });
    assert.equal(dial.accepted, true, `应当被放行，实际原因：${dial.reason}`);

    // 通过虚拟路径跑一次真实的往返
    const client = netConnect(dial.localPort, '127.0.0.1');
    extras.push(() => client.destroy());
    const payload = Buffer.from('经过 NAT 与虚拟链路的真实字节流');
    const echoed = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('虚拟路径超时')), 8000);
      client.on('connect', () => client.write(payload));
      client.on('data', (chunk) => { clearTimeout(timer); resolve(chunk); });
      client.on('error', (error) => { clearTimeout(timer); reject(error); });
    });
    assert.ok(echoed.equals(payload), '跨 NAT 的字节流必须原样往返');
    console.log(`    跨 NAT 端到端：${payload.length} 字节原样往返，`
      + `虚拟链路中继 ${internet.stats.bytesRelayed} 字节`);
  });

  it('没有端口映射时，dial 直接拒绝，不会产生半成品连接', async () => {
    buildHomeTopology();
    const dial = await internet.dial({ fromHost: 'A', fromHostPort: 47800, dstIp: '10.0.2.5', dstPort: 47800 });
    assert.equal(dial.accepted, false);
    assert.equal(dial.reason, 'nat-inbound-blocked');
    assert.equal(internet.stats.dialsBlocked, 1);
    assert.equal(internet.stats.dialsSucceeded, 0);
  });

  it('有损链路下的跨 NAT 传输：丢包 25% 仍能完整往返', async () => {
    const { gwB } = buildHomeTopology();
    internet.setLink('lan-a', 'lan-b', { lossRate: 0.25, delayMs: 5 });

    const echo = createServer((socket) => socket.on('data', (chunk) => socket.write(chunk)));
    await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve));
    extras.push(() => new Promise((resolve) => echo.close(resolve)));
    internet.registerHost('B', { subnet: 'lan-b', ip: '10.0.2.5', realPort: echo.address().port, gateway: gwB });
    await gwB.addPortMapping('B', 47800, { publicPort: 47800 });

    const dial = await internet.dial({ fromHost: 'A', fromHostPort: 47800, dstIp: '10.0.2.5', dstPort: 47800 });
    assert.equal(dial.accepted, true);

    const client = netConnect(dial.localPort, '127.0.0.1');
    extras.push(() => client.destroy());
    const payload = Buffer.alloc(3000);
    for (let i = 0; i < payload.length; i += 1) payload[i] = (i * 7) % 256;

    const echoed = await new Promise((resolve, reject) => {
      let received = Buffer.alloc(0);
      const timer = setTimeout(() => reject(new Error(`有损链路超时，收到 ${received.length}/${payload.length}`)), 20000);
      client.on('connect', () => client.write(payload));
      client.on('data', (chunk) => {
        received = Buffer.concat([received, chunk]);
        if (received.length >= payload.length) { clearTimeout(timer); resolve(received); }
      });
      client.on('error', (error) => { clearTimeout(timer); reject(error); });
    });
    assert.ok(echoed.subarray(0, payload.length).equals(payload), '有损链路上内容必须一致');
    console.log(`    丢包 25% 的跨 NAT 往返：${payload.length} 字节完整，中继 ${internet.stats.bytesRelayed} 字节`);
  });
});

describe('虚拟网络：广播域隔离', () => {
  it('不同子网的主机不在同一个广播域里 —— 这解释了为什么"局域网发现"跨不了网络', () => {
    const { gwA } = buildHomeTopology();
    internet.registerHost('A2', { subnet: 'lan-a', ip: '10.0.1.6', realPort: 0, gateway: gwA });
    const sameSubnet = internet.decide({ fromHost: 'A', dstIp: '10.0.1.6', dstPort: 47899 });
    assert.equal(sameSubnet.reason, 'same-subnet', '同子网才是同一广播域');

    // 跨子网的"发现"要先过网关；而 UDP 广播根本不会到达网关的另一侧
    const crossSubnet = internet.decide({ fromHost: 'A', dstIp: '10.0.2.5', dstPort: 47899 });
    assert.equal(crossSubnet.allowed, false);
    console.log('    跨子网的广播发现不可达（网关不会转发广播），'
      + '这正是需要"手工地址 / 邀请码 / 引导节点"的原因');
  });
});
