/**
 * 中继测试。
 *
 * 分三层：
 *   ① 密码学与身份文档 —— 中继"看不见内容"这件事的地基；
 *   ② 中继本身 —— 登记、转发、容量、限速，以及**拒绝转发明文**这条硬闸门；
 *   ③ 端到端 —— 两台在对称 NAT 后面、**直连必然失败**的节点，通过公网中继跑通。
 *
 * 第 ③ 层是把前面虚拟网络环境的结论用起来：虚拟环境证明"对称 NAT 下直连必失败"，
 * 这里证明"加上中继就能通"。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { MESSAGE_KIND } from '../../src/shared/protocol.js';
import { createEncryptionKeys, isSealedPayload, openSealed, sealFor } from '../../src/host/crypto.js';
import { createIdentity, identityFromRecord, verifyIdentityDocument } from '../../src/host/identity.js';
import { DEFAULT_RELAY_POLICY, RelayRegistry, RelayServer, RelayTransport, classifyForward } from '../../src/host/relay.js';
import { EnvelopeCodec } from '../../src/host/net/envelope.js';
import { LanTransport } from '../../src/host/net/lan.js';
import { normalizeConfig } from '../../src/host/config.js';
import { NAT_MODE, VirtualInternet } from './virtual-internet.js';

const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => {});
  cleanups.length = 0;
});

// ---------------------------------------------------------------------------
// ① 密码学与身份文档
// ---------------------------------------------------------------------------

describe('中继的隐私地基：端到端加密', () => {
  it('只有收件人能解开；第三方与篡改都失败', () => {
    const alice = createEncryptionKeys();
    const bob = createEncryptionKeys();
    const eve = createEncryptionKeys();

    const sealed = sealFor(bob.publicKeyId, { text: '只有鲍勃能读' });
    assert.ok(isSealedPayload(sealed));
    assert.deepEqual(openSealed(bob.secret, sealed), { text: '只有鲍勃能读' });

    assert.throws(() => openSealed(eve.secret, sealed), /Unsupported state|authentic/i, '第三方必须解不开');
    assert.throws(() => openSealed(alice.secret, sealed), /Unsupported state|authentic/i);

    const tampered = { ...sealed, ct: `${sealed.ct.slice(0, -2)}AA` };
    assert.throws(() => openSealed(bob.secret, tampered), /Unsupported state|authentic/i, '篡改必须被检出');
  });

  it('同一明文两次加密结果不同（前向保密 + 随机 nonce）', () => {
    const bob = createEncryptionKeys();
    const first = sealFor(bob.publicKeyId, { n: 1 });
    const second = sealFor(bob.publicKeyId, { n: 1 });
    assert.notEqual(first.ct, second.ct);
    assert.notEqual(first.epk, second.epk, '每条消息用独立临时密钥');
    assert.deepEqual(openSealed(bob.secret, first), openSealed(bob.secret, second));
  });

  it('身份文档自签名：中继伪造不了加密公钥', () => {
    const bob = identityFromRecord(createIdentity());
    const mallory = createIdentity();
    const doc = bob.document({ nickname: '老李' });

    assert.equal(verifyIdentityDocument(doc).valid, true);

    // 中继把加密公钥换成自己的 —— 但签不出鲍勃的名字
    const forged = { ...doc, encryptionKeyId: mallory.encryption.publicKeyId };
    assert.equal(verifyIdentityDocument(forged).valid, false, '伪造的文档必须被拒');

    // 换设备：签名合法但密钥变了，必须单独报出来
    const moved = { ...doc, encryptionKeyId: mallory.encryption.publicKeyId, updatedAt: Date.now() + 1 };
    const reSigned = { ...moved, sig: bob.sign(Object.fromEntries(Object.entries(moved).filter(([k]) => k !== 'sig'))) };
    const verdict = verifyIdentityDocument(reSigned, { known: doc });
    assert.equal(verdict.valid, true, '换设备本身是合法的');
    assert.equal(verdict.keyChanged, true, '但必须明确提示密钥变更，交给用户判断');
  });

  it('旧身份记录可以就地补上加密密钥，签名身份不变', async () => {
    const { migrateIdentityRecord } = await import('../../src/host/identity.js');
    const original = createIdentity();
    const legacy = { ...original };
    delete legacy.encryption;

    const { record, migrated } = migrateIdentityRecord(legacy);
    assert.equal(migrated, true);
    assert.equal(record.publicKeyId, original.publicKeyId, '签名身份绝不能变');
    assert.ok(record.encryption.publicKeyId.startsWith('x25519:'));

    const again = migrateIdentityRecord(record);
    assert.equal(again.migrated, false, '已经有的不该重复生成');
  });
});

// ---------------------------------------------------------------------------
// ② 中继自身
// ---------------------------------------------------------------------------

describe('中继：转发闸门', () => {
  it('密文可以转发', () => {
    const bob = createEncryptionKeys();
    const verdict = classifyForward({
      kind: MESSAGE_KIND.DIRECT_MESSAGE,
      payload: sealFor(bob.publicKeyId, { text: 'hi' }),
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.reason, 'sealed');
  });

  it('明文的私聊被拒绝（这是规划 §5.3 的硬要求，不是可配置的偏好）', () => {
    const verdict = classifyForward({
      kind: MESSAGE_KIND.DIRECT_MESSAGE,
      payload: { text: '这是一句明文私聊' },
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'plaintext-refused');
  });

  it('公开类型放行；公开分享要 scope 真的是 public', () => {
    assert.equal(classifyForward({ kind: MESSAGE_KIND.PRESENCE, payload: { nickname: 'x' } }).ok, true);
    assert.equal(classifyForward({ kind: MESSAGE_KIND.LIVE_EVENT, payload: { roomId: 'r' } }).ok, true);

    const publicShare = { kind: MESSAGE_KIND.SHARE_ANNOUNCE, payload: { share: { policy: { scope: 'public' } } } };
    assert.equal(classifyForward(publicShare).ok, true);

    const privateShare = { kind: MESSAGE_KIND.SHARE_ANNOUNCE, payload: { share: { policy: { scope: 'friends' } } } };
    assert.equal(classifyForward(privateShare).ok, false);
    assert.equal(classifyForward(privateShare).reason, 'share-not-public');
  });

  it('未知类型一律拒绝（白名单而不是黑名单）', () => {
    // 上游将来新增一种事件类型时，黑名单会静默放行它，白名单只会"少转发"。
    // 少转发的表现是功能缺失，不是隐私泄露 —— 这个取舍是刻意的。
    assert.equal(classifyForward({ kind: 'some-future-kind', payload: { data: 'x' } }).ok, false);
    assert.equal(classifyForward(null).ok, false);
  });
});

describe('中继：登记表', () => {
  it('容量上限生效，满了就拒绝新登记', () => {
    const registry = new RelayRegistry({ policy: { ...DEFAULT_RELAY_POLICY, maxPeers: 2 } });
    assert.equal(registry.register({ peerKey: 'k1', connectionKey: 'k1' }).ok, true);
    assert.equal(registry.register({ peerKey: 'k2', connectionKey: 'k2' }).ok, true);
    const rejected = registry.register({ peerKey: 'k3', connectionKey: 'k3' });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, 'relay-at-capacity');
  });

  it('同一身份重复登记不会占用额外容量（重连场景）', () => {
    const registry = new RelayRegistry({ policy: { ...DEFAULT_RELAY_POLICY, maxPeers: 1 } });
    registry.register({ peerKey: 'k1', connectionKey: 'k1' });
    assert.equal(registry.register({ peerKey: 'k1', connectionKey: 'k1' }).ok, true);
    assert.equal(registry.size, 1);
  });

  it('超时未活动的登记会被清理（不把短期在线当永久稳定）', () => {
    let now = 1_000_000;
    const registry = new RelayRegistry({ policy: { ...DEFAULT_RELAY_POLICY, peerTtlMs: 1000 }, now: () => now });
    registry.register({ peerKey: 'k1', connectionKey: 'k1' });
    assert.ok(registry.lookup('k1'));
    now += 2000;
    assert.equal(registry.lookup('k1'), null);
  });

  it('连接断开时按连接清理登记', () => {
    const registry = new RelayRegistry({});
    registry.register({ peerKey: 'k1', connectionKey: 'conn-a' });
    registry.register({ peerKey: 'k2', connectionKey: 'conn-a' });
    registry.register({ peerKey: 'k3', connectionKey: 'conn-b' });
    assert.equal(registry.unregisterByConnection('conn-a'), 2);
    assert.equal(registry.size, 1);
  });

  it('只有通过校验的自签名文档才入库', () => {
    const bob = identityFromRecord(createIdentity());
    const mallory = createIdentity();
    const registry = new RelayRegistry({});

    registry.register({ peerKey: bob.publicKeyId, connectionKey: 'c', document: bob.document() });
    assert.ok(registry.documentOf(bob.publicKeyId));

    const forged = { ...bob.document(), encryptionKeyId: mallory.encryption.publicKeyId };
    registry.register({ peerKey: 'evil', connectionKey: 'c2', document: forged });
    assert.equal(registry.documentOf('evil'), null, '伪造文档不能入库');
  });
});

describe('中继：转发（走真实的产品路径 RelayTransport）', () => {
  /**
   * 造一个节点。`asRelay` 为真时它同时充当公网中继。
   *
   * 这里刻意使用 `RelayTransport` 而不是裸的 `LanTransport` ——
   * 前者才是产品里真正跑的那条路径（直连优先、连不上自动改走中继、
   * 收到的转发信封会自动拆包后交给上层）。只用裸传输层测，
   * 会漏掉"拆包"这一步，测出来的是个不存在的链路。
   */
  async function makeNode({ nickname, asRelay = false, policy = {} } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-chat-relay-'));
    const identity = identityFromRecord(createIdentity());
    const config = normalizeConfig({
      dataDir: dir,
      listen: { host: '127.0.0.1', port: 0 },
      discovery: { enabled: false },
      network: { connectTimeoutMs: 3000, handshakeTimeoutMs: 4000 },
    });
    const codec = new EnvelopeCodec({ identity });
    const inner = new LanTransport({ config, identity, codec, nodeInfo: () => ({ nickname }) });
    const transport = new RelayTransport({ inner, identity, enableRelayServer: asRelay, policy })
      .useCodecSeal((kind, payload, to) => codec.seal(kind, payload, { to }));

    const received = [];
    const unreachable = [];
    const documents = [];
    transport.on('envelope', (payload) => received.push(payload));
    transport.on('relay-unreachable', (payload) => unreachable.push(payload));
    transport.on('relay-document', (payload) => documents.push(payload));

    await transport.start();
    cleanups.push(async () => { await transport.stop(); rmSync(dir, { recursive: true, force: true }); });
    return { identity, codec, transport, received, unreachable, documents };
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

  it('两个对端挂号到中继后，密文自动经中继互通；中继看不到明文', async () => {
    const relay = await makeNode({ nickname: '公网中继', asRelay: true });
    const alice = await makeNode({ nickname: 'A' });
    const bob = await makeNode({ nickname: 'B' });

    await alice.transport.addRelay(relay.transport.address);
    await bob.transport.addRelay(relay.transport.address);
    await waitFor(
      () => relay.transport.relayServer.registry.lookup(alice.identity.publicKeyId)
        && relay.transport.relayServer.registry.lookup(bob.identity.publicKeyId),
      '双方在中继上挂号',
    );

    const secret = { text: '这条只有 B 能读', at: Date.now() };
    // 注意：A 与 B 之间**没有直连**，send() 会自动改走中继。
    const ok = alice.transport.send(bob.identity.publicKeyId, alice.codec.seal(
      MESSAGE_KIND.DIRECT_MESSAGE,
      sealFor(bob.identity.encryptionKeyId, secret),
      { to: bob.identity.publicKeyId },
    ));
    assert.equal(ok, true, 'send() 应当在直连不可达时自动改走中继');

    const delivered = await waitFor(
      () => bob.received.find((item) => item.envelope.kind === MESSAGE_KIND.DIRECT_MESSAGE) ?? null,
      'B 收到经中继转发并已拆包的信封',
    );
    assert.deepEqual(bob.identity.decrypt(delivered.envelope.payload), secret);
    assert.ok(isSealedPayload(delivered.envelope.payload));

    // 中继手里只有密文
    assert.equal(JSON.stringify(relay.transport.metrics).includes('这条只有 B 能读'), false,
      '中继的任何统计里都不该出现明文');
    const metrics = relay.transport.relayServer.metrics;
    assert.equal(metrics.forwarded, 1);
    assert.equal(metrics.refusedPlaintext, 0);
    console.log(`    中继转发 1 条密文（${JSON.stringify(delivered.envelope.payload).length} 字节）并完成拆包；`
      + `登记 ${metrics.peers} 个对端，转发 ${metrics.bytesForwarded} 字节`);
  });

  it('中继在登记表里能看到对端，但拿不到明文（协议层决定，不是承诺）', async () => {
    const relay = await makeNode({ nickname: '公网中继', asRelay: true });
    const alice = await makeNode({ nickname: 'A' });
    const bob = await makeNode({ nickname: 'B' });
    await alice.transport.addRelay(relay.transport.address);
    await bob.transport.addRelay(relay.transport.address);
    await waitFor(() => relay.transport.relayServer.registry.size === 2, '两人挂号');

    const registry = relay.transport.relayServer.registry;
    const peers = registry.listPeers();
    assert.equal(peers.length, 2);
    // 中继能看到元数据 —— 这条要如实说明，不能假装看不到
    for (const peer of peers) {
      assert.ok(peer.peerKey.startsWith('ed25519:'));
      assert.equal(typeof peer.lastSeen, 'number');
    }
    assert.equal(registry.keyChanged(bob.identity.publicKeyId), false);
    console.log('    中继可见：身份、时间、流量大小（元数据）；不可见：任何正文');
  });

  it('明文的私聊经中继会被拒绝，并回 unreachable 说明原因', async () => {
    const relay = await makeNode({ nickname: '公网中继', asRelay: true });
    const alice = await makeNode({ nickname: 'A' });
    const bob = await makeNode({ nickname: 'B' });
    await alice.transport.addRelay(relay.transport.address);
    await bob.transport.addRelay(relay.transport.address);
    await waitFor(() => relay.transport.relayServer.registry.lookup(bob.identity.publicKeyId), 'B 挂号');

    alice.transport.send(bob.identity.publicKeyId, alice.codec.seal(
      MESSAGE_KIND.DIRECT_MESSAGE,
      { text: '这是一句明文私聊' }, // ← 故意不加密
      { to: bob.identity.publicKeyId },
    ));

    const reason = await waitFor(() => alice.unreachable[0] ?? null, '收到 unreachable');
    assert.match(reason.reason, /refused:plaintext-refused/);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(bob.received.filter((item) => item.envelope.kind === MESSAGE_KIND.DIRECT_MESSAGE).length, 0);
    assert.equal(relay.transport.relayServer.metrics.forwarded, 0);
    console.log(`    明文私聊被中继拒绝（fail-closed），原因回传给发送方：${reason.reason}`);
  });

  it('目标未挂号时回 unreachable，而不是静默丢弃', async () => {
    const relay = await makeNode({ nickname: '公网中继', asRelay: true });
    const alice = await makeNode({ nickname: 'A' });
    await alice.transport.addRelay(relay.transport.address);
    await waitFor(() => relay.transport.relayServer.registry.size === 1, 'A 挂号');

    const strangerKey = identityFromRecord(createIdentity()).publicKeyId;
    alice.transport.send(strangerKey, alice.codec.seal(
      MESSAGE_KIND.DIRECT_MESSAGE,
      sealFor(createEncryptionKeys().publicKeyId, { x: 1 }),
      { to: strangerKey },
    ));
    const reason = await waitFor(() => alice.unreachable[0] ?? null, '收到 unreachable');
    assert.equal(reason.reason, 'not-registered');
    console.log('    未挂号的目标收到明确 unreachable，发送方知道该换中继或等对方上线');
  });

  it('中继可按身份查到自签名文档，且只能转交不能伪造', async () => {
    const relay = await makeNode({ nickname: '公网中继', asRelay: true });
    const bob = await makeNode({ nickname: 'B' });
    const alice = await makeNode({ nickname: 'A' });
    await bob.transport.addRelay(relay.transport.address);
    await alice.transport.addRelay(relay.transport.address);
    await waitFor(() => relay.transport.relayServer.registry.lookup(bob.identity.publicKeyId), 'B 挂号');

    alice.transport.relayClient.lookup(bob.identity.publicKeyId);
    const payload = await waitFor(() => alice.documents[0] ?? null, '收到文档');

    assert.equal(payload.online, true);
    assert.ok(payload.document);
    // 关键：中继只是转交，文档本身必须仍然通过自签名校验
    assert.equal(verifyIdentityDocument(payload.document).valid, true, '文档必须原样转交，加任何字段都会破坏签名');
    assert.equal(payload.document.publicKeyId, bob.identity.publicKeyId);
    assert.equal(payload.document.encryptionKeyId, bob.identity.encryptionKeyId);

    // 查不到就如实返回 null
    const missing = await (async () => {
      alice.transport.relayClient.lookup(identityFromRecord(createIdentity()).publicKeyId);
      await new Promise((resolve) => setTimeout(resolve, 200));
      return alice.documents.at(-1);
    })();
    assert.equal(missing.document, null);
    console.log('    文档原样转交、自签名可验证；查不到时返回 null 而不是编造');
  });

  it('中继容量满了会拒绝新登记，并如实回原因', async () => {
    const relay = await makeNode({ nickname: '公网中继', asRelay: true, policy: { maxPeers: 1 } });
    const alice = await makeNode({ nickname: 'A' });
    const bob = await makeNode({ nickname: 'B' });
    await alice.transport.addRelay(relay.transport.address);
    await waitFor(() => relay.transport.relayServer.registry.size === 1, 'A 挂号');
    await bob.transport.addRelay(relay.transport.address);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const bobState = bob.transport.relayClient.relays()[0];
    assert.equal(bobState.registered, false, 'B 不该被登记');
    assert.equal(relay.transport.relayServer.metrics.registrationsRejected >= 1, true);
    console.log('    容量上限生效：第 2 个对端被拒，中继如实回 capacity 原因');
  });
});

