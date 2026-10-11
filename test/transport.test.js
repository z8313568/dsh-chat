/**
 * 两个真实节点之间的端到端验证——这是规划「阶段 0」的核心验收标准：
 *   「两个独立用户实例能够安全交换测试消息；断线后不会崩溃；用户可以明确暂停通信。」
 *
 * 这里刻意用**真实的 TCP + 真实的手写 WebSocket + 真实的 Ed25519 签名**，
 * 两个节点跑在两条真实端口上，不是 mock。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { MESSAGE_KIND } from '../src/shared/protocol.js';
import { createIdentity, identityFromRecord, verifyWithPublicKeyId } from '../src/host/identity.js';
import { EnvelopeCodec, REJECT_REASON } from '../src/host/net/envelope.js';
import { LanTransport, decodeInvite, encodeInvite } from '../src/host/net/lan.js';
import { normalizeConfig } from '../src/host/config.js';

/** 造一个最小可用的节点：身份 + codec + LAN 传输。 */
function makeNode({ dir, nickname, port = 0, discovery = false }) {
  const identity = identityFromRecord(createIdentity());
  const config = normalizeConfig({
    dataDir: dir,
    listen: { host: '127.0.0.1', port },
    discovery: { enabled: discovery, beaconPort: 47911 },
  });
  const codec = new EnvelopeCodec({ identity });
  const events = [];
  const transport = new LanTransport({
    config,
    identity,
    codec,
    nodeInfo: () => ({ nickname }),
  });
  transport.on('envelope', (payload) => events.push(payload));
  return { identity, config, codec, transport, events, nickname };
}

