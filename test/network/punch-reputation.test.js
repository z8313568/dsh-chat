/**
 * 打洞 / 中继选择 / 信誉 的测试。
 *
 * 三块都遵循同一个原则：**失败路径和成功路径一样重要**。
 * 打洞打不通是常态（对称 NAT 下必然打不通），所以"打不通时行为是否正确"
 * 比"能打通"更值得断言。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { createIdentity, identityFromRecord, verifyWithPublicKeyId } from '../../src/host/identity.js';
import { EnvelopeCodec } from '../../src/host/net/envelope.js';
import { LanTransport } from '../../src/host/net/lan.js';
import { normalizeConfig } from '../../src/host/config.js';
import { NAT_TYPE, inferNatType, shouldAttemptPunch } from '../../src/host/punch.js';
import { RelayTransport } from '../../src/host/relay.js';
import {
  AttestationBook, OBSERVATION, RelaySelector, ReputationLedger, backoffMs, describeLedger,
} from '../../src/host/reputation.js';
import { NAT_MODE, VirtualInternet } from './virtual-internet.js';

const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await Promise.resolve().then(fn).catch(() => {});
  cleanups.length = 0;
});

// ---------------------------------------------------------------------------
// NAT 类型推断
// ---------------------------------------------------------------------------

describe('打洞：NAT 类型推断', () => {
  it('只有一个观察点时必须报 unknown，而不是猜', () => {
    // 这是很多打洞实现自欺欺人的地方：把"不知道"当成"可以打"，
    // 然后每一次连接都白试一轮打洞。
    const verdict = inferNatType([{ observer: 'relay1', host: '203.0.113.1', port: 40001 }]);
    assert.equal(verdict.type, NAT_TYPE.UNKNOWN);
    assert.equal(verdict.reason, 'only-one-observer');
  });

  it('没有观察点时报 unknown', () => {
    assert.equal(inferNatType([]).type, NAT_TYPE.UNKNOWN);
    assert.equal(inferNatType(null).type, NAT_TYPE.UNKNOWN);
  });

  it('两个观察点看到同一个公网端口 → 全锥形', () => {
    const verdict = inferNatType([
      { observer: 'relay1', host: '203.0.113.1', port: 40001 },
      { observer: 'relay2', host: '203.0.113.2', port: 40001 },
    ]);
    assert.equal(verdict.type, NAT_TYPE.CONE);
  });

  it('不同目的地换了公网端口 → 对称型（打洞必然失败）', () => {
    const verdict = inferNatType([
      { observer: 'relay1', host: '203.0.113.1', port: 40001 },
      { observer: 'relay2', host: '203.0.113.2', port: 40007 },
    ]);
    assert.equal(verdict.type, NAT_TYPE.SYMMETRIC);
    assert.equal(verdict.reason, 'mapping-differs-per-destination');
  });

  it('回环地址上如实报 open，而不是报 cone', () => {
    // 本机没有 NAT。如果报成 cone，本机测试就会得出"打洞一定可行"的假结论。
    const verdict = inferNatType([
      { observer: 'relay1', host: '127.0.0.1', port: 40001 },
      { observer: 'relay2', host: '127.0.0.1', port: 40001 },
    ]);
    assert.equal(verdict.type, NAT_TYPE.OPEN);
    assert.equal(verdict.reason, 'loopback-no-nat');
  });

  it('对称 NAT 直接跳过打洞，不浪费那几百毫秒', () => {
    assert.equal(shouldAttemptPunch(NAT_TYPE.SYMMETRIC).attempt, false);
    assert.equal(shouldAttemptPunch(NAT_TYPE.UNKNOWN).attempt, true, '不知道就值得一试');
    assert.equal(shouldAttemptPunch(NAT_TYPE.CONE).attempt, true);
    assert.equal(shouldAttemptPunch(NAT_TYPE.OPEN).attempt, true);
  });
});

// ---------------------------------------------------------------------------
// 虚拟网络里的打洞
// ---------------------------------------------------------------------------

describe('打洞：虚拟网络中的成败', () => {
  /** 造一个两子网拓扑并跑一次完整打洞。 */
  async function punchBetween(modeA, modeB) {
    const net = new VirtualInternet();
    cleanups.push(() => net.close());
    net.defineSubnet('lan-a', '10.0.1');
    net.defineSubnet('lan-b', '10.0.2');
    net.defineSubnet('wan', '203.0.113');
    const gwA = net.createGateway({ name: 'gwA', lanSubnet: 'lan-a', mode: modeA, publicIp: '203.0.113.1' });
    const gwB = net.createGateway({ name: 'gwB', lanSubnet: 'lan-b', mode: modeB, publicIp: '203.0.113.2' });
    net.registerHost('A', { subnet: 'lan-a', ip: '10.0.1.5', realPort: 47800, gateway: gwA });
    net.registerHost('B', { subnet: 'lan-b', ip: '10.0.2.5', realPort: 47800, gateway: gwB });
    return net.attemptHolePunch({ a: 'A', b: 'B' });
  }

  it('全锥形 + 全锥形 → 打通', async () => {
    const result = await punchBetween(NAT_MODE.CONE, NAT_MODE.CONE);
    assert.equal(result.ok, true);
    assert.equal(result.reason, 'punched');
    console.log(`    全锥形 + 全锥形 → 打通（${result.inboundA}）`);
  });

  it('受限锥形 + 受限锥形 → 打通（双方都会先向对方发包，这正是打洞的前提）', async () => {
    const result = await punchBetween(NAT_MODE.RESTRICTED, NAT_MODE.RESTRICTED);
    assert.equal(result.ok, true);
    assert.equal(result.inboundA, 'restricted-cone-punched');
    console.log('    受限锥形 + 受限锥形 → 打通（先发出的那一包把对方"记"进了 NAT）');
  });

  it('一侧对称 → 打不通，且明确标出需要中继', async () => {
    const result = await punchBetween(NAT_MODE.CONE, NAT_MODE.SYMMETRIC);
    assert.equal(result.ok, false);
    assert.equal(result.needsRelay, true);
    assert.equal(result.reason, 'symmetric-nat-mismatch');
    console.log(`    全锥形 + 对称 → 打不通（${result.reason}）→ 必须走中继`);
  });

  it('双侧对称 → 打不通', async () => {
    const result = await punchBetween(NAT_MODE.SYMMETRIC, NAT_MODE.SYMMETRIC);
    assert.equal(result.ok, false);
    assert.equal(result.needsRelay, true);
  });

  it('两侧都是公网主机 → 根本不需要打洞', async () => {
    const result = await punchBetween(NAT_MODE.OPEN, NAT_MODE.OPEN);
    assert.equal(result.ok, true);
    console.log(`    双方都是公网主机 → ${result.inboundA}（直接可达，打洞无意义）`);
  });

  it('打洞失败**不是异常**：它只是一条"此路不通"的正常结论', async () => {
    // 把它当异常处理会导致"打洞失败"和"程序出错"混在一起，用户看到的是崩溃而不是降级。
    const result = await punchBetween(NAT_MODE.SYMMETRIC, NAT_MODE.CONE);
    assert.equal(typeof result.ok, 'boolean');
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.needsRelay !== undefined);
  });
});

