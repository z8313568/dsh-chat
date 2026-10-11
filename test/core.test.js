/**
 * 基础层测试：稳定序列化、协议词汇、身份与签名、内容寻址、Merkle 根。
 *
 * 这一层是整条信任链的地基：稳定序列化错了，签名和内容哈希都会变成"看起来能用但不可靠"，
 * 所以这里对边界情况测得比功能测试更细。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canonicalJson, canonicalize } from '../src/shared/canonical.js';
import { formatFingerprint, isContentId, isPublicKeyId, randomId } from '../src/shared/protocol.js';
import {
  contentHashOf, createIdentity, fingerprintOfPublicKeyId, fingerprintOfRawPublicKey,
  identityFromRecord, verifyWithPublicKeyId,
} from '../src/host/identity.js';
import { merkleRoot } from '../src/host/share.js';

describe('canonicalJson', () => {
  it('键序不同的等价对象得到同一串字节', () => {
    const a = { b: 1, a: { d: 2, c: [3, 4] } };
    const b = { a: { c: [3, 4], d: 2 }, b: 1 };
    assert.equal(canonicalJson(a), canonicalJson(b));
    assert.equal(canonicalJson(a), '{"a":{"c":[3,4],"d":2},"b":1}');
  });

  it('数组顺序是有意义的，不会被排序', () => {
    assert.notEqual(canonicalJson({ x: [1, 2] }), canonicalJson({ x: [2, 1] }));
  });

  it('undefined 对象属性被丢弃，undefined 数组元素变 null（与 JSON.stringify 一致）', () => {
    assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
    assert.equal(canonicalJson({ a: [1, undefined, 2] }), '{"a":[1,null,2]}');
  });

  it('拒绝无法稳定表达的值，而不是静默转换', () => {
    assert.throws(() => canonicalJson({ n: Number.NaN }), /不是有限数字/);
    assert.throws(() => canonicalJson({ n: Number.POSITIVE_INFINITY }), /不是有限数字/);
    assert.throws(() => canonicalJson({ d: new Date() }), /Date/);
    assert.throws(() => canonicalJson({ f: () => {} }), /function/);
    assert.throws(() => canonicalJson({ big: 1n }), /bigint/);
  });

  it('类实例被拒绝，普通对象与 null 原型对象被接受', () => {
    class Foo { constructor() { this.x = 1; } }
    assert.throws(() => canonicalJson(new Foo()), /类实例/);
    const bare = Object.create(null);
    bare.x = 1;
    assert.equal(canonicalJson(bare), '{"x":1}');
  });

  it('canonicalize 返回深拷贝，改动结果不影响原对象', () => {
    const source = { a: { b: 1 } };
    const copy = canonicalize(source);
    copy.a.b = 2;
    assert.equal(source.a.b, 1);
  });
});

describe('身份与签名（Ed25519）', () => {
  it('生成的公钥标识自带算法前缀，指纹是 4×8 位分组', () => {
    const identity = createIdentity();
    assert.ok(isPublicKeyId(identity.publicKeyId), `公钥标识不合法: ${identity.publicKeyId}`);
    assert.match(identity.fingerprint, /^[0-9a-f]{8}(-[0-9a-f]{8}){3}$/);
    assert.equal(identity.algorithm, 'ed25519');
  });

  it('签名可被独立验签；改动任何字段都会失败', () => {
    const identity = identityFromRecord(createIdentity());
    const payload = { hello: '世界', list: [1, 2, { deep: true }] };
    const signature = identity.sign(payload);

    assert.ok(verifyWithPublicKeyId(identity.publicKeyId, payload, signature));
    assert.ok(identity.verify(payload, signature));
    // 键序不同但语义相同 → 仍然通过（这正是稳定序列化的作用）。
    assert.ok(verifyWithPublicKeyId(identity.publicKeyId, { list: [1, 2, { deep: true }], hello: '世界' }, signature));
    // 改内容 → 失败
    assert.equal(verifyWithPublicKeyId(identity.publicKeyId, { ...payload, hello: '世界!' }, signature), false);
    // 改签名 → 失败
    assert.equal(verifyWithPublicKeyId(identity.publicKeyId, payload, `${signature}x`), false);
    // 换身份验签 → 失败
    const other = identityFromRecord(createIdentity());
    assert.equal(verifyWithPublicKeyId(other.publicKeyId, payload, signature), false);
  });

  it('畸形输入返回 false 而不是抛错（验签路径必须容错）', () => {
    assert.equal(verifyWithPublicKeyId('not-a-key', { a: 1 }, 'sig'), false);
    assert.equal(verifyWithPublicKeyId('ed25519:short', { a: 1 }, 'sig'), false);
    assert.equal(verifyWithPublicKeyId('ed25519:' + 'A'.repeat(43), { a: 1 }, ''), false);
    assert.equal(verifyWithPublicKeyId('ed25519:' + 'A'.repeat(43), { a: 1 }, 'not-base64url!!'), false);
  });

  it('指纹可以从公钥标识反算，不需要完整身份记录', () => {
    const identity = createIdentity();
    const raw = Buffer.from(identity.publicKeyId.split(':')[1], 'base64url');
    assert.equal(fingerprintOfPublicKeyId(identity.publicKeyId), fingerprintOfRawPublicKey(raw));
    assert.equal(fingerprintOfPublicKeyId('bogus'), null);
  });

  it('身份记录可以往返导出与重建，且重建后签名一致可验', () => {
    const identity = identityFromRecord(createIdentity());
    const restored = identityFromRecord(identity.exportSecret());
    assert.equal(restored.publicKeyId, identity.publicKeyId);
    assert.equal(restored.fingerprint, identity.fingerprint);
    const signature = identity.sign({ a: 1 });
    assert.ok(restored.verify({ a: 1 }, signature), '同一私钥的另一个实例应能验证签名');
  });

  it('公钥导出记录里不含私钥材料', () => {
    const identity = identityFromRecord(createIdentity());
    const publicRecord = identity.exportPublicRecord();
    const text = JSON.stringify(publicRecord);
    assert.equal(text.includes('"d"'), false, '公钥记录不应含私钥分量 d');
    assert.ok(publicRecord.publicKeyId);
    assert.ok(publicRecord.publicJwk);
  });

  it('损坏的身份记录会被明确拒绝', () => {
    assert.throws(() => identityFromRecord(null), /身份记录必须是对象/);
    assert.throws(() => identityFromRecord({ publicKeyId: 'bad', secret: {} }), /publicKeyId 不合法/);
    assert.throws(() => identityFromRecord({ publicKeyId: 'ed25519:' + 'A'.repeat(43) }), /缺少密钥材料/);
  });
});

describe('内容寻址', () => {
  it('内容哈希稳定、带 b3: 前缀、键序无关', () => {
    const a = contentHashOf({ x: 1, y: [2, 3] });
    const b = contentHashOf({ y: [2, 3], x: 1 });
    assert.equal(a, b);
    assert.ok(isContentId(a), `内容标识不合法: ${a}`);
    assert.notEqual(a, contentHashOf({ x: 1, y: [3, 2] }));
  });
});

describe('Merkle 根', () => {
  const h1 = contentHashOf({ i: 1 });
  const h2 = contentHashOf({ i: 2 });
  const h3 = contentHashOf({ i: 3 });

  it('相同输入得到相同根，顺序不同得到不同根', () => {
    assert.equal(merkleRoot([h1, h2, h3]), merkleRoot([h1, h2, h3]));
    assert.notEqual(merkleRoot([h1, h2]), merkleRoot([h2, h1]));
  });

  it('任何一片叶子变化都会改变根', () => {
    assert.notEqual(merkleRoot([h1, h2, h3]), merkleRoot([h1, h2, contentHashOf({ i: 4 })]));
  });

  it('空列表有确定的根，不是 undefined', () => {
    const empty = merkleRoot([]);
    assert.ok(isContentId(empty));
    assert.equal(empty, contentHashOf([]));
  });

  it('单元素与奇数个元素都能算出确定结果', () => {
    assert.equal(merkleRoot([h1]), h1, '单叶子时根就是叶子本身');
    assert.equal(merkleRoot([h1, h2, h3]), merkleRoot([h1, h2, h3, h3]), '奇数时复制最后一个节点');
  });
});

describe('协议辅助', () => {
  it('指纹格式化只保留 16 进制并按 4 组显示', () => {
    assert.equal(formatFingerprint('AABBCCDD11223344aabbccdd55667788'), 'aabbccdd-11223344-aabbccdd-55667788');
    assert.equal(formatFingerprint('xyz'), '');
  });

  it('randomId 带前缀且足够随机', () => {
    const a = randomId('room');
    const b = randomId('room');
    assert.match(a, /^room_[0-9a-f]{24}$/);
    assert.notEqual(a, b);
  });
});
