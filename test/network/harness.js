/**
 * 网络测试的公共脚手架。
 *
 * 一个「节点」= 独立数据目录 + 独立身份 + 独立 LanTransport + 一个收到什么的账本。
 * 所有网络测试都用它造节点，避免每个用例各写一遍。
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MESSAGE_KIND } from '../../src/shared/protocol.js';
import { normalizeConfig } from '../../src/host/config.js';
import { createIdentity, identityFromRecord } from '../../src/host/identity.js';
import { EnvelopeCodec } from '../../src/host/net/envelope.js';
import { LanTransport } from '../../src/host/net/lan.js';
import { startFaultProxy } from './fault-proxy.js';

/** 造一个节点。listenHost 决定它绑在哪个地址上，因此决定走哪条网络路径。 */
export function makeNode({
  nickname = 'node',
  listenHost = '127.0.0.1',
  listenPort = 0,
  discovery = false,
  autoConnect = false,
  beaconPort = 47899,
  connectTimeoutMs = 5000,
  handshakeTimeoutMs = 8000,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-chat-net-'));
  const identity = identityFromRecord(createIdentity());
  const config = normalizeConfig({
    dataDir: dir,
    listen: { host: listenHost, port: listenPort },
    discovery: {
      enabled: discovery, beaconPort, intervalMs: 500, ttlMs: 4000,
      autoConnect, manualPeers: [],
    },
    network: { connectTimeoutMs, handshakeTimeoutMs },
  });
  const codec = new EnvelopeCodec({ identity });
  const received = [];
  const peersUp = [];
  const peersDown = [];
  const errors = [];

  const transport = new LanTransport({ config, identity, codec, nodeInfo: () => ({ nickname }) });
  // 记成 { envelope, peerKey, payload }：`LanTransport` 的 'envelope' 事件给的是信封，
  // 业务载荷在 `envelope.payload` 里。把它摊平一层，测试里少写一堆 `.envelope`。
  transport.on('envelope', (event) => received.push({
    envelope: event.envelope,
    peerKey: event.peerKey,
    payload: event.envelope?.payload,
  }));
  transport.on('peer-up', (peer) => peersUp.push(peer));
  transport.on('peer-down', (peer, reason) => peersDown.push({ ...peer, reason }));
  transport.on('error', (error, context) => errors.push({ error, context }));

  return {
    dir, identity, config, codec, transport, received, peersUp, peersDown, errors, nickname,
    get address() {
      return transport.address;
    },
    async start() {
      await transport.start();
      return this;
    },
    async stop() {
      await transport.stop().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    },
    /** 发一条带签名的消息给某个 peer，返回信封（便于之后校验哈希）。 */
    send(peerKey, kind, payload) {
      const envelope = codec.seal(kind, payload, { to: peerKey });
      transport.send(peerKey, envelope);
      return envelope;
    },
  };
}

/** 等到条件成立，或抛超时错误。 */
export async function waitFor(predicate, { timeoutMs = 6000, label = '条件', intervalMs = 15 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待「${label}」超时（${timeoutMs}ms）`);
    await sleep(intervalMs);
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 内容指纹：把收到的载荷规范化后哈希，用来断言"数据一个 bit 都没变"。 */
export function digest(values) {
  const hash = createHash('sha256');
  for (const value of values) hash.update(JSON.stringify(value));
  return hash.digest('hex').slice(0, 16);
}

/**
 * 建立 A →（故障代理）→ B 的连接。
 * @returns {{a, b, proxy, link: string}}
 */
export async function connectThroughProxy({ faults = {}, a: providedA, b: providedB, nodeOptions = {} } = {}) {
  const b = providedB ?? makeNode({ nickname: 'B', ...nodeOptions });
  if (!providedB) await b.start();
  const a = providedA ?? makeNode({ nickname: 'A', ...nodeOptions });
  if (!providedA) await a.start();

  const proxy = await startFaultProxy({ targetPort: Number(b.address.split(':').pop()), faults });
  await a.transport.connect(proxy.address);
  await waitFor(() => a.transport.peers().length === 1 && b.transport.peers().length === 1, {
    label: '双向握手完成',
    timeoutMs: 4000,
  });
  return { a, b, proxy, link: `A →(proxy ${proxy.address})→ B ${b.address}` };
}

/** 收尾：关掉代理与两个节点。 */
export async function teardown({ a, b, proxy }) {
  await proxy?.close().catch(() => {});
  await a?.stop().catch(() => {});
  await b?.stop().catch(() => {});
}

export { MESSAGE_KIND };