// ---------------------------------------------------------------------------
// 打洞协调器（真实进程内，走中继信令）
// ---------------------------------------------------------------------------

describe('打洞：协调器（经中继交换候选）', () => {
  async function makeNode({ nickname, asRelay = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-chat-punch-'));
    const identity = identityFromRecord(createIdentity());
    const config = normalizeConfig({
      dataDir: dir, listen: { host: '127.0.0.1', port: 0 }, discovery: { enabled: false },
      network: { connectTimeoutMs: 3000, handshakeTimeoutMs: 4000 },
    });
    const codec = new EnvelopeCodec({ identity });
    const transport = new RelayTransport({
      inner: new LanTransport({ config, identity, codec, nodeInfo: () => ({ nickname }) }),
      identity,
      enableRelayServer: asRelay,
    }).useCodecSeal((kind, payload, to) => codec.seal(kind, payload, { to }));
    await transport.start();
    cleanups.push(async () => { await transport.stop(); rmSync(dir, { recursive: true, force: true }); });
    return { identity, codec, transport };
  }

  const waitFor = async (predicate, label, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = predicate();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`等待「${label}」超时`);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  };

  it('STUN 式探测：中继如实回答"我看到的你的来源地址"', async () => {
    const relay = await makeNode({ nickname: '中继', asRelay: true });
    const peer = await makeNode({ nickname: 'A' });
    await peer.transport.addRelay(relay.transport.address);

    const endpoints = [];
    peer.transport.on('punch-endpoint', (payload) => endpoints.push(payload));
    peer.transport.punch.probe();

    const observed = await waitFor(() => endpoints[0] ?? null, '收到端点');
    assert.ok(observed.observed, '中继应当回报一个观察到的端点');
    // 本机回环环境：中继看到的应当是 127.0.0.1:某端口
    assert.match(observed.observed, /^127\.0\.0\.1:\d+$/);
    // 本机回环：观察到的就是 127.0.0.1，说明根本没有 NAT。
    // 注意这**不需要第二个观察点** —— "看到的是回环地址"本身就足够下结论。
    assert.equal(observed.natType.type, NAT_TYPE.OPEN, '回环上没有 NAT，应报 open');
    console.log(`    中继观察到本机端点 ${observed.observed}；NAT 类型推断为 ${observed.natType.type}（回环无 NAT）`);
  });

  it('两个对端经中继交换候选后打通，并切换到直连', async () => {
    const relay = await makeNode({ nickname: '中继', asRelay: true });
    const alice = await makeNode({ nickname: 'A' });
    const bob = await makeNode({ nickname: 'B' });
    await alice.transport.addRelay(relay.transport.address);
    await bob.transport.addRelay(relay.transport.address);
    await waitFor(() => relay.transport.relayServer.registry.size === 2, '双方在中继上挂号');

    // 双方各自动手：真实产品里由 ensureReachable 触发，这里显式调用以便断言
    const [fromA, fromB] = await Promise.all([
      alice.transport.punchWith(bob.identity.publicKeyId),
      bob.transport.punchWith(alice.identity.publicKeyId),
    ]);

    // 本机回环没有 NAT，所以候选就是彼此的监听地址，一定打得通。
    // 这里要证明的是**协调流程**正确：探测 → 交换候选 → 同时拨号 → 建立直连。
    assert.equal(fromA.ok, true, `A 侧打洞应当成功，原因：${fromA.reason}`);
    assert.equal(fromB.ok, true, `B 侧打洞应当成功，原因：${fromB.reason}`);
    assert.equal(typeof fromA.address, 'string');

    // 打通之后 peers 里应当是直连（而非经中继）
    const direct = alice.transport.directTransport.peers().map((peer) => peer.peerKey);
    assert.ok(direct.includes(bob.identity.publicKeyId), '打通后应当是直连关系');
    console.log(`    打洞协调成功：A 用 ${fromA.elapsedMs}ms、B 用 ${fromB.elapsedMs}ms，`
      + `候选地址 ${fromA.address}；关系已切换为直连`);
  });

  it('没有中继时不做打洞，且如实说明原因（信令必须有一条双方都能到达的通道）', async () => {
    const alice = await makeNode({ nickname: 'A' });
    const result = await alice.transport.punchWith('ed25519:' + 'X'.repeat(43));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-relay-for-signaling');
    console.log('    没有中继 → 打洞直接被跳过并说明原因，而不是干等到超时');
  });

  it('对方完全不在线时打洞干净失败，不影响中继可用性', async () => {
    const relay = await makeNode({ nickname: '中继', asRelay: true });
    const alice = await makeNode({ nickname: 'A' });
    await alice.transport.addRelay(relay.transport.address);
    await waitFor(() => alice.transport.relayClient.relays()[0]?.registered === true, '挂号完成');

    const stranger = identityFromRecord(createIdentity()).publicKeyId;
    const result = await alice.transport.punchWith(stranger, { timeoutMs: 800 });
    assert.equal(result.ok, false);
    assert.match(result.reason, /timeout|failed/);
    // 关键：中继仍然可用
    assert.equal(alice.transport.relayClient.hasRelay(), true);
    console.log(`    对方不在线 → 打洞 ${result.elapsedMs}ms 后失败（${result.reason}），中继连接不受影响`);
  });

  it('ensureReachable 给出完整的三级决策：直连 → 打洞 → 中继', async () => {
    const relay = await makeNode({ nickname: '中继', asRelay: true });
    const alice = await makeNode({ nickname: 'A' });
    const bob = await makeNode({ nickname: 'B' });
    await alice.transport.addRelay(relay.transport.address);
    await bob.transport.addRelay(relay.transport.address);
    await waitFor(() => relay.transport.relayServer.registry.size === 2, '双方挂号');

    const route = await alice.transport.ensureReachable(bob.identity.publicKeyId);
    assert.equal(route.route, 'direct', '回环环境下应当打通走直连');
    assert.equal(route.reason, 'punched');

    // 对一个完全不可达的身份：应当回落到中继
    const stranger = identityFromRecord(createIdentity()).publicKeyId;
    const fallback = await alice.transport.ensureReachable(stranger);
    assert.equal(fallback.route, 'relay');
    console.log(`    可达性决策：能打通的走直连（${route.reason}）；打不通的回落中继（${fallback.reason}）`);
  });
});

