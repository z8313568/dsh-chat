/**
 * 可达性判定测试。
 *
 * 这一组的重点不是"能不能判断出公网"，而是**判断错了会怎样**：
 * 把不可达的节点判成可达，后果是它对外宣称自己是一台中继，别人把消息发过来却永远失败。
 * 所以这里大量断言的是"不确定时必须说不知道"，而不是"尽量给出一个结论"。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { createIdentity, identityFromRecord } from '../../src/host/identity.js';
import { EnvelopeCodec } from '../../src/host/net/envelope.js';
import { LanTransport } from '../../src/host/net/lan.js';
import { normalizeConfig } from '../../src/host/config.js';
import { RelayTransport } from '../../src/host/relay.js';
import {
  ADDRESS_CLASS, REACHABILITY, ReachabilityMonitor,
  assess, classifyAddress, classifyInterfaces, isProbeableAddress,
} from '../../src/host/reachability.js';

const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await Promise.resolve().then(fn).catch(() => {});
  cleanups.length = 0;
});

/** 造一个假的 networkInterfaces() 返回值。 */
function fakeInterfaces(entries) {
  const out = {};
  for (const [name, address, family = 'IPv4', internal = false] of entries) {
    out[name] = out[name] ?? [];
    out[name].push({ address, family, internal });
  }
  return out;
}

describe('可达性 L1：地址分类', () => {
  it('私网、CGNAT、链路本地、回环都能被识别出来', () => {
    assert.equal(classifyAddress('127.0.0.1'), ADDRESS_CLASS.LOOPBACK);
    assert.equal(classifyAddress('10.1.2.3'), ADDRESS_CLASS.PRIVATE);
    assert.equal(classifyAddress('172.16.0.1'), ADDRESS_CLASS.PRIVATE);
    assert.equal(classifyAddress('172.31.255.255'), ADDRESS_CLASS.PRIVATE);
    assert.equal(classifyAddress('192.168.1.1'), ADDRESS_CLASS.PRIVATE);
    assert.equal(classifyAddress('169.254.1.1'), ADDRESS_CLASS.LINK_LOCAL);
    assert.equal(classifyAddress('::1'), ADDRESS_CLASS.LOOPBACK);
    assert.equal(classifyAddress('fe80::1'), ADDRESS_CLASS.LINK_LOCAL);
    assert.equal(classifyAddress('fd00::1'), ADDRESS_CLASS.PRIVATE);
  });

  it('CGNAT（100.64/10）必须单独识别 —— 它在私网之外还有一层 NAT', () => {
    // 漏掉这一段会得出"有公网地址"的错误结论。
    assert.equal(classifyAddress('100.64.0.5'), ADDRESS_CLASS.CGNAT);
    assert.equal(classifyAddress('100.127.255.254'), ADDRESS_CLASS.CGNAT);
    // 边界外仍是公网
    assert.equal(classifyAddress('100.63.255.255'), ADDRESS_CLASS.PUBLIC);
    assert.equal(classifyAddress('100.128.0.1'), ADDRESS_CLASS.PUBLIC);
  });

  it('172.16/12 的边界要准，不能把 172.32 也算进去', () => {
    assert.equal(classifyAddress('172.15.255.255'), ADDRESS_CLASS.PUBLIC);
    assert.equal(classifyAddress('172.16.0.0'), ADDRESS_CLASS.PRIVATE);
    assert.equal(classifyAddress('172.31.255.255'), ADDRESS_CLASS.PRIVATE);
    assert.equal(classifyAddress('172.32.0.1'), ADDRESS_CLASS.PUBLIC);
  });

  it('保留段与组播永远不可能是公网可连入的', () => {
    for (const address of ['224.0.0.1', '239.255.255.250', '0.0.0.0', '198.18.0.1', '192.0.2.1']) {
      assert.notEqual(classifyAddress(address), ADDRESS_CLASS.PUBLIC, `${address} 不该被判为公网`);
    }
  });

  it('非法输入不抛错，按 unspecified 处理', () => {
    for (const bad of ['', null, undefined, 'not-an-ip', '1.2.3', '999.1.1.1', '1.2.3.4.5']) {
      assert.equal(classifyAddress(bad), ADDRESS_CLASS.UNSPECIFIED, `${String(bad)} 应当按 unspecified 处理`);
    }
  });

  it('带方括号与 zone id 的 IPv6 也能分类', () => {
    assert.equal(classifyAddress('[::1]'), ADDRESS_CLASS.LOOPBACK);
    assert.equal(classifyAddress('fe80::1%en0'), ADDRESS_CLASS.LINK_LOCAL);
    assert.equal(classifyAddress('2409:8a3c::1'), ADDRESS_CLASS.PUBLIC);
  });

  it('本机接口汇总：只有公网 IPv6 时要说清是 v6，不能笼统说"有公网地址"', () => {
    const result = classifyInterfaces(fakeInterfaces([
      ['lo0', '127.0.0.1', 'IPv4', true],
      ['en0', '192.168.1.5', 'IPv4'],
      ['en0', '2409:8a3c::5', 'IPv6'],
    ]));
    assert.equal(result.verdict, 'has-public-address');
    assert.equal(result.hasPublicV4, false);
    assert.equal(result.hasPublicV6, true);
    assert.match(result.reason, /IPv6/);
    assert.match(result.reason, /纯 IPv4/, '必须提示在纯 v4 网络里连不进来');
  });

  it('只有私网地址 → 明确的否定结论', () => {
    const result = classifyInterfaces(fakeInterfaces([
      ['lo0', '127.0.0.1', 'IPv4', true],
      ['en0', '192.168.1.5', 'IPv4'],
    ]));
    assert.equal(result.verdict, 'no-public-address');
    assert.equal(result.hasPublicV4, false);
  });

  it('CGNAT 的说明里要点明"入站必然不通"', () => {
    const result = classifyInterfaces(fakeInterfaces([
      ['en0', '100.64.3.7', 'IPv4'],
    ]));
    assert.equal(result.hasCgnat, true);
    assert.match(result.reason, /CGNAT|运营商级 NAT/);
  });
});

