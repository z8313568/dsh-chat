/**
 * 授权门与脱敏测试。
 *
 * 这两块是插件的隐私核心，所以测试的重点不是"正常路径能过"，
 * 而是**所有绕过路径都不能过**：没有授权、粒度不够、内容没勾选、预览没做、
 * 脱敏失败、超范围发送——每一条都必须被拒绝，且拒绝要 fail-closed。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeConfig } from '../src/host/config.js';
import { ConsentError, ConsentGate } from '../src/host/consent.js';
import { RedactionPipeline, createRedactionPipeline, scrubPathsIn, scrubSecretsIn } from '../src/host/redaction.js';
import { JsonlLog } from '../src/host/store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeGate(overrides = {}) {
  const config = normalizeConfig({ dataDir: mkdtempSync(join(tmpdir(), 'dsh-chat-consent-')), ...overrides });
  return new ConsentGate({ config });
}

describe('授权门 ConsentGate', () => {
  it('默认什么都不放行（fail-closed）', () => {
    const gate = makeGate();
    assert.equal(gate.isAuthorized('s1'), false);
    const verdict = gate.check('s1', 'answer');
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, 'no-grant');
    assert.throws(() => gate.assert('s1', 'answer'), ConsentError);
  });

  it('没有预览就不给授权（规划 §7.2 开播前预览是硬前置）', () => {
    const gate = makeGate();
    assert.throws(
      () => gate.authorize('s1', { mode: 'standard' }),
      (error) => error instanceof ConsentError && error.detail.reason === 'preview-required',
    );
  });

  it('粒度上限压在用户勾选之上：勾了 tool 也拿不到 tool（standard 不允许）', () => {
    const gate = makeGate();
    const grant = gate.authorize('s1', {
      mode: 'standard',
      contentKinds: ['prompt', 'answer', 'tool', 'reasoning'],
      previewed: true,
    });
    assert.deepEqual([...grant.contentKinds].sort(), ['answer', 'prompt']);
    assert.equal(gate.check('s1', 'tool').allowed, false);
    assert.equal(gate.check('s1', 'reasoning').allowed, false);
    assert.equal(gate.check('s1', 'answer').allowed, true);
  });

  it('全勾但没勾到任何允许项时拒绝授权，而不是给一个空授权', () => {
    const gate = makeGate();
    assert.throws(
      () => gate.authorize('s1', { mode: 'standard', contentKinds: ['tool'], previewed: true }),
      ConsentError,
    );
  });

  it('粒度设为 disabled 时无法授权', () => {
    const gate = makeGate();
    assert.throws(
      () => gate.authorize('s1', { mode: 'disabled', previewed: true }),
      (error) => error.detail?.reason === 'mode-disabled',
    );
  });

  it('不能申请比授权更宽的发送范围', () => {
    const gate = makeGate();
    gate.authorize('s1', { mode: 'standard', scope: 'friends', previewed: true });
    assert.equal(gate.check('s1', 'answer', { scope: 'friends' }).allowed, true);
    assert.equal(gate.check('s1', 'answer', { scope: 'public' }).allowed, false);
    assert.equal(gate.check('s1', 'answer', { scope: 'public' }).reason, 'scope-exceeds-grant');
    // 更严的范围始终可以
    assert.equal(gate.check('s1', 'answer', { scope: 'self' }).allowed, true);
  });

  it('撤销之后立即不再放行', () => {
    const gate = makeGate();
    gate.authorize('s1', { mode: 'full', previewed: true });
    assert.equal(gate.check('s1', 'tool').allowed, true);
    assert.equal(gate.revoke('s1'), true);
    assert.equal(gate.check('s1', 'tool').allowed, false);
    assert.equal(gate.revoke('s1'), false, '重复撤销返回 false');
  });

  it('过期授权被当作不存在，并顺手清理', () => {
    const gate = makeGate();
    gate.authorize('s1', { mode: 'full', previewed: true, ttlMs: 1 });
    const wait = Date.now() + 5;
    while (Date.now() < wait) { /* 忙等到过期 */ }
    assert.equal(gate.grantFor('s1'), null);
    assert.equal(gate.listGrants().length, 0);
  });

  it('一键撤销全部授权', () => {
    const gate = makeGate();
    gate.authorize('s1', { mode: 'full', previewed: true });
    gate.authorize('s2', { mode: 'full', previewed: true });
    assert.equal(gate.revokeAll(), 2);
    assert.equal(gate.listGrants().length, 0);
  });

  it('授权变化会通知订阅者，撤销也会', () => {
    const gate = makeGate();
    let changes = 0;
    gate.onChange(() => { changes += 1; });
    gate.authorize('s1', { mode: 'full', previewed: true });
    gate.revoke('s1');
    assert.equal(changes, 2);
  });

  it('审计日志记录了授权与撤销，但不记录会话正文', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-chat-audit-'));
    try {
      const config = normalizeConfig({ dataDir: dir });
      const log = new JsonlLog(join(dir, 'audit.jsonl'));
      const gate = new ConsentGate({ config, auditLog: log });
      gate.authorize('s1', { mode: 'standard', previewed: true });
      gate.revoke('s1', 'test');
      const records = log.readAll();
      assert.deepEqual(records.map((r) => r.action), ['authorize', 'revoke']);
      assert.equal(JSON.stringify(records).includes('text'), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('非法输入被明确拒绝', () => {
    const gate = makeGate();
    assert.throws(() => gate.authorize('', { mode: 'full', previewed: true }), /sessionId/);
    assert.throws(() => gate.authorize('s1', { mode: 'nope', previewed: true }), /未知外发粒度/);
    assert.throws(() => gate.authorize('s1', { mode: 'full', scope: 'nope', previewed: true }), /未知访问范围/);
    assert.equal(gate.check('s1', 'not-a-kind').allowed, false);
  });
});

describe('脱敏路径规则', () => {
  it('绝对路径收敛成 …/basename，保留可读性', () => {
    const { text, hits } = scrubPathsIn('文件在 /Users/twoants/secret/project/config.yaml 里', null);
    assert.equal(text, '文件在 …/config.yaml 里');
    assert.equal(hits.length, 1);
  });

  it('URL 不会被误伤（这是最容易写错的一条）', () => {
    const input = '参考 https://example.com/docs/api/v1/spec 和 http://a.b/c/d';
    const { text } = scrubPathsIn(input, null);
    assert.equal(text, input, 'URL 必须原样保留');
  });

  it('带引号的路径、赋值路径仍会被收敛', () => {
    assert.match(scrubPathsIn('"/var/log/app/error.log"', null).text, /…\/error\.log/);
    assert.match(scrubPathsIn('config=/etc/nginx/nginx.conf', null).text, /…\/nginx\.conf/);
  });

  it('Windows 路径同样处理', () => {
    const { text } = scrubPathsIn('C:\\Users\\bob\\Desktop\\secret.txt', null);
    assert.match(text, /…\/secret\.txt/);
  });

  it('已知主目录会被优先替换并按 ~ 展示', () => {
    const { text } = scrubPathsIn('在 /home/bob/work/notes.md 中', '/home/bob');
    assert.match(text, /^在 ~\/…\/notes\.md 中$/);
  });
});

describe('脱敏凭据规则', () => {
  it('识别 sk- 密钥、GitHub token、AWS key、Bearer、PEM 私钥', () => {
    const cases = [
      'sk-abcdefghijklmnopqrstuvwx',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'AKIAIOSFODNN7EXAMPLE',
      'Bearer abcdefghijklmnopqrstuvwxyz',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----',
    ];
    for (const sample of cases) {
      const { text, hits } = scrubSecretsIn(`前缀 ${sample} 后缀`);
      assert.ok(hits.length >= 1, `未识别: ${sample}`);
      assert.match(text, /\[已脱敏:/, `未替换: ${sample}`);
    }
  });

  it('key = value 形式的赋值也会被打码', () => {
    const { text } = scrubSecretsIn('api_key = "abcdefghijklmnop"');
    assert.match(text, /已脱敏/);
  });
});

describe('脱敏流水线 RedactionPipeline', () => {
  it('规则抛错时 fail-closed 扣下整条记录，而不是放行原文', () => {
    const pipeline = new RedactionPipeline();
    pipeline.use(() => { throw new Error('规则内部错误'); });
    const result = pipeline.apply({ text: '敏感原文' });
    assert.equal(result.withheld, true);
    assert.equal(result.value, null, '扣下时不能保留任何载荷');
    assert.ok(result.reasons.includes('rule-error'));
  });

  it('规则返回 undefined 表示显式扣下', () => {
    const pipeline = new RedactionPipeline();
    pipeline.use(() => undefined);
    assert.equal(pipeline.apply({ text: 'x' }).withheld, true);
  });

  it('按配置装配的默认规则链会同时脱敏路径与凭据，并记账原因', () => {
    const config = normalizeConfig({
      dataDir: mkdtempSync(join(tmpdir(), 'dsh-chat-red-')),
      privacy: { redaction: { scrubPaths: true, scrubSecrets: true, keywords: ['内部代号'], patterns: ['SECRET-\\d+'], } },
    });
    const pipeline = createRedactionPipeline({ config });
    const result = pipeline.apply({
      text: 'sk-abcdefghijklmnopqrstuvwx 在 /Users/bob/x/y.md，内部代号 Orion，令牌 SECRET-42',
      nested: { deep: ['/etc/passwd', 'plain'] },
    });
    assert.equal(result.withheld, false);
    assert.equal(result.changed, true);
    assert.ok(result.reasons.includes('path'));
    assert.ok(result.reasons.includes('secret'));
    assert.ok(result.reasons.includes('keyword'));
    assert.ok(result.reasons.includes('pattern'));
    const text = result.value.text;
    assert.equal(text.includes('sk-abcdefghijklmnopqrstuvwx'), false);
    assert.equal(text.includes('内部代号 Orion'), false);
    assert.equal(text.includes('SECRET-42'), false);
    assert.match(result.value.nested.deep[0], /…\/passwd/);
    assert.equal(result.value.nested.deep[1], 'plain', '不匹配的内容不应被改动');
  });

  it('形如 privateKey / token 的字段被整体打掉', () => {
    const config = normalizeConfig({ dataDir: mkdtempSync(join(tmpdir(), 'dsh-chat-red2-')) });
    const pipeline = createRedactionPipeline({ config });
    const result = pipeline.apply({ privateKey: 'AAAA', token: 'BBBB', keep: 'CCCC' });
    assert.equal(result.value.keep, 'CCCC');
    assert.match(result.value.privateKey, /已脱敏/);
    assert.match(result.value.token, /已脱敏/);
  });

  it('关闭全部规则时流水线不改动任何东西', () => {
    const config = normalizeConfig({
      dataDir: mkdtempSync(join(tmpdir(), 'dsh-chat-red3-')),
      privacy: { redaction: { scrubPaths: false, scrubSecrets: false, keywords: [], patterns: [] } },
    });
    const pipeline = createRedactionPipeline({ config });
    assert.equal(pipeline.ruleCount, 0);
    const payload = { text: 'sk-abcdefghijklmnopqrstuvwx' };
    const result = pipeline.apply(payload);
    assert.equal(result.changed, false);
    assert.deepEqual(result.value, payload);
  });
});