// ---------------------------------------------------------------------------
// 中继选择
// ---------------------------------------------------------------------------

describe('中继选择', () => {
  const relay = (peerKey, extra = {}) => ({
    peerKey, registered: true, source: 'discovered', load: null, ...extra,
  });

  it('用户手动指定的中继永远优先 —— 信任是用户给的，不该被算法盖过', () => {
    const ledger = new ReputationLedger();
    const selector = new RelaySelector({ ledger });
    const manual = relay('manual-relay', { source: 'manual' });
    const discovered = relay('auto-relay');
    const best = selector.best([discovered, manual]);
    assert.equal(best.relay.peerKey, 'manual-relay');
  });

  it('未登记的中继被大幅降权', () => {
    const ledger = new ReputationLedger();
    const selector = new RelaySelector({ ledger });
    const ranked = selector.rank([relay('down', { registered: false }), relay('up')]);
    assert.equal(ranked[0].relay.peerKey, 'up');
    assert.ok(ranked[1].score < ranked[0].score - 50);
  });

  it('实测成功率高的中继排在前面', () => {
    const ledger = new ReputationLedger();
    const selector = new RelaySelector({ ledger });
    for (let i = 0; i < 10; i += 1) ledger.record('good', OBSERVATION.FORWARD_OK);
    for (let i = 0; i < 10; i += 1) ledger.record('bad', OBSERVATION.DISCONNECTED);
    const ranked = selector.rank([relay('bad'), relay('good')]);
    assert.equal(ranked[0].relay.peerKey, 'good');
  });

  it('样本很少时不轻易封神（拉普拉斯平滑）', () => {
    const ledger = new ReputationLedger();
    const selector = new RelaySelector({ ledger });
    ledger.record('once', OBSERVATION.FORWARD_OK);
    const fresh = selector.score(relay('fresh'));
    const once = selector.score(relay('once'));
    // 成功一次只应带来很小的优势，远小于"手动指定"的权重
    assert.ok(once.score - fresh.score < 30, `一次成功不该带来巨大优势，实际差 ${once.score - fresh.score}`);
  });

  it('负载高的中继被降权', () => {
    const ledger = new ReputationLedger();
    const selector = new RelaySelector({ ledger });
    const busy = relay('busy', { load: { saturation: 0.95, peers: 30, capacity: 32 } });
    const idle = relay('idle', { load: { saturation: 0.05, peers: 2, capacity: 32 } });
    assert.equal(selector.best([busy, idle]).relay.peerKey, 'idle');
  });

  it('目标亲和性：上次成功过的那台优先', () => {
    const ledger = new ReputationLedger();
    const selector = new RelaySelector({ ledger });
    selector.noteSuccess('relay-b', 'target-x');
    const ranked = selector.rank([relay('relay-a'), relay('relay-b')], 'target-x');
    assert.equal(ranked[0].relay.peerKey, 'relay-b');
  });

  it('被拉黑的中继不会进入候选', () => {
    const ledger = new ReputationLedger();
    const selector = new RelaySelector({ ledger });
    ledger.setBlocked('bad-actor', true);
    assert.equal(selector.best([relay('bad-actor')]), null);
  });
});