describe('可达性 L2：中继观察', () => {
  const localPublic = () => classifyInterfaces(fakeInterfaces([
    ['en0', '203.0.113.5', 'IPv4'],
  ]));

  it('没有观察数据时说不知道，而不是猜', () => {
    const verdict = assess({ local: localPublic(), observations: [] });
    // 有公网地址但没有任何观察 → unknown（仍需实证）
    assert.equal(verdict.state, REACHABILITY.UNKNOWN);
  });

  it('中继看到的地址就在本机网卡上 → 说明没有经过 NAT', () => {
    const verdict = assess({
      local: localPublic(),
      observations: [{ observer: 'relay1', host: '203.0.113.5', port: 40001 }],
    });
    assert.equal(verdict.state, REACHABILITY.LIKELY);
    assert.equal(verdict.evidence.observedIsLocal, true);
    // 关键：LIKELY 不是"可达"。公网 IP 仍可能被运营商封入站。
    assert.match(verdict.reason, /入站|仍需/);
  });

  it('中继看到的地址不在本机网卡上 → 在 NAT 后面', () => {
    const verdict = assess({
      local: localPublic(),
      observations: [{ observer: 'relay1', host: '198.51.100.7', port: 40001 }],
    });
    assert.equal(verdict.state, REACHABILITY.BEHIND_NAT);
    assert.equal(verdict.evidence.observedIsLocal, false);
    assert.match(verdict.reason, /端口映射|NAT/);
  });

  it('观察到的也是私网地址 → 和中继在同一内网', () => {
    const verdict = assess({
      local: classifyInterfaces(fakeInterfaces([['en0', '192.168.1.5', 'IPv4']])),
      observations: [{ observer: 'relay1', host: '192.168.1.9', port: 40001 }],
    });
    assert.equal(verdict.state, REACHABILITY.PRIVATE_ONLY);
  });

  it('观察数据里不保留对端看到的地址细节（元数据最小化）', () => {
    const verdict = assess({
      local: localPublic(),
      observations: [{ observer: 'relay1', host: '198.51.100.7', port: 40001 }],
    });
    assert.equal(JSON.stringify(verdict.evidence).includes('198.51.100.7'), false);
  });
});

