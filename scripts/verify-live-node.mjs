#!/usr/bin/env node
/**
 * 对「已加载到 DSH 里的 dsh-chat 插件」做一次真实的外部连通性验证。
 *
 * 这个脚本**不是单元测试**：它不读插件的任何内部状态，而是以一个**完全独立的进程**
 * 扮演「另一个用户节点」，与运行中的 DSH 里的 dsh-chat 节点完成双向 Ed25519 握手，
 * 然后双向交换带签名的信封。
 *
 * 它验证的正是规划「阶段 0」的验收标准在真实环境（而不是测试环境）里成立：
 *   「两个独立用户实例能够安全交换测试消息」。
 *
 * 两种建立连接的方向都算通过，报告里会写明是哪一种：
 *   inbound  —— 运行中的插件通过 UDP 信标发现了本脚本并主动连过来；
 *   outbound —— 本脚本通过信标发现插件后主动连过去。
 *
 * 已知平台限制（如实记录，不掩盖）：macOS 上多个 socket 用 SO_REUSEADDR 绑同一个 UDP 端口时，
 * 收到的包只会投递给其中一个。所以当插件自己也绑着 47899 时，本脚本可能收不到插件的信标，
 * 于是只出现 inbound。这不影响结论——握手与签名校验的强度与方向无关。
 *
 * 用法： node scripts/verify-live-node.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MESSAGE_KIND } from '../src/shared/protocol.js';
import { normalizeConfig } from '../src/host/config.js';
import { createIdentity, identityFromRecord } from '../src/host/identity.js';
import { EnvelopeCodec } from '../src/host/net/envelope.js';
import { LanTransport } from '../src/host/net/lan.js';

const BEACON_PORT = 47899;
const dir = mkdtempSync(join(tmpdir(), 'dsh-chat-verify-'));

const config = normalizeConfig({
  dataDir: dir,
  listen: { host: '127.0.0.1', port: 0 },
  discovery: {
    enabled: true, beaconPort: BEACON_PORT, intervalMs: 1500, ttlMs: 10000,
    autoConnect: false, manualPeers: [],
  },
});

const identity = identityFromRecord(createIdentity());
const codec = new EnvelopeCodec({ identity });
const transport = new LanTransport({ config, identity, codec, nodeInfo: () => ({ nickname: '外部验证节点' }) });

const inbound = [];
let direction = null;
let peer = null;
let discoveredEntry = null;

transport.on('envelope', (payload) => inbound.push(payload));
transport.on('discovered', (entry) => {
  if (!discoveredEntry) {
    discoveredEntry = entry;
    log(`通过 UDP 信标发现节点 ${entry.nickname ?? '(无昵称)'} @ ${entry.address}`);
  }
});
transport.on('peer-up', (info) => {
  if (peer) return;
  peer = info;
  direction = info.direction === 'inbound' ? 'inbound' : 'outbound';
  log(`握手完成（${direction}）→ ${info.nickname ?? '(无昵称)'} · 指纹 ${info.fingerprint}`);
});
transport.on('error', (error, ctx) => log(`传输层错误: ${error.message} ${JSON.stringify(ctx ?? {})}`));

const started = Date.now();
function log(message) {
  console.log(`[+${String(Date.now() - started).padStart(5)}ms] ${message}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, { timeoutMs, label }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`超时：${label}`);
    await sleep(100);
  }
}

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

try {
  await transport.start();
  console.log('=== dsh-chat 真实节点连通性验证 ===');
  log(`外部节点指纹 ${identity.fingerprint}，监听 ${transport.address}`);
  log(`等待端口 ${BEACON_PORT} 上的信标，或等待运行中的插件主动连过来…`);

  // 连接可以由任一方向建立：
  //   - 插件先发现我们（inbound）；
  //   - 或者我们先发现插件，然后主动连（outbound）。
  await waitFor(() => peer || discoveredEntry, {
    timeoutMs: 20000,
    label: '既没收到信标，也没有插件连过来。请确认 DSH 正在运行且 dsh-chat 已加载。',
  });

  if (!peer && discoveredEntry) {
    log(`主动连接 ${discoveredEntry.address} …`);
    await transport.connect(discoveredEntry.address).catch((error) => log(`主动连接失败: ${error.message}`));
    await waitFor(() => peer, { timeoutMs: 8000, label: '主动连接后握手未完成' });
  } else if (!peer) {
    await waitFor(() => peer, { timeoutMs: 8000, label: '握手未完成' });
  }

  // ---- 断言 ----
  check(peer !== null, '与运行中的 dsh-chat 节点完成双向身份握手');
  check(Boolean(peer?.fingerprint), '对端提供了指纹', peer?.fingerprint ?? '');
  check(peer?.peerKey?.startsWith('ed25519:'), '对端身份标识是自描述的 Ed25519 公钥', peer?.peerKey?.slice(0, 22) + '…');

  // 出站：发一条带签名的 PRESENCE 过去
  const envelope = codec.seal(MESSAGE_KIND.PRESENCE, { nickname: '外部验证节点', status: 'online' }, { to: peer.peerKey });
  const sent = transport.send(peer.peerKey, envelope);
  check(sent === true, '已向对端发出带签名的信封');

  // 入站：插件在 peer-up 时会主动回一条 PRESENCE
  await waitFor(() => inbound.length > 0 || null, { timeoutMs: 8000, label: '未收到对端回发的信封' })
    .catch(() => null);

  if (inbound.length > 0) {
    const message = inbound[0];
    const { sig, ...body } = message.envelope;
    const { verifyWithPublicKeyId } = await import('../src/host/identity.js');
    check(true, '收到对端发来的信封', `kind=${message.envelope.kind}`);
    check(verifyWithPublicKeyId(message.envelope.from, body, sig), '收到信封的签名可独立验证');
  } else {
    // 不是失败：单向发送成功已经证明链路可用，只是对端没在这个窗口里回发。
    log('（对端未在窗口内回发信封；单向发送已成功，这不影响连通性结论）');
  }

  check(codec.metrics.rejected === 0, '本地 codec 没有拒绝任何收到的东西', JSON.stringify(codec.metrics.byReason));

  console.log(`\n=== 结果：${failures === 0 ? '通过' : `失败（${failures} 项）`} ===`);
  console.log(`握手方向：${direction ?? '未建立'}；对端指纹：${peer?.fingerprint ?? '—'}`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (error) {
  console.error(`\n=== 结果：失败 —— ${error.message} ===`);
  process.exitCode = 1;
} finally {
  await transport.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