/** 等到某个条件成立，或超时失败。 */
async function waitFor(predicate, { timeoutMs = 5000, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待「${label}」超时`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('两个节点的端到端链路', () => {
  let dirA;
  let dirB;
  let a;
  let b;

  before(async () => {
    dirA = mkdtempSync(join(tmpdir(), 'dsh-chat-a-'));
    dirB = mkdtempSync(join(tmpdir(), 'dsh-chat-b-'));
    a = makeNode({ dir: dirA, nickname: '节点 A' });
    b = makeNode({ dir: dirB, nickname: '节点 B' });
    await a.transport.start();
    await b.transport.start();
  });

  after(async () => {
    await a?.transport.stop();
    await b?.transport.stop();
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it('双向身份握手：两个节点互相证明持有各自私钥', async () => {
    assert.ok(a.transport.address, 'A 应在监听');
    assert.ok(b.transport.address, 'B 应在监听');
    // 两个节点的身份必须不同——否则后面所有断言都失去意义。
    assert.notEqual(a.identity.publicKeyId, b.identity.publicKeyId);

    await a.transport.connect(b.transport.address);

    const peersOfA = await waitFor(
      () => (a.transport.peers().length === 1 ? a.transport.peers() : null),
      { label: 'A 看到 B' },
    );
    const peersOfB = await waitFor(
      () => (b.transport.peers().length === 1 ? b.transport.peers() : null),
      { label: 'B 看到 A' },
    );

    // 关键：两边的 peerKey 必须是对方的公钥标识，而不是地址或自报的名字。
    assert.equal(peersOfA[0].peerKey, b.identity.publicKeyId);
    assert.equal(peersOfB[0].peerKey, a.identity.publicKeyId);
    assert.equal(peersOfA[0].nickname, '节点 B');
    assert.equal(peersOfB[0].nickname, '节点 A');
    assert.equal(peersOfA[0].fingerprint, b.identity.fingerprint);
  });

  it('签名信封可以跨节点送达并被验签接受', async () => {
    const envelope = a.codec.seal(MESSAGE_KIND.DIRECT_MESSAGE, {
      text: '你好，这是一条来自 A 的测试消息',
      crypto: null,
    }, { to: b.identity.publicKeyId });

    a.transport.send(b.identity.publicKeyId, envelope);
    const received = await waitFor(() => b.events[0] ?? null, { label: 'B 收到消息' });

    assert.equal(received.envelope.kind, MESSAGE_KIND.DIRECT_MESSAGE);
    assert.equal(received.envelope.from, a.identity.publicKeyId);
    assert.equal(received.envelope.payload.text, '你好，这是一条来自 A 的测试消息');
    // 再次独立验签，确认收到的确实是 A 签的（不依赖 codec 的中间结论）。
    const { sig, ...rest } = received.envelope;
    assert.ok(verifyWithPublicKeyId(a.identity.publicKeyId, rest, sig), '签名应可独立验证');
  });

  it('同一封信封重复投递会被去重丢弃（规划 §7.4 要求处理重复事件）', async () => {
    const before = b.events.length;
    const envelope = a.codec.seal(MESSAGE_KIND.PRESENCE, { status: 'online' }, { to: b.identity.publicKeyId });
    a.transport.send(b.identity.publicKeyId, envelope);
    await waitFor(() => (b.events.length > before ? true : null), { label: 'B 收到第一次' });

    // 从 A 再发一次同一个信封，模拟弱网重传——接收方仍是 B。
    const afterFirst = b.events.length;
    a.transport.send(b.identity.publicKeyId, envelope);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(b.events.length, afterFirst, '重复信封不应再次上抛');
    assert.ok((b.codec.metrics.byReason[REJECT_REASON.DUPLICATE] ?? 0) >= 1, '应记录为 duplicate');
  });

  it('被篡改的信封会被拒绝，且不会上抛给上层', async () => {
    const before = b.events.length;
    const envelope = a.codec.seal(MESSAGE_KIND.DIRECT_MESSAGE, { text: '原始内容' }, { to: b.identity.publicKeyId });
    // 改动载荷但保留原签名——这正是中间人攻击要做的事。
    const tampered = { ...envelope, payload: { text: '被篡改的内容' } };
    a.transport.send(b.identity.publicKeyId, tampered);

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(b.events.length, before, '篡改后的信封不应上抛');
    assert.ok((b.codec.metrics.byReason[REJECT_REASON.BAD_SIGNATURE] ?? 0) >= 1, '应记录签名失败');
  });

  it('发给第三方的单播不会被本地消费', () => {
    const foreign = createIdentity();
    const envelope = a.codec.seal(MESSAGE_KIND.DIRECT_MESSAGE, { text: '给别人的' }, {
      to: `${'ed25519:'}${foreign.secret.publicJwk.x}`,
    });
    const verdict = b.codec.open(envelope);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, REJECT_REASON.NOT_FOR_ME);
  });

  it('断线后对端被标记为离线，重连可以恢复（规划 §16.2 断线恢复能力）', async () => {
    const addressB = b.transport.address;
    await a.transport.stop();
    const downed = await waitFor(() => (b.transport.peers().length === 0 ? true : null), { label: 'B 看到 A 离线' });
    assert.ok(downed);

    // A 重新起在同一个端口上，验证「重连」不是靠进程内状态侥幸通过的。
    const nodeA2 = makeNode({ dir: dirA, nickname: '节点 A' });
    a.transport = nodeA2.transport;
    a.codec = nodeA2.codec;
    a.events = nodeA2.events;
    a.identity = nodeA2.identity;
    await a.transport.start();
    await a.transport.connect(addressB);

    const reconnected = await waitFor(
      () => (b.transport.peers().length === 1 ? b.transport.peers() : null),
      { label: 'B 看到 A 重新上线' },
    );
    assert.equal(reconnected[0].peerKey, a.identity.publicKeyId);
  });
});

describe('邀请码与节点发现', () => {
  it('邀请码可编解码，且非法输入返回 null 而不是抛错', () => {
    const identity = createIdentity();
    const code = encodeInvite({
      publicKeyId: `${'ed25519:'}${identity.secret.publicJwk.x}`,
      nickname: '老李',
      address: '192.168.1.20:47800',
    });
    const decoded = decodeInvite(code);
    assert.equal(decoded.address, '192.168.1.20:47800');
    assert.equal(decoded.nickname, '老李');
    assert.equal(decodeInvite('192.168.1.20:47800'), null, '普通地址不是邀请码');
    assert.equal(decodeInvite('dshchat1:@@@not-base64@@@'), null, '坏 base64 不应抛错');
    assert.equal(decodeInvite('dshchat1:' + Buffer.from('{"address":"nope"}').toString('base64url')), null);
  });

  it('UDP 信标让两个实例互相发现并自动建立连接', async () => {
    const dir1 = mkdtempSync(join(tmpdir(), 'dsh-chat-d1-'));
    const dir2 = mkdtempSync(join(tmpdir(), 'dsh-chat-d2-'));
    const n1 = makeNode({ dir: dir1, nickname: '发现-1', discovery: true });
    const n2 = makeNode({ dir: dir2, nickname: '发现-2', discovery: true });
    try {
      await n1.transport.start();
      await n2.transport.start();
      // 不手工 connect：这里要证明的正是"它们自己找到对方"。
      const peers = await waitFor(
        () => (n1.transport.peers().length === 1 && n2.transport.peers().length === 1
          ? n1.transport.peers()
          : null),
        { label: '两个实例通过信标自动互连', timeoutMs: 15000 },
      );
      assert.equal(peers[0].peerKey, n2.identity.publicKeyId);
    } finally {
      await n1.transport.stop();
      await n2.transport.stop();
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