// ---------------------------------------------------------------------------
// 信誉
// ---------------------------------------------------------------------------

describe('中继信誉', () => {
  it('拒绝转发密文 = 最严重的违规之一（用户会以为消息发出去了）', () => {
    const ledger = new ReputationLedger();
    ledger.record('r', OBSERVATION.REFUSED_SEALED);
    assert.equal(ledger.isBlacklisted('r'), true, '拒绝转发密文应当立即拉黑');
    assert.equal(ledger.get('r').consecutiveFailures, 99);
  });

  it('伪造身份文档 = 试图做中间人，立即拉黑', () => {
    const ledger = new ReputationLedger();
    ledger.record('r', OBSERVATION.FORGED_DOCUMENT);
    assert.equal(ledger.isBlacklisted('r'), true);
  });

  it('目标不可达只是轻微负面（那是网络现实，不是中继的错）', () => {
    const ledger = new ReputationLedger();
    for (let i = 0; i < 20; i += 1) ledger.record('r', OBSERVATION.UNREACHABLE);
    assert.equal(ledger.isBlacklisted('r'), false, '目标不在线不该让中继被拉黑');
    assert.ok(ledger.get('r').score > -10);
  });

  it('连续 5 次失败后拉黑；一次成功即恢复', () => {
    const ledger = new ReputationLedger();
    for (let i = 0; i < 5; i += 1) ledger.record('r', OBSERVATION.DISCONNECTED);
    assert.equal(ledger.isBlacklisted('r'), true);
    ledger.record('r', OBSERVATION.FORWARD_OK);
    assert.equal(ledger.isBlacklisted('r'), false, '恢复正常后应当重新可用');
  });

  it('用户手动拉黑与恢复', () => {
    const ledger = new ReputationLedger();
    ledger.setBlocked('r', true);
    assert.equal(ledger.isBlocked('r'), true);
    ledger.setBlocked('r', false);
    assert.equal(ledger.isBlocked('r'), false);
  });

  it('贡献账本：如实记录"转发出去"与"消耗掉"的字节', () => {
    const ledger = new ReputationLedger();
    ledger.noteContribution('served', 10_000);
    ledger.noteContribution('consumed', 2_500);
    const c = ledger.contribution();
    assert.equal(c.servedBytes, 10_000);
    assert.equal(c.consumedBytes, 2_500);
    assert.equal(c.balance, 7_500);
    assert.equal(c.servedRatio, 0.8);
    console.log(`    贡献账本：转发出去 ${c.servedBytes}、消耗 ${c.consumedBytes}、净额 ${c.balance}`);
  });

  it('他人证明的权重被刻意压低，且样本不足时标记为不可信', () => {
    const book = new AttestationBook();
    for (let i = 0; i < 3; i += 1) {
      book.accept({ relayPeerKey: 'r', attesterKey: `attester-${i}`, positive: true });
    }
    const summary = book.summary('r');
    assert.equal(summary.samples, 3);
    assert.equal(summary.ratio, 1);
    assert.equal(summary.trustworthy, false, '3 条好评说明不了任何事');

    for (let i = 3; i < 10; i += 1) {
      book.accept({ relayPeerKey: 'r', attesterKey: `attester-${i}`, positive: i % 2 === 0 });
    }
    assert.equal(book.summary('r').trustworthy, true, '样本足够才可信');
  });

  it('同一评价者的重复提交被去重（防刷）', () => {
    const book = new AttestationBook();
    book.accept({ relayPeerKey: 'r', attesterKey: 'same', positive: true });
    book.accept({ relayPeerKey: 'r', attesterKey: 'same', positive: true });
    book.accept({ relayPeerKey: 'r', attesterKey: 'same', positive: true });
    assert.equal(book.summary('r').samples, 1);
  });

  it('评价者数量有上限（防女巫批量灌入）', () => {
    const book = new AttestationBook({ limitPerRelay: 5 });
    for (let i = 0; i < 20; i += 1) {
      book.accept({ relayPeerKey: 'r', attesterKey: `sybil-${i}`, positive: true });
    }
    assert.equal(book.summary('r').samples, 5);
  });

  it('本机生成的证明是可被他人验证的签名对象', () => {
    const identity = identityFromRecord(createIdentity());
    const attestation = AttestationBook.build(identity, { relayPeerKey: 'r', positive: true });
    const { sig, ...body } = attestation;
    assert.ok(verifyWithPublicKeyId(identity.publicKeyId, body, sig));
    assert.equal(attestation.attesterKey, identity.publicKeyId);
  });

  it('退避是指数增长的，且封顶', () => {
    assert.equal(backoffMs(0, { baseMs: 1000 }), 1000);
    assert.equal(backoffMs(1, { baseMs: 1000 }), 2000);
    assert.equal(backoffMs(3, { baseMs: 1000 }), 8000);
    assert.equal(backoffMs(20, { baseMs: 1000, maxMs: 60_000 }), 60_000);
  });

  it('账本能渲染成可读的排序列表', () => {
    const ledger = new ReputationLedger();
    for (let i = 0; i < 5; i += 1) ledger.record('good', OBSERVATION.FORWARD_OK);
    ledger.record('bad', OBSERVATION.DISCONNECTED);
    const rows = describeLedger(ledger);
    assert.equal(rows[0].peerKey, 'good');
    assert.ok(rows[0].score > rows[1].score);
  });
});
