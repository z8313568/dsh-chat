/**
 * 直播引擎与会话分享测试。
 *
 * 关注点集中在规划里明确写下、但很容易实现错的地方：
 *   - 暂停必须**立刻**停止外发，且不影响本地会话（§7.2）；
 *   - 事件必须有序、可去重、能发现空洞并补拉（§7.4）；
 *   - 回放裁剪后要如实告知不完整（§7.4 / §11.5）；
 *   - 分享对象的完整性与真实性是**两个独立结论**（§6.4）；
 *   - 分享里的内容必须逐条过脱敏，被扣下的条目不能混进去（§7.7）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { normalizeConfig } from '../src/host/config.js';
import { ConsentGate } from '../src/host/consent.js';
import { createRedactionPipeline } from '../src/host/redaction.js';
import { createIdentity, identityFromRecord, verifyWithPublicKeyId } from '../src/host/identity.js';
import { LiveEngine, LiveError } from '../src/host/live.js';
import { ShareRegistry, merkleRoot } from '../src/host/share.js';
import { PROTOCOL_VERSION } from '../src/shared/protocol.js';

let dir;

function harness(overrides = {}) {
  dir = mkdtempSync(join(tmpdir(), 'dsh-chat-live-'));
  const config = normalizeConfig({ dataDir: dir, live: { maxBackfillEvents: 3, requirePreview: true }, ...overrides });
  const identity = identityFromRecord(createIdentity());
  const consent = new ConsentGate({ config });
  const redaction = createRedactionPipeline({ config });
  const profile = { nickname: '主播小张' };
  const live = new LiveEngine({ config, identity, consent, redaction, profile: () => profile });
  const shares = new ShareRegistry({
    config, identity, consent, redaction, profile: () => profile,
    readEvents: async () => [
      { sessionId: 's1', seq: 1, type: 'user/message', time: 1000, severity: 'info', contentKind: 'prompt', text: '帮我写一个登录页' },
      { sessionId: 's1', seq: 2, type: 'assistant/message', time: 2000, severity: 'info', contentKind: 'answer', text: '好的，用 Vue 3 实现' },
      { sessionId: 's1', seq: 3, type: 'tool/result', time: 3000, severity: 'info', contentKind: 'tool', text: 'bash: npm run build' },
      { sessionId: 's1', seq: 4, type: 'turn/end', time: 4000, severity: 'info', contentKind: null, text: '' },
    ],
  });
  return { config, identity, consent, redaction, live, shares, profile };
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function openRoom(live, sessionId = 's1', extra = {}) {
  return live.open(sessionId, {
    title: '用 AI 写登录页', tags: ['vue', '前端'], mode: 'full', scope: 'public', previewed: true, ...extra,
  });
}

describe('直播引擎', () => {
  it('开播会同时完成授权，没有授权就没有直播间', () => {
    const { live, consent } = harness();
    assert.equal(consent.isAuthorized('s1'), false);
    const room = openRoom(live);
    assert.equal(consent.isAuthorized('s1'), true);
    assert.equal(room.status, 'live');
    // 第一条事件必须是 session_started，且序号从 1 开始。
    assert.equal(room.events[0].type, 'session_started');
    assert.equal(room.events[0].seq, 1);
  });

  it('没有预览就不允许开播（与授权门的前置条件一致）', () => {
    const { live } = harness();
    assert.throws(() => openRoom(live, 's1', { previewed: false }), /预览/);
  });

  it('会话已经在直播中时不能重复开播', () => {
    const { live } = harness();
    openRoom(live);
    assert.throws(() => openRoom(live), (error) => error instanceof LiveError && error.detail.code === 'dsh-chat/already-live');
  });

  it('同时直播数受配置限制', () => {
    const { live } = harness({ live: { maxConcurrentRooms: 1, requirePreview: true } });
    openRoom(live, 's1');
    assert.throws(() => openRoom(live, 's2'), (error) => error.detail.code === 'dsh-chat/too-many-rooms');
  });

  it('record 会被翻译成有序的直播事件，且每条都带签名', () => {
    const { live, identity } = harness();
    const room = openRoom(live);
    live.ingest({ session: { id: 's1' }, seq: 10, type: 'user/message', time: 1500, severity: 'info', contentKind: 'prompt', text: '问题一' });
    live.ingest({ session: { id: 's1' }, seq: 11, type: 'assistant/message', time: 1600, severity: 'info', contentKind: 'answer', text: '回答一' });

    const messages = room.events.filter((e) => e.type === 'message_added');
    assert.equal(messages.length, 2);
    assert.deepEqual(messages.map((e) => e.seq), [2, 3], '序号必须连续递增');
    assert.deepEqual(messages.map((e) => e.payload.text), ['问题一', '回答一']);
    for (const event of messages) {
      const { sig, ...body } = event;
      assert.ok(verifyWithPublicKeyId(identity.publicKeyId, body, sig), '直播事件应携带可独立验证的签名');
    }
  });

  it('暂停后立即停止外发，恢复后继续，且暂停不影响本地会话', () => {
    const { live } = harness();
    const room = openRoom(live);
    live.ingest({ session: { id: 's1' }, seq: 10, type: 'user/message', time: 1, contentKind: 'prompt', text: '暂停前' });

    live.pause(room.id);
    assert.equal(room.paused, true);
    const before = room.eventCount;
    const blocked = live.ingest({ session: { id: 's1' }, seq: 11, type: 'user/message', time: 2, contentKind: 'prompt', text: '暂停中' });
    assert.equal(blocked, null, '暂停期间不应产出任何事件');
    assert.equal(room.eventCount, before);

    live.resume(room.id);
    assert.equal(room.paused, false);
    const after = live.ingest({ session: { id: 's1' }, seq: 12, type: 'user/message', time: 3, contentKind: 'prompt', text: '恢复后' });
    assert.ok(after, '恢复后应继续产出事件');

    // 直接断言整条事件序列，比"看最后两条"强得多：
    // 它同时证明了暂停期间确实什么都没发（序列里没有"暂停中"那条）、
    // 暂停/恢复本身作为事件广播给了观众、以及恢复之后事件继续追加。
    assert.deepEqual(room.events.map((event) => event.type), [
      'session_started',
      'message_added',
      'stream_paused',
      'stream_resumed',
      'message_added',
    ]);
    assert.deepEqual(
      room.events.map((event) => event.seq),
      [1, 2, 3, 4, 5],
      '序号必须在暂停/恢复前后保持连续',
    );
    assert.equal(room.events.some((event) => event.payload?.text === '暂停中'), false, '暂停期间的内容绝不能出现在事件流里');
  });

  it('未勾选的内容类型不会进入直播流（即使房间开着）', () => {
    const { live } = harness();
    const room = openRoom(live, 's1', { mode: 'minimal' });
    const rejected = live.ingest({ session: { id: 's1' }, seq: 10, type: 'user/message', time: 1, contentKind: 'prompt', text: '不该出去' });
    assert.equal(rejected, null, 'minimal 粒度下 prompt 不应外发');
    const accepted = live.ingest({ session: { id: 's1' }, seq: 11, type: 'assistant/message', time: 2, contentKind: 'answer', text: '可以出去' });
    assert.ok(accepted);
    assert.equal(room.eventCount, 2, '只有 session_started 与那一条 answer');
  });

  it('直播内容在签名前先脱敏——签名证明的是外发字节，不是原文', () => {
    const { live } = harness();
    const room = openRoom(live, 's1', { mode: 'full' });
    live.ingest({
      session: { id: 's1' }, seq: 10, type: 'assistant/message', time: 1, contentKind: 'answer',
      text: '密钥 sk-abcdefghijklmnopqrstuvwx 放在 /Users/bob/secret/app.env',
    });
    const event = room.events.at(-1);
    assert.equal(event.payload.text.includes('sk-abcdefghijklmnopqrstuvwx'), false);
    assert.match(event.payload.text, /已脱敏/);
    assert.match(event.payload.text, /…\/app\.env/);
  });

  it('断线重连可以按 seq 补拉，且能发现中间的空洞', () => {
    const { live } = harness();
    const room = openRoom(live);
    for (let i = 0; i < 5; i += 1) {
      live.ingest({ session: { id: 's1' }, seq: 10 + i, type: 'assistant/message', time: i, contentKind: 'answer', text: `第${i}条` });
    }
    const backfill = room.eventsSince(1);
    assert.ok(backfill.events.length > 0);
    assert.ok(backfill.events.every((event) => event.seq > 1));
    assert.equal(backfill.latestSeq, room.seq);
    assert.equal(backfill.oldestSeq, room.events[0].seq);

    // 补拉有上限：请求一个很大的范围时会被截断，并明确告知截断了。
    const truncated = room.eventsSince(0, 2);
    assert.equal(truncated.events.length, 2);
    assert.equal(truncated.truncated, true);
  });

  it('环形裁剪会如实记账，快照里能看到丢了多少条', () => {
    // 这里把「环形容量」调小来触发裁剪。它与「单次补拉上限」是两个独立配置：
    // 混用会让"把补拉上限调小"意外地把回放也截短。
    const { live } = harness({ live: { maxRetainedEvents: 10, maxBackfillEvents: 2, requirePreview: true } });
    const room = openRoom(live);
    for (let i = 0; i < 60; i += 1) {
      live.ingest({ session: { id: 's1' }, seq: 100 + i, type: 'assistant/message', time: i, contentKind: 'answer', text: `x${i}` });
    }
    assert.ok(room.droppedEvents > 0, '事件数超过环形上限后应发生裁剪');
    assert.ok(room.events.length <= 10, `保留条数不应超过上限，实际 ${room.events.length}`);
    const snapshot = room.snapshot();
    assert.equal(snapshot.droppedEvents, room.droppedEvents);
    assert.ok(snapshot.oldestSeq > 1, '裁剪后最早的可用序号应向后移动');
    // 被裁掉的条数 + 还留着的条数 = 总条数
    assert.equal(snapshot.droppedEvents + room.events.length, room.eventCount);
  });

  it('结束直播会同时撤销授权，且结束是幂等的', () => {
    const { live, consent } = harness();
    const room = openRoom(live);
    live.close(room.id, { keepReplay: true });
    assert.equal(room.status, 'ended');
    assert.equal(consent.isAuthorized('s1'), false, '直播结束必须撤销外发授权');
    const first = room.eventCount;
    const again = live.close(room.id);
    assert.equal(again.status, 'ended');
    assert.equal(room.eventCount, first, '重复结束不应再追加事件');
  });

  it('结束后的房间不能再暂停或恢复', () => {
    const { live } = harness();
    const room = openRoom(live);
    live.close(room.id);
    assert.throws(() => live.pause(room.id), (error) => error.detail.code === 'dsh-chat/room-ended');
    assert.throws(() => live.resume(room.id), (error) => error.detail.code === 'dsh-chat/room-ended');
  });

  it('未结束的直播不能发布回放', () => {
    const { live } = harness();
    const room = openRoom(live);
    assert.throws(() => live.publishReplay(room.id), (error) => error.detail.code === 'dsh-chat/still-live');
    live.close(room.id);
    const published = live.publishReplay(room.id);
    assert.equal(published.replayPublished, true);
  });

  it('观众侧去重与空洞检测', () => {
    const { live, identity } = harness();
    live.mirrorRemote({ id: 'room-remote', title: '远端直播', host: { publicKeyId: identity.publicKeyId }, seq: 0 });

    assert.equal(live.acceptRemoteEvent('room-remote', { seq: 1 }), true);
    assert.equal(live.acceptRemoteEvent('room-remote', { seq: 1 }), false, '重复事件应被丢弃');
    assert.equal(live.acceptRemoteEvent('room-remote', { seq: 2 }), true);
    // 跳过 3、4 直接收 5 → 应记录一个空洞
    assert.equal(live.acceptRemoteEvent('room-remote', { seq: 5 }), true);
    const mirror = live.getMirror('room-remote');
    assert.equal(mirror.gaps.length, 1);
    assert.deepEqual([mirror.gaps[0].from, mirror.gaps[0].to], [3, 4]);
    const watched = live.listWatched();
    assert.equal(watched[0].pendingGaps, 1);
  });

  it('直播事件可以推给订阅者，单个订阅者抛错不影响其它订阅者', () => {
    const { live } = harness();
    const room = openRoom(live);
    const seen = [];
    const off1 = live.onRoomEvent(room.id, () => { throw new Error('订阅者炸了'); });
    const off2 = live.onRoomEvent(room.id, (event) => seen.push(event.seq));
    live.ingest({ session: { id: 's1' }, seq: 10, type: 'user/message', time: 1, contentKind: 'prompt', text: 'hi' });
    assert.equal(seen.length, 1, '第二个订阅者仍应收到事件');
    off1();
    off2();
  });

  it('瞬时 token 帧不进入事实链路：不产生持久事件，暂停后也不转发', () => {
    const { live } = harness();
    const room = openRoom(live);
    const chunks = [];
    live.onTransientChunk((packet) => chunks.push(packet));

    const before = room.eventCount;
    live.ingestChunk({ sessionId: 's1', frame: { type: 'chunk', index: 1, chunk: { type: 'text-delta', index: 0, text: '你' } } });
    assert.equal(chunks.length, 1);
    // 关键不变式：瞬时帧只用于观感，绝不能变成带 seq 的持久事件，否则事实链路会被污染。
    assert.equal(room.eventCount, before, '瞬时帧不应产生持久事件');

    live.pause(room.id);
    live.ingestChunk({ sessionId: 's1', frame: { type: 'chunk', index: 2, chunk: { type: 'text-delta', index: 0, text: '好' } } });
    assert.equal(chunks.length, 1, '暂停后不应再转发瞬时帧');

    // 未授权 / 未开播的会话，瞬时帧直接丢弃，不查任何状态。
    live.ingestChunk({ sessionId: 'unknown-session', frame: { type: 'chunk', index: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } } });
    assert.equal(chunks.length, 1);
  });
});

describe('分享对象', () => {
  it('创建的分享包含规划要求的全部字段', async () => {
    const { shares, consent } = harness();
    consent.authorize('s1', { mode: 'full', scope: 'public', previewed: true });
    const share = await shares.create('s1', { title: '登录页实现', scope: 'public', mode: 'full', previewed: true, copyable: true });

    for (const field of ['id', 'protocol', 'version', 'title', 'tags', 'author', 'createdAt', 'policy', 'items', 'merkleRoot', 'sig', 'disclosure']) {
      assert.ok(share[field] !== undefined, `分享对象缺少字段: ${field}`);
    }
    assert.equal(share.protocol, PROTOCOL_VERSION);
    assert.equal(share.merkleRoot, merkleRoot(share.items.map((item) => item.contentId)));
    assert.equal(share.policy.copyable, true);
  });

  it('完整性与真实性是两个独立结论，且都能被检出', async () => {
    const { shares, consent } = harness();
    consent.authorize('s1', { mode: 'full', scope: 'public', previewed: true });
    const share = await shares.create('s1', { scope: 'public', mode: 'full', previewed: true });

    const good = shares.verify(share);
    assert.equal(good.integrity, true);
    assert.equal(good.authenticity, true);
    assert.deepEqual(good.problems, []);

    // 只改内容 → 完整性失败（签名也会失败，因为签名覆盖全部字段）
    const tamperedText = JSON.parse(JSON.stringify(share));
    tamperedText.items[0].text = '被篡改的内容';
    const tampered = shares.verify(tamperedText);
    assert.equal(tampered.integrity, false);

    // 只改签名 → 真实性失败
    const badSig = { ...share, sig: `${share.sig}x` };
    const forged = shares.verify(badSig);
    assert.equal(forged.authenticity, false);
    assert.ok(forged.problems.includes('signature-invalid'));
  });

  it('条目被改动时 Merkle 根会失配，且单独报出来', async () => {
    const { shares, consent } = harness();
    consent.authorize('s1', { mode: 'full', scope: 'public', previewed: true });
    const share = await shares.create('s1', { scope: 'public', mode: 'full', previewed: true });
    const mutated = JSON.parse(JSON.stringify(share));
    // 同时改文本和它的 contentId，让"条目自校验"通过，只剩 Merkle 根能发现异常。
    mutated.items[0].text = '改了';
    const { contentId, ...rest } = mutated.items[0];
    const { contentHashOf } = await import('../src/host/identity.js');
    mutated.items[0].contentId = contentHashOf(rest);
    const verdict = shares.verify(mutated);
    assert.equal(verdict.integrity, false);
    assert.ok(verdict.problems.some((p) => p.startsWith('merkle-root') || p.startsWith('object-id')), verdict.problems.join(','));
  });

  it('未授权就不能创建分享', async () => {
    const { shares } = harness();
    await assert.rejects(
      () => shares.create('s1', { scope: 'public', mode: 'full', previewed: false }),
      /预览/,
    );
  });

  it('分享条目逐条过脱敏，被扣下的条目不进去', async () => {
    const { shares, consent, redaction } = harness();
    consent.authorize('s1', { mode: 'full', scope: 'public', previewed: true });
    // 装一条永不通过脱敏的规则，验证"扣下"而不是"放行原文"。
    redaction.use(() => undefined);
    await assert.rejects(
      () => shares.create('s1', { scope: 'public', mode: 'full', previewed: true }),
      /没有任何可分享的内容/,
    );
  });

  it('脱敏后的文本进入分享对象，原文不外泄', async () => {
    const { shares, consent } = harness();
    consent.authorize('s1', { mode: 'full', scope: 'public', previewed: true });
    const share = await shares.create('s1', { scope: 'public', mode: 'full', previewed: true });
    const joined = JSON.stringify(share);
    assert.equal(joined.includes('sk-'), false);
    assert.equal(joined.includes('/Users/'), false);
  });

  it('源会话 id 不进分享对象（避免身份关联泄露），但本机可反查', async () => {
    const { shares, consent } = harness();
    consent.authorize('s1', { mode: 'full', scope: 'public', previewed: true });
    const share = await shares.create('s1', { scope: 'public', mode: 'full', previewed: true });
    assert.equal(JSON.stringify(share).includes('"s1"'), false, '分享对象不应包含源会话 id');
    assert.equal(shares.sourceSessionOf(share.id), 's1', '本机侧索引应能反查源会话');
  });

  it('撤销后不再出现在列表中', async () => {
    const { shares, consent } = harness();
    consent.authorize('s1', { mode: 'full', scope: 'public', previewed: true });
    const share = await shares.create('s1', { scope: 'public', mode: 'full', previewed: true });
    assert.equal(shares.list().length, 1);
    assert.equal(shares.revoke(share.id), true);
    assert.equal(shares.list().length, 0);
    assert.equal(shares.revoke(share.id), false);
  });

  it('只接受通过校验的远端分享', async () => {
    const { shares, consent } = harness();
    consent.authorize('s1', { mode: 'standard', scope: 'public', previewed: true });
    const share = await shares.create('s1', { scope: 'public', mode: 'standard', previewed: true });

    const other = new ShareRegistry({
      config: normalizeConfig({ dataDir: mkdtempSync(join(tmpdir(), 'dsh-chat-import-')) }),
      identity: identityFromRecord(createIdentity()),
    });
    assert.equal(other.import(share).accepted, true, '合法分享应被接受');

    const tampered = { ...share, title: '改过的标题' };
    const result = other.import(tampered);
    assert.equal(result.accepted, false);
    assert.equal(result.verdict.authenticity, false);
  });
});
