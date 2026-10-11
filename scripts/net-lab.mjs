#!/usr/bin/env node
/**
 * 网络实验台（net-lab）——用来在**真实多台设备**上测 dsh-chat 的节点网络。
 *
 * 自动化测试只能在一台机器上跑；真实世界的"不同网络"（跨网段、跨运营商、NAT 后面、
 * 移动网络）必须用真实设备。这个脚本就是把那些场景变成可执行、可比较的实验：
 * 一台设备 `serve`，另一台 `dial`，输出握手段耗时、往返时延分布、丢包与数据完整性。
 *
 * 它直接用插件自己的传输层（`LanTransport` + 信封签名），所以测出来的数字
 * 就是插件实际会遇到的数字，不是另写一套简化协议。
 *
 * 用法：
 *   # 设备一（监听方）
 *   node scripts/net-lab.mjs serve --host 0.0.0.0 --port 47800 --name 客厅台式机
 *
 *   # 设备二（拨号方）—— 用上面打印的邀请码或 host:port
 *   node scripts/net-lab.mjs dial 'dshchat1:...' --count 200 --size 512
 *
 *   # 只做发现探测（不发业务数据，只看能不能互相看见）
 *   node scripts/net-lab.mjs probe --seconds 15
 *
 * 需要越过真实 NAT 时，先在路由器上把 `--port` 做端口映射，再用公网 IP 拨号；
 * 或者用 `probe` 确认双方是否能在同一广播域内互相发现。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { MESSAGE_KIND } from '../src/shared/protocol.js';
import { normalizeConfig } from '../src/host/config.js';
import { createIdentity, identityFromRecord } from '../src/host/identity.js';
import { EnvelopeCodec } from '../src/host/net/envelope.js';
import { LanTransport } from '../src/host/net/lan.js';
import { listAllAddresses } from './net-lab-util.mjs';

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { _: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token.startsWith('--')) {
      const [key, inline] = token.slice(2).split('=');
      if (inline !== undefined) options[key] = inline;
      else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith('--')) options[key] = rest[++i];
      else options[key] = true;
    } else {
      options._.push(token);
    }
  }
  return { command, options };
}

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

// ---------------------------------------------------------------------------
// 造一个实验节点
// ---------------------------------------------------------------------------
function makeLabNode({ name, host, port, beaconPort, discovery, autoConnect, connectTimeoutMs, handshakeTimeoutMs }) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-chat-lab-'));
  const identity = identityFromRecord(createIdentity());
  const config = normalizeConfig({
    dataDir: dir,
    listen: { host, port },
    discovery: {
      enabled: discovery, beaconPort, intervalMs: 2000, ttlMs: 8000,
      autoConnect, manualPeers: [],
    },
    network: { connectTimeoutMs, handshakeTimeoutMs },
  });
  const codec = new EnvelopeCodec({ identity });
  const transport = new LanTransport({ config, identity, codec, nodeInfo: () => ({ nickname: name }) });
  return { dir, identity, config, codec, transport };
}

const stats = {
  connected: 0, disconnected: 0,
  sent: 0, received: 0, bytesSent: 0, bytesReceived: 0,
  rtts: [], duplicates: 0, outOfOrder: 0, corrupt: 0,
};

function digestOf(values) {
  const hash = createHash('sha256');
  for (const value of values) hash.update(JSON.stringify(value));
  return hash.digest('hex').slice(0, 16);
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function report(title) {
  const rtt = stats.rtts;
  console.log(`\n──── ${title} ────`);
  console.log(`连接：成功 ${stats.connected} 次，断开 ${stats.disconnected} 次`);
  console.log(`消息：发出 ${stats.sent}，收到 ${stats.received}`);
  console.log(`字节：上行 ${stats.bytesSent}，下行 ${stats.bytesReceived}`);
  if (rtt.length > 0) {
    console.log(`往返时延（n=${rtt.length}）：min ${percentile(rtt, 0)}ms  `
      + `p50 ${percentile(rtt, 50)}ms  p95 ${percentile(rtt, 95)}ms  max ${percentile(rtt, 100)}ms  `
      + `avg ${Math.round(rtt.reduce((a, b) => a + b, 0) / rtt.length)}ms`);
  }
  console.log(`异常：重复 ${stats.duplicates}，乱序 ${stats.outOfOrder}，损坏 ${stats.corrupt}`);
}

// ---------------------------------------------------------------------------
// serve：监听 + 回显
// ---------------------------------------------------------------------------
async function serve(options) {
  const name = typeof options.name === 'string' ? options.name : 'lab-server';
  const host = typeof options.host === 'string' ? options.host : '0.0.0.0';
  const node = makeLabNode({
    name, host,
    port: num(options.port, 47800),
    beaconPort: num(options['beacon-port'], 47899),
    discovery: options['no-discovery'] !== true,
    autoConnect: false,
    connectTimeoutMs: 8000,
    handshakeTimeoutMs: 15000,
  });

  node.transport.on('peer-up', (peer) => {
    stats.connected += 1;
    console.log(`[+] 节点接入 ${peer.nickname ?? '(无昵称)'} ${peer.fingerprint} ← ${peer.address}`);
  });
  node.transport.on('peer-down', (peer, reason) => {
    stats.disconnected += 1;
    console.log(`[-] 节点断开 ${peer.peerKey?.slice(0, 22)}… 原因=${reason}`);
  });
  node.transport.on('error', (error, context) => console.log(`[!] 传输层错误: ${error.message} ${JSON.stringify(context ?? {})}`));
  node.transport.on('discovered', (entry) => console.log(`[~] 信标发现 ${entry.nickname ?? ''} @ ${entry.address}`));

  // 回显：把收到的每条消息原样签字回发，拨号方据此算往返时延并校验完整性。
  node.transport.on('envelope', ({ envelope, peerKey }) => {
    stats.received += 1;
    stats.bytesReceived += JSON.stringify(envelope).length;
    if (envelope.kind === MESSAGE_KIND.PRESENCE && envelope.payload?.echo === true) return;
    try {
      const echo = node.codec.seal(MESSAGE_KIND.PRESENCE, {
        echo: true,
        seq: envelope.payload?.seq ?? null,
        sentAt: envelope.payload?.sentAt ?? null,
        digest: envelope.payload?.digest ?? null,
        serverAt: Date.now(),
      }, { to: peerKey });
      node.transport.send(peerKey, echo);
      stats.sent += 1;
      stats.bytesSent += JSON.stringify(echo).length;
    } catch (error) {
      console.log(`[!] 回显失败: ${error.message}`);
    }
  });

  await node.transport.start();
  console.log('=== dsh-chat 网络实验台 · 监听方 ===');
  console.log(`节点名：${name}`);
  console.log(`指纹：${node.identity.fingerprint}`);
  console.log(`监听：${node.transport.address}`);
  console.log(`本机可用地址：${listAllAddresses().join('  ')}`);
  console.log('\n在另一台设备上执行（任选其一）：');
  console.log(`  node scripts/net-lab.mjs dial ${node.transport.address}`);
  console.log(`  node scripts/net-lab.mjs dial ${node.transport.createInvite()}`);
  console.log(`\n跨网段/NAT 时：先把 ${num(options.port, 47800)}/tcp 做端口映射，再用公网地址拨号。`);
  console.log('按 Ctrl+C 结束并打印统计。');

  const timer = setInterval(() => report('实时统计'), 30000);
  const shutdown = async () => {
    clearInterval(timer);
    report('最终统计');
    await node.transport.stop().catch(() => {});
    rmSync(node.dir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ---------------------------------------------------------------------------
// dial：连接 + 压测
// ---------------------------------------------------------------------------
async function dial(options) {
  const target = options._[0];
  if (!target) {
    console.error('用法：node scripts/net-lab.mjs dial <地址或邀请码> [--count N] [--size B]');
    process.exit(2);
  }
  const count = num(options.count, 50);
  const size = num(options.size, 256);
  const timeoutMs = num(options.timeout, 60000);
  const name = typeof options.name === 'string' ? options.name : 'lab-client';

  const node = makeLabNode({
    name, host: '0.0.0.0', port: 0,
    beaconPort: num(options['beacon-port'], 47899),
    discovery: false, autoConnect: false,
    connectTimeoutMs: num(options['connect-timeout'], 8000),
    handshakeTimeoutMs: num(options['handshake-timeout'], 15000),
  });

  const pending = new Map(); // seq → sentAt
  const seenSeqs = new Set();
  let lastSeq = -1;
  const serverDigests = [];

  node.transport.on('peer-up', (peer) => {
    stats.connected += 1;
    console.log(`[+] 握手完成 → ${peer.nickname ?? '(无昵称)'} ${peer.fingerprint}（${peer.direction}）`);
  });
  node.transport.on('peer-down', (peer, reason) => {
    stats.disconnected += 1;
    console.log(`[-] 断开：${reason}`);
  });
  node.transport.on('error', (error) => console.log(`[!] 传输层错误: ${error.message}`));

  node.transport.on('envelope', ({ envelope }) => {
    stats.received += 1;
    stats.bytesReceived += JSON.stringify(envelope).length;
    const payload = envelope.payload ?? {};
    if (payload.echo !== true) return;
    const seq = payload.seq;
    if (seenSeqs.has(seq)) { stats.duplicates += 1; return; }
    seenSeqs.add(seq);
    if (typeof seq === 'number' && seq < lastSeq) stats.outOfOrder += 1;
    if (typeof seq === 'number') lastSeq = Math.max(lastSeq, seq);
    if (payload.digest) serverDigests.push(payload.digest);
    const sentAt = pending.get(seq);
    if (typeof sentAt === 'number') {
      stats.rtts.push(Date.now() - sentAt);
      pending.delete(seq);
    }
  });

  console.log('=== dsh-chat 网络实验台 · 拨号方 ===');
  console.log(`目标：${target}`);
  await node.transport.start();
  console.log(`本机：${node.transport.address ?? '(未监听)'}  指纹 ${node.identity.fingerprint}`);

  const startedAt = Date.now();
  await node.transport.connect(target);
  const handshakeDeadline = Date.now() + num(options['handshake-wait'], 15000);
  while (node.transport.peers().length === 0 && Date.now() < handshakeDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const peer = node.transport.peers()[0];
  if (!peer) {
    console.error('握手未完成：对方没有回应。请检查地址、端口映射或防火墙。');
    await node.transport.stop().catch(() => {});
    process.exit(1);
  }
  const handshakeMs = Date.now() - startedAt;
  console.log(`握手耗时：${handshakeMs}ms`);

  const sentDigests = [];
  console.log(`\n开始发送 ${count} 条消息（每条约 ${size} 字节），等待回显…`);
  for (let seq = 0; seq < count; seq += 1) {
    const body = `${String(seq).padStart(6, '0')}-`.padEnd(size, 'z');
    const digest = createHash('sha256').update(body).digest('hex').slice(0, 16);
    sentDigests.push(digest);
    pending.set(seq, Date.now());
    const envelope = node.codec.seal(MESSAGE_KIND.DIRECT_MESSAGE, { seq, sentAt: Date.now(), digest, body }, { to: peer.peerKey });
    node.transport.send(peer.peerKey, envelope);
    stats.sent += 1;
    stats.bytesSent += JSON.stringify(envelope).length;
    // 轻微节奏，避免把本地回环一次性打满而测不出时延分布。
    if (count > 20) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const deadline = Date.now() + timeoutMs;
  while (stats.received < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const totalMs = Date.now() - startedAt;
  report('实验结束');
  console.log(`握手 ${handshakeMs}ms，全程 ${totalMs}ms`);
  const expectedDigests = sentDigests.slice(0, serverDigests.length);
  console.log(`内容完整性：服务端回显的摘要与本地发出的前 ${expectedDigests.length} 条`
    + `${expectedDigests.every((d, i) => d === serverDigests[i]) ? '完全一致 ✔' : '不一致 ✘'}`);
  console.log(`送达率：${stats.received}/${count} = ${(100 * stats.received / count).toFixed(1)}%`);
  console.log(`本地载荷摘要：${digestOf(sentDigests)}`);

  await node.transport.stop().catch(() => {});
  rmSync(node.dir, { recursive: true, force: true });
  process.exit(stats.received >= count ? 0 : 1);
}

// ---------------------------------------------------------------------------
// probe：只做发现探测
// ---------------------------------------------------------------------------
async function probe(options) {
  const seconds = num(options.seconds, 15);
  const node = makeLabNode({
    name: typeof options.name === 'string' ? options.name : 'lab-probe',
    host: '0.0.0.0',
    port: 0,
    beaconPort: num(options['beacon-port'], 47899),
    discovery: true,
    autoConnect: false,
    connectTimeoutMs: 5000,
    handshakeTimeoutMs: 8000,
  });

  const found = new Map();
  node.transport.on('discovered', (entry) => {
    const first = !found.has(entry.publicKeyId);
    found.set(entry.publicKeyId, { ...entry, firstSeenAt: found.get(entry.publicKeyId)?.firstSeenAt ?? Date.now() });
    if (first) console.log(`[~] 发现 ${entry.nickname ?? '(无昵称)'} @ ${entry.address}  指纹 ${entry.fingerprint}`);
  });

  await node.transport.start();
  console.log('=== dsh-chat 网络实验台 · 发现探测 ===');
  console.log(`本机地址：${listAllAddresses().join('  ')}`);
  console.log(`信标端口：${num(options['beacon-port'], 47899)}，持续 ${seconds} 秒…`);
  console.log('（信标只在同一广播域内可达；跨网段需要手工地址或引导节点）\n');

  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  console.log(`\n发现 ${found.size} 个节点：`);
  for (const entry of found.values()) {
    console.log(`  ${entry.nickname ?? '(无昵称)'}  ${entry.address}  ${entry.fingerprint}`);
  }
  const interfaces = networkInterfaces();
  console.log(`\n本机网卡：${listAllAddresses().join('  ')}`);
  console.log(`其中非回环网卡数量：${Object.values(interfaces).flat().filter((a) => a && !a.internal).length}`);

  await node.transport.stop().catch(() => {});
  rmSync(node.dir, { recursive: true, force: true });
  process.exit(0);
}

// ---------------------------------------------------------------------------
const { command, options } = parseArgs(process.argv.slice(2));
const commands = { serve, dial, probe };
if (!commands[command]) {
  console.log('dsh-chat 网络实验台\n');
  console.log('  serve   监听并回显，打印地址与邀请码');
  console.log('  dial    连接一个节点并压测往返时延与数据完整性');
  console.log('  probe   只监听信标，列出能发现的节点');
  console.log('\n示例：');
  console.log('  node scripts/net-lab.mjs serve --host 0.0.0.0 --port 47800');
  console.log('  node scripts/net-lab.mjs dial 192.168.3.90:47800 --count 100');
  console.log('  node scripts/net-lab.mjs probe --seconds 20');
  process.exit(command === undefined ? 0 : 2);
}
await commands[command](options);