describe('可达性 L3：入站实证', () => {
  it('有过入站握手 → PROVEN，且压过一切推断', () => {
    const monitor = new ReachabilityMonitor();
    monitor.noteInbound({ address: '203.0.113.9:5000', at: Date.now() });
    const local = classifyInterfaces(fakeInterfaces([['en0', '192.168.1.5', 'IPv4']]));
    const report = monitor.report({ interfaces: fakeInterfaces([['en0', '192.168.1.5', 'IPv4']]) });
    // L1 说"没有公网地址"，但真的有人连进来过 —— 实证优先
    assert.equal(local.verdict, 'no-public-address');
    assert.equal(report.state, REACHABILITY.PROVEN);
    assert.equal(report.inbound.count, 1);
  });

  it('没有实证时不冒充可达', () => {
    const monitor = new ReachabilityMonitor();
    const report = monitor.report({
      interfaces: fakeInterfaces([['en0', '203.0.113.5', 'IPv4']]),
    });
    assert.notEqual(report.state, REACHABILITY.PROVEN);
  });
});

describe('可达性：什么时候建议开启中继服务', () => {
  it('只有实证过才建议 —— 仅凭"看起来在公网上"会对外宣称一台连不上的中继', () => {
    const monitor = new ReachabilityMonitor();
    const interfaces = fakeInterfaces([['en0', '203.0.113.5', 'IPv4']]);

    // L2 说"看起来直接挂在公网上"，但没人连进来过
    monitor.noteObservation('relay1', '203.0.113.5', 40001);
    const before = monitor.shouldSuggestServing({ interfaces });
    assert.equal(before.suggest, false);
    assert.equal(before.reason, 'needs-inbound-proof');
    assert.match(before.note, /连不上的中继/);

    // 一旦有真实入站，才建议
    monitor.noteInbound({ at: Date.now() });
    const after = monitor.shouldSuggestServing({ interfaces });
    assert.equal(after.suggest, true);
    assert.equal(after.reason, 'proven-reachable');
  });

  it('已经在提供服务时不再重复建议', () => {
    const monitor = new ReachabilityMonitor();
    monitor.noteInbound({ at: Date.now() });
    assert.equal(monitor.shouldSuggestServing({ alreadyServing: true }).suggest, false);
  });

  it('在 NAT 后面时不建议（除非有实证）', () => {
    const monitor = new ReachabilityMonitor();
    monitor.noteObservation('relay1', '198.51.100.7', 40001);
    const suggestion = monitor.shouldSuggestServing({
      interfaces: fakeInterfaces([['en0', '203.0.113.5', 'IPv4']]),
    });
    assert.equal(suggestion.suggest, false);
  });
});

