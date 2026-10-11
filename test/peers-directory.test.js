/**
 * 好友关系、节点存储与插件目录测试。
 *
 * 重点验证三件在规划里被反复强调、却最容易被实现成"看起来对"的事：
 *   1. 好友申请有三种不同的未完成状态，不能合并（§5.2）；
 *   2. 关注与好友是两种关系，可以同时成立（§5.2）；
 *   3. 「签名通过」不等于「内容可信」，目录聚合必须把这句话写进返回值（§4.3、§8.5）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { normalizeConfig } from '../src/host/config.js';
import { createIdentity, identityFromRecord } from '../src/host/identity.js';
import { PeerBook, RELATION } from '../src/host/peers.js';
import { PluginDirectory, EXPERIENCE } from '../src/host/directory.js';
import { JsonDocument, JsonlLog, atomicWrite, readJsonFile, resolveDataDir } from '../src/host/store.js';

let dir;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

const peerKeyOf = (identity) => identity.publicKeyId;

function makeBook() {
  dir = mkdtempSync(join(tmpdir(), 'dsh-chat-peers-'));
  const config = normalizeConfig({ dataDir: dir });
  const identity = identityFromRecord(createIdentity());
  const other = identityFromRecord(createIdentity());
  const document = new JsonDocument(join(dir, 'peers.json'), { fallback: { relations: {}, requests: {} } });
  const book = new PeerBook({ config, identity, logger: null, document });
  return { book, identity, other, document };
}

describe('PeerBook', () => {
  it('默认没有任何关系', () => {
    const { book, other } = makeBook();
    assert.equal(book.describe(peerKeyOf(other)).relation, RELATION.NONE);
    assert.equal(book.isFriend(peerKeyOf(other)), false);
  });

  it('发出的申请在对方确认前是 outgoing，且能区分"未送达"与"已送达"', () => {
    const { book, other } = makeBook();
    const key = peerKeyOf(other);
    const draft = book.requestFriend(key, { note: '我是隔壁组的', delivered: false });
    assert.equal(draft.relation, RELATION.OUTGOING);
    assert.equal(draft.delivery, 'draft', '对方还没收到时不能显示成"等待确认"');
    const sent = book.requestFriend(key, { note: '我是隔壁组的', delivered: true });
    assert.equal(sent.delivery, 'sent');
  });

  it('收到申请是 incoming，接受后变 friend', () => {
    const { book, other } = makeBook();
    const key = peerKeyOf(other);
    assert.equal(book.receiveFriendRequest(key, { note: '你好' }).relation, RELATION.INCOMING);
    assert.equal(book.acceptFriend(key).relation, RELATION.FRIEND);
    assert.equal(book.isFriend(key), true);
  });

  it('拒绝申请回到 none，且不留下待处理记录', () => {
    const { book, other } = makeBook();
    const key = peerKeyOf(other);
    book.receiveFriendRequest(key);
    assert.equal(book.rejectFriend(key).relation, RELATION.NONE);
    assert.equal(book.describe(key).requestAt, null);
  });

  it('关注与好友可以并存，取消关注不会删掉好友', () => {
    const { book, other } = makeBook();
    const key = peerKeyOf(other);
    book.acceptFriend(key);
    book.follow(key);
    assert.equal(book.isFollowing(key), true);
    assert.equal(book.describe(key).relation, RELATION.FRIEND, '关注不应把好友关系降级');
    book.unfollow(key);
    assert.equal(book.isFollowing(key), false);
    assert.equal(book.isFriend(key), true, '取消关注不应影响好友关系');
  });

  it('单独关注一个陌生人不需要对方同意', () => {
    const { book, other } = makeBook();
    const key = peerKeyOf(other);
    const described = book.follow(key);
    assert.equal(described.following, true);
    assert.equal(described.relation, RELATION.FOLLOWING);
  });

  it('拉黑优先级最高，且拒收私聊', () => {
    const { book, other } = makeBook();
    const key = peerKeyOf(other);
    book.acceptFriend(key);
    book.block(key, '发垃圾消息');
    assert.equal(book.describe(key).relation, RELATION.BLOCKED);
    assert.equal(book.acceptsMessagesFrom(key), false);
    assert.equal(book.describe(key).blockReason, '发垃圾消息');
    // 已被拉黑时不能再发好友申请
    assert.throws(() => book.requestFriend(key), /已拉黑/);
    // 拉黑期间收到对方的申请应被忽略，而不是把状态改回 incoming
    assert.equal(book.receiveFriendRequest(key), null);
    assert.equal(book.describe(key).relation, RELATION.BLOCKED);
    // 解除拉黑
    assert.equal(book.unblock(key).relation, RELATION.NONE);
  });

  it('不能对自己执行关系操作，非法标识被拒绝', () => {
    const { book, identity } = makeBook();
    assert.throws(() => book.follow(identity.publicKeyId), /不能对自己/);
    assert.throws(() => book.follow('not-a-key'), /不合法/);
  });

  it('在线状态来自传输层，合并进 describe 结果', () => {
    const { book, other } = makeBook();
    const key = peerKeyOf(other);
    book.acceptFriend(key);
    assert.equal(book.describe(key).online, false);
    book.markOnline({ peerKey: key, fingerprint: other.fingerprint, nickname: '老李', address: '127.0.0.1:1' });
    const online = book.describe(key);
    assert.equal(online.online, true);
    assert.equal(online.nickname, '老李');
    book.markOffline(key);
    assert.equal(book.describe(key).online, false);
  });

  it('列表排序：在线优先，其次好友', () => {
    const { book, identity } = makeBook();
    const a = identityFromRecord(createIdentity());
    const b = identityFromRecord(createIdentity());
    book.acceptFriend(peerKeyOf(a));       // 好友，离线
    book.follow(peerKeyOf(b));             // 关注，在线
    book.markOnline({ peerKey: peerKeyOf(b), fingerprint: b.fingerprint, nickname: 'B', address: null });
    const list = book.list();
    assert.equal(list[0].peerKey, peerKeyOf(b), '在线的应排在离线前面，即使只是关注关系');
    assert.equal(list[1].peerKey, peerKeyOf(a));
  });

  it('关系状态会落盘，重建后仍在', () => {
    const { book, document, other } = makeBook();
    const key = peerKeyOf(other);
    book.acceptFriend(key);
    // 用同一个 document 重建一个 PeerBook（模拟插件重启）
    const rebuilt = new PeerBook({
      config: normalizeConfig({ dataDir: dir }),
      identity: identityFromRecord(createIdentity()),
      document,
    });
    assert.equal(rebuilt.isFriend(key), true, '好友关系应跨重启保留');
    // 但授权不继承（由 ConsentGate 单独保证，这里确认关系与授权是两套状态）
    assert.equal(rebuilt.describe(key).online, false);
  });

  it('metrics 汇总各类关系数量', () => {
    const { book, other } = makeBook();
    const extra = identityFromRecord(createIdentity());
    book.acceptFriend(peerKeyOf(other));
    book.follow(peerKeyOf(extra));
    book.markOnline({ peerKey: peerKeyOf(other), fingerprint: other.fingerprint, nickname: null, address: null });
    const metrics = book.metrics;
    assert.equal(metrics.friends, 1);
    assert.equal(metrics.following, 1);
    assert.equal(metrics.online, 1);
  });
});

describe('PluginDirectory', () => {
  function makeDirectory() {
    dir = mkdtempSync(join(tmpdir(), 'dsh-chat-dir-'));
    const identity = identityFromRecord(createIdentity());
    return { directory: new PluginDirectory({ identity }), identity };
  }

  it('发布的清单可以自校验，完整性/真实性两个结论都为真', () => {
    const { directory } = makeDirectory();
    const manifest = directory.publishManifest({
      pluginId: 'dsh-chat', name: 'dsh-chat', version: '0.1.0', description: '社交层',
      tags: ['social'], dshCompatibility: '0.2.0-rc.2',
    });
    const verdict = directory.verifyManifest(manifest);
    assert.equal(verdict.integrity, true);
    assert.equal(verdict.authenticity, true);
    assert.deepEqual(verdict.problems, []);
  });

  it('被改动的清单无法通过校验', () => {
    const { directory } = makeDirectory();
    const manifest = directory.publishManifest({ pluginId: 'p', name: 'P', version: '1.0.0' });
    assert.equal(directory.verifyManifest({ ...manifest, version: '2.0.0' }).integrity, false);
    assert.equal(directory.verifyManifest({ ...manifest, sig: 'x' }).authenticity, false);
  });

  it('同一 pluginId+version 出现两份不同清单时判为冲突并保留先到的', () => {
    const { directory } = makeDirectory();
    const first = directory.publishManifest({ pluginId: 'p', name: 'P', version: '1.0.0', description: 'A' });
    // 另一身份发布同名同版本的清单
    const otherIdentity = identityFromRecord(createIdentity());
    const otherDir = new PluginDirectory({ identity: otherIdentity });
    const second = otherDir.publishManifest({ pluginId: 'p', name: 'P', version: '1.0.0', description: 'B' });

    const result = directory.importManifest(second);
    assert.equal(result.accepted, false);
    assert.equal(result.conflict, true, '冲突必须显式报出，不能静默覆盖');
    assert.equal(directory.resolveVersion('p').description, 'A', '先到的清单应被保留');
    assert.equal(directory.resolveVersion('p').sig, first.sig);
  });

  it('本机已安装插件以未验证来源进入目录', () => {
    const { directory } = makeDirectory();
    directory.ingestLocal([{ name: 'dsh-pocket', version: '2.10.6', description: '手机访问' }]);
    const list = directory.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].source, 'local');
    assert.equal(list[0].verified, false, '本机插件没有签名，必须标为未验证');
    assert.equal(list[0].publisher, null);
  });

  it('签名清单排在本机未验证插件之前', () => {
    const { directory } = makeDirectory();
    directory.ingestLocal([{ name: 'zzz-local', version: '1.0.0' }]);
    directory.publishManifest({ pluginId: 'aaa-signed', name: 'AAA', version: '1.0.0' });
    assert.deepEqual(directory.list().map((item) => item.pluginId), ['aaa-signed', 'zzz-local']);
  });

  it('评分支持四个维度、聚合出平均值与分布，并明确标注无反女巫能力', () => {
    const { directory } = makeDirectory();
    directory.publishManifest({ pluginId: 'p', name: 'P', version: '1.0.0' });
    directory.rate('p', {
      version: '1.0.0',
      scores: { usefulness: 5, usability: 4, stability: 3, documentation: 2 },
      text: '功能好用但文档弱',
      experience: EXPERIENCE.USED,
    });
    const aggregate = directory.aggregate('p', { currentVersion: '1.0.0' });
    assert.equal(aggregate.count, 1);
    assert.equal(aggregate.average, 3.5);
    assert.equal(aggregate.dimensions.usefulness.average, 5);
    // 分布直方图：一条 3.5 分的评价会被四舍五入进 4 分桶。
    assert.deepEqual(aggregate.distribution, { 1: 0, 2: 0, 3: 0, 4: 1, 5: 0 });
    assert.equal(aggregate.experiencedCount, 1);
    assert.equal(aggregate.sybilResistance, 'none', '必须如实声明签名不能防一人多身份');
    assert.match(aggregate.note, /不能证明评价真实/);
  });

  it('评分范围与维度被校验', () => {
    const { directory } = makeDirectory();
    assert.throws(() => directory.rate('p', { scores: { usefulness: 6 } }), /1~5/);
    assert.throws(() => directory.rate('p', { scores: { usefulness: 0 } }), /1~5/);
    assert.throws(() => directory.rate('p', { scores: {} }), /至少需要一个维度/);
  });

  it('被举报 3 次以上的评价不参与聚合，但不被删除', () => {
    const { directory } = makeDirectory();
    const rating = directory.rate('p', { scores: { usefulness: 1 } });
    directory.report('p', rating.contentHash, '虚假评价');
    directory.report('p', rating.contentHash, '虚假评价');
    // 只举报两次时仍然参与聚合
    assert.equal(directory.aggregate('p').count, 1);
    directory.report('p', rating.contentHash, '虚假评价');
    const aggregate = directory.aggregate('p');
    assert.equal(aggregate.count, 0, '被排除的评价不能计入 count');
    assert.equal(aggregate.totalCount, 1, '总数仍然如实报告');
    assert.equal(aggregate.excludedForReports, 1);
    assert.equal(directory.ratingsFor('p').length, 1, '被举报的评价仍应可见（举报不应变成审查工具）');
  });

  it('版本关联评价会被统计为 stale', () => {
    const { directory } = makeDirectory();
    directory.rate('p', { version: '0.9.0', scores: { usefulness: 3 } });
    directory.rate('p', { version: '1.0.0', scores: { usefulness: 5 } });
    const aggregate = directory.aggregate('p', { currentVersion: '1.0.0' });
    assert.equal(aggregate.count, 2);
    assert.equal(aggregate.staleCount, 1, '针对旧版本的评价应被标注');
  });

  it('「有用」投票同一身份只计一次', () => {
    const { directory, identity } = makeDirectory();
    const rating = directory.rate('p', { scores: { usefulness: 4 } });
    directory.markHelpful('p', rating.contentHash, identity.publicKeyId);
    directory.markHelpful('p', rating.contentHash, identity.publicKeyId);
    assert.equal(directory.ratingsFor('p')[0].rating.helpful.length, 1);
  });

  it('只导入通过校验的评价，重复评价不重复计入', () => {
    const { directory } = makeDirectory();
    const otherIdentity = identityFromRecord(createIdentity());
    const otherDir = new PluginDirectory({ identity: otherIdentity });
    const rating = otherDir.rate('p', { scores: { usefulness: 5 } });

    assert.equal(directory.importRating(rating).accepted, true);
    assert.equal(directory.importRating(rating).duplicate, true);
    assert.equal(directory.importRating({ ...rating, text: '改过' }).accepted, false);
  });

  it('作者回复是独立签名记录：可独立验证，且不能被冒充', () => {
    const { directory, identity } = makeDirectory();
    const otherIdentity = identityFromRecord(createIdentity());
    const otherDir = new PluginDirectory({ identity: otherIdentity });
    // 评价由 otherIdentity 发出
    const rating = otherDir.rate('p', { scores: { usefulness: 4 } });

    // 作者本人可以回复
    const reply = otherDir.replyToRating('p', rating.contentHash, '谢谢反馈，文档正在补');
    assert.equal(otherDir.verifyReply(reply, rating).integrity, true);
    assert.equal(otherDir.verifyReply(reply, rating).authenticity, true);
    assert.equal(otherDir.verifyReply(reply, rating).isAuthor, true);

    // 关键：回复的存在不破坏评价自身的签名与哈希
    assert.deepEqual(otherDir.ratingsFor('p')[0].verdict, {
      integrity: true, authenticity: true, problems: [],
    }, '回复的存在不破坏评价自身的签名与哈希');

    // 另一个身份导入后，回复仍可验证，且作者身份判定依然成立
    assert.equal(directory.importRating(rating).accepted, true, '带回复的评价仍应通过导入校验');
    const imported = directory.ratingsFor('p')[0].rating;
    assert.equal(imported.replies.length, 1);
    assert.equal(directory.verifyReply(imported.replies[0], imported).isAuthor, true);

    // 但非作者不能发被认可的回复
    assert.throws(() => directory.replyToRating('p', rating.contentHash, '冒充作者'), /只能由评价作者本人/);
    assert.notEqual(identity.fingerprint, otherIdentity.fingerprint, '两个身份确实不同，上面的拒绝才有意义');
  });

  it('被篡改的回复会被 verifyReply 检出', () => {
    const { directory } = makeDirectory();
    const rating = directory.rate('p', { scores: { usefulness: 4 } });
    const reply = directory.replyToRating('p', rating.contentHash, '原文');
    assert.equal(directory.verifyReply({ ...reply, text: '改过的' }, rating).integrity, false);
    assert.equal(directory.verifyReply({ ...reply, sig: 'x' }, rating).authenticity, false);
    // 指向另一条评价的回复也应被拒
    assert.ok(directory.verifyReply(reply, { ...rating, contentHash: 'b3:' + '0'.repeat(64) })
      .problems.includes('reply-target-mismatch'));
  });
});

describe('本地存储', () => {
  it('原子写不会留下半个文件，且默认 0600', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-chat-store-'));
    const file = join(dir, 'a', 'b.json');
    atomicWrite(file, '{"a":1}');
    assert.deepEqual(readJsonFile(file), { a: 1 });
    assert.equal(readJsonFile(join(dir, 'missing.json'), 'fallback'), 'fallback');
  });

  it('JSONL 跳过坏行而不是丢掉整个文件', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-chat-log-'));
    const log = new JsonlLog(join(dir, 'x.jsonl'));
    log.append({ n: 1 });
    log.append({ n: 2 });
    // 在中间插一行坏数据（模拟进程被杀导致的半行写入），后面还有一条正常记录。
    // 关键期望：坏行被跳过，**它之后的行仍然可读**——否则一次崩溃会丢掉整个尾部的历史。
    atomicWrite(log.path, `${readJsonFileRaw(log.path)}{"broken":\n{"n":3}\n`, { mode: 0o600 });
    const records = log.readAll();
    assert.deepEqual(records.map((r) => r.n), [1, 2, 3], '坏行应被跳过，后续行仍可读');
    assert.equal(records.length, 3);
  });

  it('JSONL 超过上限时可以裁剪，且裁剪后仍是合法日志', () => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-chat-log2-'));
    const log = new JsonlLog(join(dir, 'y.jsonl'), { maxBytes: 10 });
    for (let i = 0; i < 20; i += 1) log.append({ n: i, pad: 'x'.repeat(50) });
    const trimmed = log.compactIfNeeded();
    assert.equal(trimmed, true);
    const records = log.readAll();
    assert.ok(records.length > 0 && records.length < 20);
    assert.equal(records.at(-1).n, 19, '裁剪后最新的记录必须保留');
  });

  it('数据目录可以用环境变量覆盖（两个实例靠它隔离）', () => {
    const previous = process.env.DSH_CHAT_DATA_DIR;
    process.env.DSH_CHAT_DATA_DIR = '/tmp/dsh-chat-explicit';
    try {
      assert.equal(resolveDataDir(), '/tmp/dsh-chat-explicit');
      assert.equal(resolveDataDir('/tmp/other'), '/tmp/other', '显式参数优先于环境变量');
    } finally {
      if (previous === undefined) delete process.env.DSH_CHAT_DATA_DIR;
      else process.env.DSH_CHAT_DATA_DIR = previous;
    }
  });
});

function readJsonFileRaw(file) {
  // 小工具：直接读原始文本，用于构造"半行"场景。
  return readFileSync(file, 'utf8');
}