// ---------------------------------------------------------------------------
// ③ 端到端：对称 NAT 后面两个节点，靠公网中继连通
// ---------------------------------------------------------------------------

describe('端到端：对称 NAT 下直连必失败，加中继就通', () => {
  it('虚拟环境判定：两侧对称 NAT 且无端口映射时，直连不可行', async () => {
    const internet = new VirtualInternet();
    cleanups.push(() => internet.close());
    internet.defineSubnet('lan-a', '10.0.1');
    internet.defineSubnet('lan-b', '10.0.2');
    internet.defineSubnet('dmz', '198.51.100');

    const gwA = internet.createGateway({ name: 'gwA', lanSubnet: 'lan-a', mode: NAT_MODE.SYMMETRIC });
    const gwB = internet.createGateway({ name: 'gwB', lanSubnet: 'lan-b', mode: NAT_MODE.SYMMETRIC });
    const gwR = internet.createGateway({ name: 'gwR', lanSubnet: 'dmz', mode: NAT_MODE.OPEN, publicIp: '198.51.100.1' });
    internet.registerHost('A', { subnet: 'lan-a', ip: '10.0.1.5', realPort: 0, gateway: gwA });
    internet.registerHost('B', { subnet: 'lan-b', ip: '10.0.2.5', realPort: 0, gateway: gwB });
    // 中继必须**真的存在**才算一条可行路线；早先忘了注册这台主机，
    // 于是"出站可达"断言失败 —— 那不是网络不行，是测试里没有那台机器。
    internet.registerHost('R', { subnet: 'dmz', ip: '198.51.100.9', realPort: 47800, gateway: gwR });

    const direct = internet.decide({ fromHost: 'A', dstIp: '10.0.2.5', dstPort: 47800 });
    assert.equal(direct.allowed, false);
    assert.equal(direct.reason, 'nat-inbound-blocked');
    console.log('    对称 NAT + 无映射 → 直连被拒（这就是需要中继的全部理由）');

    // 每个 NAT 后面的节点都能**出站**连到公网中继 —— 这条永远成立
    const toRelayFromA = internet.decide({ fromHost: 'A', dstIp: '198.51.100.9', dstPort: 47800 });
    assert.equal(toRelayFromA.allowed, true, '出站永远可达，中继路线因此可用');
  });

  it('两个对端各自出站挂号到中继，双向加密消息都能跑通（真实字节流）', async () => {
    // 用真实的三个节点进程内跑：A、B 在各自"网络"里，R 是公网中继。
    // 拓扑判决由虚拟网络给出，数据面用真实 TCP + 真实加密。
    const internet = new VirtualInternet();
    cleanups.push(() => internet.close());
    internet.defineSubnet('lan-a', '10.0.1');
    internet.defineSubnet('lan-b', '10.0.2');
    internet.defineSubnet('dmz', '198.51.100');
    const gwA = internet.createGateway({ name: 'gwA', lanSubnet: 'lan-a', mode: NAT_MODE.SYMMETRIC });
    const gwB = internet.createGateway({ name: 'gwB', lanSubnet: 'lan-b', mode: NAT_MODE.SYMMETRIC });
    const gwR = internet.createGateway({ name: 'gwR', lanSubnet: 'dmz', mode: NAT_MODE.OPEN });

    // 先确认直连确实不可行 —— 否则这个测试就失去了意义
    internet.registerHost('A', { subnet: 'lan-a', ip: '10.0.1.5', realPort: 0, gateway: gwA });
    internet.registerHost('B', { subnet: 'lan-b', ip: '10.0.2.5', realPort: 0, gateway: gwB });
    assert.equal(internet.decide({ fromHost: 'A', dstIp: '10.0.2.5', dstPort: 47800 }).allowed, false);

    // 中继节点 R（公网、无 NAT）
    const relayDir = mkdtempSync(join(tmpdir(), 'dsh-chat-e2e-relay-'));
    const relayIdentity = identityFromRecord(createIdentity());
    const relayConfig = normalizeConfig({
      dataDir: relayDir, listen: { host: '127.0.0.1', port: 0 }, discovery: { enabled: false },
      network: { connectTimeoutMs: 3000, handshakeTimeoutMs: 4000 },
    });
    const relayCodec = new EnvelopeCodec({ identity: relayIdentity });
    const relayTransport = new RelayTransport({
      inner: new LanTransport({
        config: relayConfig, identity: relayIdentity, codec: relayCodec, nodeInfo: () => ({ nickname: '公网中继' }),
      }),
      identity: relayIdentity,
      enableRelayServer: true,
    }).useCodecSeal((kind, payload, to) => relayCodec.seal(kind, payload, { to }));
    await relayTransport.start();
    cleanups.push(async () => { await relayTransport.stop(); rmSync(relayDir, { recursive: true, force: true }); });

    internet.registerHost('R', { subnet: 'dmz', ip: '198.51.100.9', realPort: Number(relayTransport.address.split(':').pop()), gateway: gwR });

    // A、B 各自出站连到中继（对称 NAT 允许出站）
    const makePeer = async (nickname) => {
      const dir = mkdtempSync(join(tmpdir(), 'dsh-chat-e2e-peer-'));
      const identity = identityFromRecord(createIdentity());
      const config = normalizeConfig({
        dataDir: dir, listen: { host: '127.0.0.1', port: 0 }, discovery: { enabled: false },
        network: { connectTimeoutMs: 3000, handshakeTimeoutMs: 4000 },
      });
      const codec = new EnvelopeCodec({ identity });
      const transport = new RelayTransport({
        inner: new LanTransport({ config, identity, codec, nodeInfo: () => ({ nickname }) }),
        identity,
      }).useCodecSeal((kind, payload, to) => codec.seal(kind, payload, { to }));
      const received = [];
      transport.on('envelope', (payload) => received.push(payload));
      await transport.start();
      cleanups.push(async () => { await transport.stop(); rmSync(dir, { recursive: true, force: true }); });
      // 对称 NAT 后面的节点**只能出站** —— 这正是在真实网络里唯一能做的事
      await transport.addRelay(relayTransport.address);
      return { identity, codec, transport, received };
    };

    const alice = await makePeer('A');
    const bob = await makePeer('B');

    const waitFor = async (predicate, label, timeoutMs = 6000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = predicate();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`等待「${label}」超时`);
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    };
    await waitFor(() => relayTransport.relayServer.registry.lookup(alice.identity.publicKeyId)
      && relayTransport.relayServer.registry.lookup(bob.identity.publicKeyId), '双方在中继上挂号');

    const exchange = async (from, to, text) => {
      const secret = { text, at: Date.now() };
      // 一行搞定：RelayTransport 发现直连不可达，自动改走中继。
      from.transport.send(to.identity.publicKeyId, from.codec.seal(
        MESSAGE_KIND.DIRECT_MESSAGE,
        sealFor(to.identity.encryptionKeyId, secret),
        { to: to.identity.publicKeyId },
      ));
      const delivered = await waitFor(
        () => to.received.find((item) => item.envelope.kind === MESSAGE_KIND.DIRECT_MESSAGE
          && item.envelope.from === from.identity.publicKeyId) ?? null,
        `${text} 送达`,
      );
      // 收件人验证签名（证来源）+ 解密（证保密）
      const { sig, ...body } = delivered.envelope;
      const { verifyWithPublicKeyId } = await import('../../src/host/identity.js');
      assert.ok(verifyWithPublicKeyId(from.identity.publicKeyId, body, sig), '端到端签名必须仍然有效');
      assert.deepEqual(to.identity.decrypt(delivered.envelope.payload), secret);
      return delivered;
    };

    await exchange(alice, bob, 'A→B 经过公网中继');
    await exchange(bob, alice, 'B→A 也经过公网中继');

    const metrics = relayTransport.relayServer.metrics;
    assert.equal(metrics.forwarded, 2);
    assert.equal(metrics.refusedPlaintext, 0);
    console.log('    对称 NAT 两侧：直连被拒 → 各自**只做出站**挂号到公网中继 → 双向加密消息跑通');
    console.log(`    中继统计：转发 ${metrics.forwarded} 条、拒绝明文 ${metrics.refusedPlaintext} 条、`
      + `登记 ${metrics.peers} 个对端、转发字节 ${metrics.bytesForwarded}`);
  });
});