describe('可达性：入站实证的安全闸门', () => {
  it('只允许探测全球可路由地址 —— 否则它就是一个端口扫描器', () => {
    // 这是必须有的限制：请求方可以指定任意地址让中继去连，
    // 不设限就等于把中继当成跳板来扫内网。
    assert.equal(isProbeableAddress('203.0.113.5:47800'), true);
    assert.equal(isProbeableAddress('8.8.8.8:53'), true);

    assert.equal(isProbeableAddress('127.0.0.1:47800'), false, '回环');
    assert.equal(isProbeableAddress('10.0.0.5:47800'), false, '私网');
    assert.equal(isProbeableAddress('192.168.1.1:80'), false, '私网');
    assert.equal(isProbeableAddress('172.16.0.1:80'), false, '私网');
    assert.equal(isProbeableAddress('169.254.169.254:80'), false, '云元数据地址（SSRF 的经典目标）');
    assert.equal(isProbeableAddress('100.64.0.1:80'), false, 'CGNAT');
    assert.equal(isProbeableAddress('fd00::1'), false, 'IPv6 ULA');
    assert.equal(isProbeableAddress('::1'), false, 'IPv6 回环');
  });

  it('中继侧：拒绝探测非公网地址，并如实回原因', async () => {
    const relay = await makeNode({ nickname: '中继', asRelay: true });
    const node = await makeNode({ nickname: '节点' });
    await node.transport.addRelay(relay.transport.address);

    const results = [];
    node.transport.on('reach-probe', (payload) => results.push(payload));

    // 直接请求探测一个内网地址
    const probe = await node.transport.proveReachable('192.168.1.1:80');
    assert.equal(probe.ok, false);
    // 本机地址不是公网 → 连请求都不会发出去
    assert.equal(probe.reason, 'local-address-not-public');

    // 伪造一次：绕过客户端的本地检查，直接让中继去探测内网地址
    const { MESSAGE_KIND } = await import('../../src/shared/protocol.js');
    const answered = [];
    node.transport.on('reach-probe', (payload) => answered.push(payload));
    node.transport.relayClient.sendControl(MESSAGE_KIND.REACH_PROBE, { address: '169.254.169.254:80' });
    await new Promise((resolve) => setTimeout(resolve, 400));

    const metrics = relay.transport.relayServer.metrics;
    assert.ok(metrics.probesRefused >= 1, '中继必须拒绝这次探测');
    console.log(`    中继拒绝了指向内网/元数据地址的实证请求（累计拒绝 ${metrics.probesRefused} 次）`);
  });

  it('中继侧：对公网地址的实证会真的去连，并如实回报失败', async () => {
    const relay = await makeNode({ nickname: '中继', asRelay: true });
    const node = await makeNode({ nickname: '节点' });
    await node.transport.addRelay(relay.transport.address);

    // 203.0.113.0/24 是文档用地址，真实网络里不可达 → 应当如实回报连不上
    const probe = await node.transport.proveReachable('203.0.113.99:47800', { timeoutMs: 3000 });
    assert.equal(probe.ok, false);
    assert.match(probe.reason, /unreachable|probe-timeout/);

    const metrics = relay.transport.relayServer.metrics;
    assert.equal(metrics.probesServed >= 1, true, '中继应当真的尝试过');
    console.log(`    中继真的去连了一次公网地址并如实回报失败：${probe.reason}`);
  });

  it('实证的判据是"握手完成且身份匹配"，不是裸 TCP 连通', async () => {
    /**
     * 走完整链路时，本机地址不是公网地址，会被安全闸门挡在
     * `refused-non-public-target` —— 于是"身份对不上要判失败"这条判据
     * 在单机上永远测不到。所以直接调中继的 probeInbound：
     * **闸门归闸门，判据归判据**，分开测。
     */
    const relay = await makeNode({ nickname: '中继', asRelay: true });
    const node = await makeNode({ nickname: '目标节点' });
    const stranger = await makeNode({ nickname: '无关节点' });
    const server = relay.transport.relayServer;

    // ① 目标就是声称的那一方 → 成功
    const success = await server.probeInbound(node.transport.address, node.identity.publicKeyId);
    assert.equal(success.ok, true);
    assert.equal(success.reason, 'inbound-verified');
    assert.equal(success.responder, node.identity.publicKeyId);

    // ② 端口通，但应答的是别人 → 必须判失败
    //    这是关键：只看"TCP 连上了"会把任意一个开着的端口当成可达证据。
    const mismatch = await server.probeInbound(
      stranger.transport.address, node.identity.publicKeyId,
    );
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.reason, 'identity-mismatch');
    assert.equal(mismatch.responder, stranger.identity.publicKeyId, '如实回报实际应答者是谁');

    // ③ 根本连不上 → 失败并带上原因
    const dead = await server.probeInbound('127.0.0.1:1', node.identity.publicKeyId);
    assert.equal(dead.ok, false);
    assert.match(dead.reason, /unreachable/);

    console.log('    实证判据：身份匹配 → 成功；端口通但身份不符 → 失败；连不上 → 失败并带原因');
  });

  it('本机地址不是公网时，客户端连请求都不发（省掉一次无意义的往返）', async () => {
    const relay = await makeNode({ nickname: '中继', asRelay: true });
    const node = await makeNode({ nickname: '节点' });
    await node.transport.addRelay(relay.transport.address);

    const before = relay.transport.relayServer.metrics.probesServed;
    const probe = await node.transport.proveReachable(node.transport.address);
    assert.equal(probe.ok, false);
    assert.equal(probe.reason, 'local-address-not-public');
    assert.equal(
      relay.transport.relayServer.metrics.probesServed, before,
      '不该真的发出请求 —— 回环地址不可能被外网连入，白问一次没有意义',
    );
  });
});

// ---------------------------------------------------------------------------

async function makeNode({ nickname, asRelay = false }) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-chat-reach-'));
  const identity = identityFromRecord(createIdentity());
  const config = normalizeConfig({
    dataDir: dir, listen: { host: '127.0.0.1', port: 0 }, discovery: { enabled: false },
    network: { connectTimeoutMs: 3000, handshakeTimeoutMs: 4000 },
  });
  const codec = new EnvelopeCodec({ identity });
  const inner = new LanTransport({ config, identity, codec, nodeInfo: () => ({ nickname }) });
  const transport = new RelayTransport({ inner, identity, enableRelayServer: asRelay })
    .useCodecSeal((kind, payload, to) => codec.seal(kind, payload, { to }));
  await transport.start();
  cleanups.push(async () => { await transport.stop(); rmSync(dir, { recursive: true, force: true }); });
  return { identity, codec, transport };
}
