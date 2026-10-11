/**
 * 界面渲染冒烟测试。
 *
 * 为什么需要它：本次交付**没有浏览器控制能力**，所以"界面到底会不会崩"这一项
 * 本来只能写"未验证"。但 slot 注册成功只证明模块被 apply 了，
 * 不证明任何组件渲染时不抛错——官方 UI 规范里也特意警告过，
 * 一个抛错的组件会把整个 slot 渲染成空白，控制台只留一句
 * `slot entry crashed in '<slot>'`。
 *
 * 这个测试把**真实的客户端组件**（不是副本）用 react-test-renderer 渲染出来，
 * 并用一个假的 Host 通道喂进真实形状的数据，覆盖六个视图 + 分享对话框 + 开播对话框 + 直播间。
 *
 * 它不能替代浏览器验证（没有真实布局、没有主题、没有交互），
 * 但能把"组件一渲染就炸"这一整类问题挡在交付之前。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 极简 DOM 桩。
 *
 * react-test-renderer 跑在纯 Node 里，没有 document。Modal 组件在 useEffect 里
 * 注册 Escape 键监听（官方 UI 规范要求复制宿主控件这个行为），需要 document。
 * 这里桩掉的是**环境**而不是被测代码——浏览器里 document 本来就存在。
 */
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    createElement() { return { dataset: {}, style: {}, textContent: '', remove() {} }; },
    head: { appendChild() {} },
  };
}

import { Fragment, createElement as h } from 'react';
import { act, create } from 'react-test-renderer';

import {
  DialogHost, DshChatApp, SessionActions, SessionEntry, intentStore,
} from '../.test-build/client.mjs';
import { ShareDialog } from '../.test-build/client.mjs';
import { GoLiveDialog, LiveRoomDialog } from '../.test-build/client.mjs';
import { zh } from '../src/client/i18n.js';

// 方便：直接用中文字典当 t，缺键回落到键名（和真实行为一致）。
const t = (key) => zh[key] ?? key;

/**
 * 一个假的 Host 通道，返回与真实 RPC **同形状**的数据。
 *
 * 刻意做成"每条方法都有对应实现"，这样新增 RPC 调用时如果忘了补桩，
 * 测试会立刻抛 `未知方法`，而不是静默渲染出空白。
 */
function makeFakeClient(overrides = {}) {
  const identity = {
    publicKeyId: `ed25519:${'A'.repeat(43)}`,
    fingerprint: 'aaaa1111-bbbb2222-cccc3333-dddd4444',
    algorithm: 'ed25519',
    nickname: '测试节点',
    bio: '',
  };
  const room = {
    id: 'room_test', sessionId: 'sess_1', title: '用 AI 写登录页',
    host: { publicKeyId: identity.publicKeyId, fingerprint: identity.fingerprint, nickname: '测试节点' },
    tags: ['vue'], summary: '', scope: 'public', mode: 'standard',
    contentKinds: ['prompt', 'answer'], status: 'live', paused: false,
    createdAt: Date.now(), startedAt: Date.now(), endedAt: null,
    seq: 3, eventCount: 3, droppedEvents: 0, viewerCount: 0, replayPublished: false,
  };
  const peer = {
    peerKey: `ed25519:${'B'.repeat(43)}`, relation: 'friend', following: true,
    note: '你好', requestAt: Date.now(), delivery: 'sent', blockReason: '',
    online: true, nickname: '老李', fingerprint: 'eeee5555-ffff6666-0000-7777-88889999', lastSeen: Date.now(),
  };
  const share = {
    id: 'b3:' + '0'.repeat(64), title: '登录页实现', author: { nickname: '测试节点' },
    createdAt: Date.now(), scope: 'public', mode: 'standard', itemCount: 3, tags: ['vue'],
  };
  const tables = {
    handshake: async () => ({ version: '0.1.0', token: 'tok', identity, protocol: { version: 1 } }),
    overview: async () => ({
      node: {
        identity, dataDir: '/tmp/x',
        transport: { name: 'lan-websocket', running: true, address: '127.0.0.1:1', metrics: { connections: 1, handshakes: 1, openConnections: 1, knownPeers: 1, discovered: 0, envelopesIn: 2, envelopesOut: 1, failedHandshakes: 0 } },
        codec: { sealed: 1, opened: 2, rejected: 0, byReason: {} },
        capture: { eventsSeen: 10, eventsFiltered: 5, eventsCaptured: 5, eventsDropped: 0, handlerErrors: 0, chunksSeen: 3, lastEventAt: Date.now() },
        rpc: { rpcCalls: 4, rpcErrors: 0, sseConnections: 1, sseEvents: 2, sseClients: 1 },
        consent: { activeGrants: 1, defaultSharingMode: 'disabled', sessions: [{ sessionId: 'sess_1', mode: 'standard', scope: 'public', contentKinds: ['prompt', 'answer'], authorizedAt: new Date().toISOString(), expiresAt: null }] },
        peers: { friends: 1, following: 1, incoming: 0, outgoing: 0, blocked: 0, online: 1 },
        live: { rooms: [room], watched: [] },
        shares: { count: 1, byScope: { public: 1 } },
        directory: { signedManifests: 1, localPlugins: 1, ratings: 2 },
        contribution: { roles: ['ordinary'], maxCacheBytes: 0, maxUploadBps: 0, maxDownloadBps: 0, onlyOnPower: false, autoStopMinutes: 0, enforced: ['maxCacheBytes'], declaredOnly: ['maxUploadBps'] },
        redaction: { ruleCount: 2 },
        build: { version: '0.1.0', startedAt: Date.now() },
      },
      rooms: [room],
      watched: [{ id: 'room_remote', title: '远端直播', host: { nickname: '别人' }, watchedLatestSeq: 7, pendingGaps: 1, receivedEvents: 7 }],
      peers: [peer, { ...peer, peerKey: `ed25519:${'C'.repeat(43)}`, relation: 'incoming', nickname: '小王' }],
      shares: [share],
      directory: [
        { pluginId: 'dsh-chat', name: 'dsh-chat', version: '0.1.0', description: '社交层', verified: true, installed: true, publisher: { fingerprint: identity.fingerprint }, rating: { average: 4.5, count: 2 } },
        { pluginId: 'dsh-pocket', name: 'dsh-pocket', version: '2.10.6', description: '手机访问', verified: false, installed: true, publisher: null, rating: { average: null, count: 0 } },
      ],
      messages: [],
    }),
    'profile.get': async () => ({ profile: { nickname: '测试节点', bio: '简介' }, identity }),
    'profile.update': async () => ({ nickname: 'x' }),
    'identity.export': async () => ({ warning: '危险', record: { publicKeyId: identity.publicKeyId } }),
    'share.list': async () => [share],
    'consent.summary': async () => ({ activeGrants: 1, defaultSharingMode: 'disabled', sessions: [{ sessionId: 'sess_1', mode: 'standard', scope: 'public', contentKinds: ['prompt', 'answer'], authorizedAt: new Date().toISOString(), expiresAt: null }] }),
    'peers.list': async () => [peer, { ...peer, peerKey: `ed25519:${'C'.repeat(43)}`, relation: 'incoming', nickname: '小王', online: false }],
    'peers.discovered': async () => [{ publicKeyId: `ed25519:${'D'.repeat(43)}`, fingerprint: 'ffff', nickname: '发现到的', address: '127.0.0.1:9', seenAt: Date.now() }],
    'peers.connected': async () => [{ peerKey: peer.peerKey, nickname: '老李', fingerprint: peer.fingerprint, direction: 'outbound', address: '127.0.0.1:9' }],
    'peers.invite': async () => ({ invite: 'dshchat1:abc', address: '127.0.0.1:1' }),
    'messages.list': async () => [
      { id: 'm1', direction: 'in', peerKey: peer.peerKey, at: Date.now(), text: '你好', encrypted: false },
      { id: 'm2', direction: 'out', peerKey: peer.peerKey, at: Date.now(), text: '在的', delivered: false, encrypted: false },
    ],
    'node.snapshot': async () => (await tables.overview()).node,
    'relay.status': async () => ({
      enabled: true,
      serving: true,
      reachability: {
        inboundPeers: 3, outboundPeers: 1, lastInboundAt: Date.now(),
        verdict: 'reachable', note: '实测有节点主动连入过，本机可以被当作中继。',
      },
      server: { peers: 2, capacity: 32, forwarded: 17, refusedPlaintext: 1, unreachable: 0, bytesForwarded: 4096 },
      client: { metrics: { forwardedOut: 4, forwardedIn: 6, unreachable: 1, refused: 0 }, relays: [], relayedPeers: [] },
      servers: [{ peerKey: 'ed25519:' + 'R'.repeat(43), address: '203.0.113.7:47800', registered: true, load: { peers: 2, capacity: 32 } }],
      relayedPeers: [{ peerKey: 'ed25519:' + 'S'.repeat(43), nickname: '中继对端', lastSeen: Date.now() }],
    }),
    'relay.add': async () => ({ peerKey: 'ed25519:' + 'R'.repeat(43), servers: [] }),
    'relay.reputation': async () => ({
      relays: [
        { peerKey: 'ed25519:' + 'R'.repeat(43), score: 42.5, observations: 17, blacklisted: false, counts: {} },
      ],
      contribution: { servedBytes: 1048576, consumedBytes: 262144, balance: 786432, servedRatio: 0.8 },
      punch: {
        natType: { type: 'restricted', reason: 'consistent-mapping' },
        attempts: 4, succeeded: 3, failed: 1, skipped: 0,
      },
      note: '信誉只反映本机的实测经历。',
    }),
    'relay.punch': async () => ({ ok: true, reason: 'punched', elapsedMs: 120 }),
    reachability: async () => ({
      state: 'proven',
      reason: '实测有节点主动连入过 3 次，本机确实可以被连入。',
      local: { verdict: 'no-public-address', reason: '本机地址都是私网地址。', publicV4: [], publicV6Count: 3, hasCgnat: false, interfaces: [] },
      observations: 2,
      inbound: { count: 3, lastAt: Date.now(), fromAddresses: [] },
      probes: { attempts: 1, confirmations: 1 },
      serving: true,
      serveConfig: 'auto',
      suggestion: { suggest: false, reason: 'already-serving' },
    }),
    'reachability.prove': async () => ({ ok: true, reason: 'inbound-verified' }),
    'relay.ensureReachable': async () => ({ route: 'direct', reason: 'punched' }),
    'live.list': async () => [room],
    'live.watched': async () => [],
    'live.snapshot': async () => ({
      room,
      events: [
        { roomId: room.id, seq: 1, type: 'session_started', at: Date.now(), payload: { title: '用 AI 写登录页', mode: 'standard' }, sig: 'sig1' },
        { roomId: room.id, seq: 2, type: 'message_added', at: Date.now(), payload: { role: 'user', text: '帮我写一个登录页' }, sig: 'sig2' },
        { roomId: room.id, seq: 3, type: 'stream_paused', at: Date.now(), payload: { reason: 'user' }, sig: 'sig3' },
      ],
      chat: [{ id: 'c1', at: Date.now(), from: '观众', text: '这个思路好', local: false }],
      oldestSeq: 1, latestSeq: 3, truncated: false, droppedEvents: 0,
    }),
    'sessions.preview': async () => ({
      sessionId: 'sess_1', total: 2,
      items: [
        { seq: 1, type: 'user/message', contentKind: 'prompt', role: 'user', text: '帮我写登录页', redacted: { value: { text: '帮我写登录页' }, withheld: false, reasons: [], changed: false } },
        { seq: 2, type: 'assistant/message', contentKind: 'answer', role: 'assistant', text: '好的，密钥 sk-abcdefghijklmnopqrstuvwx', redacted: { value: { text: '好的，密钥 [已脱敏:26字符]' }, withheld: false, reasons: ['secret'], changed: true } },
      ],
    }),
    'live.chat': async () => ({ id: 'c2', at: Date.now(), from: '我', text: 'hi', local: true }),
  };

  const calls = [];
  const client = {
    calls,
    async call(method, payload) {
      calls.push({ method, payload });
      const handler = overrides[method] ?? tables[method];
      if (!handler) throw new Error(`测试桩缺少 RPC 方法: ${method}`);
      return handler(payload);
    },
    async handshake() { return tables.handshake(); },
    subscribe() { return () => {}; },
    on() { return () => {}; },
    get sseState() { return 'open'; },
    get hasToken() { return true; },
  };
  return client;
}

/** 渲染一棵树并让 useEffect/异步数据落地。 */
async function render(element) {
  let tree;
  await act(async () => {
    tree = create(element);
  });
  // 再跑一轮，等 useRpc 里的 promise 链落定。
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return tree;
}

/** 把渲染树变成纯文本，用于断言"页面上出现了什么字"。 */
function textOf(tree) {
  const out = [];
  const walk = (node) => {
    if (node === null || node === undefined || node === false) return;
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.children) node.children.forEach(walk);
  };
  walk(tree.toJSON());
  return out.join(' ');
}

/** 递归找是否有某个函数组件/元素类型出现过——用来确认某个子组件真的被渲染了。 */
function collectTypes(tree) {
  const types = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    const json = node.toJSON?.() ?? node;
    const visit = (n) => {
      if (!n || typeof n !== 'object') return;
      if (n.type) types.add(typeof n.type === 'string' ? n.type : (n.type.name || n.type.displayName || 'anonymous'));
      if (Array.isArray(n.children)) n.children.forEach(visit);
    };
    visit(json);
  };
  walk(tree);
  return types;
}

describe('客户端界面渲染（无浏览器环境下能做到的最强验证）', () => {
  const sections = ['discover', 'friends', 'messages', 'favorites', 'node', 'me'];

  for (const section of sections) {
    it(`主面板「${section}」可以渲染且不抛错`, async () => {
      const client = makeFakeClient();
      const tree = await render(h(DshChatApp, { client, t, jump: { section } }));
      const text = textOf(tree);
      assert.ok(text.length > 0, '渲染结果不应是空白');
      // 左侧导航六项必须都在
      assert.match(text, /发现/);
      assert.match(text, /好友/);
      tree.unmount();
    });
  }

  it('发现页默认展示直播与远端观看，并如实说明为什么可能为空', async () => {
    const client = makeFakeClient();
    const tree = await render(h(DshChatApp, { client, t, jump: { section: 'discover' } }));
    const text = textOf(tree);
    assert.match(text, /正在直播/);
    assert.match(text, /用 AI 写登录页/, '应显示直播间标题');
    assert.match(text, /远端直播/, '应显示正在观看的远端直播间');
    assert.match(text, /待补事件/, '有空洞时应显示待补数量');
    assert.match(text, /没有中心目录|本机已知/, '应如实说明为什么列表可能为空');
    tree.unmount();
  });

  it('发现页插件页签区分"已签名"与"本机未验证来源"', async () => {
    const client = makeFakeClient();
    const tree = await render(h(DshChatApp, { client, t, jump: { section: 'discover' } }));

    const tab = tree.root.findAll((node) => node.type === 'button'
      && String(node.children.join?.('') ?? '').includes('插件广场'));
    assert.ok(tab.length > 0, '应有插件广场页签');
    await act(async () => { tab[0].props.onClick(); });

    const text = textOf(tree);
    assert.match(text, /signed/, '签名清单应有标记');
    assert.match(text, /unverified/, '本机未签名插件必须标为未验证');
    assert.match(text, /dsh-pocket/, '应列出本机插件');
    tree.unmount();
  });

  it('节点页把「已生效」与「仅声明」分开列出（不假装限速已实现）', async () => {
    const client = makeFakeClient();
    const tree = await render(h(DshChatApp, { client, t, jump: { section: 'node' } }));
    const text = textOf(tree);
    assert.match(text, /真正生效/);
    assert.match(text, /尚未执行/);
    assert.match(text, /maxUploadBps/, '未生效的配置项应被点名');
    assert.match(text, /137|127\.0\.0\.1:1|lan-websocket/, '应显示真实传输状态');
    tree.unmount();
  });

  it('消息页显著提示私聊未加密（这是必须让用户看到的事）', async () => {
    const client = makeFakeClient();
    const tree = await render(h(DshChatApp, { client, t, jump: { section: 'messages' } }));
    const text = textOf(tree);
    assert.match(text, /没有端到端加密/);
    assert.match(text, /未加密/, '每条出站消息也应标注未加密');
    assert.match(text, /未送达/, '未送达的消息要标出来，不能假装已送达');
    tree.unmount();
  });

  it('我的页显示生效中的授权，并提供逐条撤销', async () => {
    const client = makeFakeClient();
    const tree = await render(h(DshChatApp, { client, t, jump: { section: 'me' } }));
    const text = textOf(tree);
    assert.match(text, /生效中的授权|sess_1/);
    assert.match(text, /撤销/);
    assert.match(text, /导出身份备份/);
    tree.unmount();
  });

  it('分享对话框：一打开就自动加载预览，并标出被脱敏的条目', async () => {
    const client = makeFakeClient();
    let tree;
    await act(async () => { tree = create(h(ShareDialog, { client, t, sessionId: 'sess_1', onClose() {} })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const text = textOf(tree);
    // 预览是自动加载的：用户看到对话框的同时就看到了将要发出的内容，
    // 而不是面对一个"灰着且不说为什么"的发布按钮。
    assert.match(text, /已预览/, '预览应已自动加载');
    assert.match(text, /已脱敏/, '被脱敏的条目应标注出来');
    assert.match(text, /将发出的|会发出|已预览 2 条/, '应显示实际会发出的条数');

    const publish = tree.root.findAll((node) => node.type === 'button'
      && String(node.children.join?.('') ?? '').includes('发布分享'));
    assert.ok(publish.length > 0, '应有发布按钮');
    assert.equal(publish[0].props.disabled, false, '预览已就绪，发布按钮应可点');
    tree.unmount();
  });

  it('分享对话框：勾选全部取消时，发布按钮不可用且写明原因', async () => {
    const client = makeFakeClient();
    let tree;
    await act(async () => { tree = create(h(ShareDialog, { client, t, sessionId: 'sess_1', onClose() {} })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    // 取消勾选所有内容类型
    const boxes = tree.root.findAll((node) => node.type === 'input' && node.props.type === 'checkbox');
    assert.ok(boxes.length > 0, '应有内容类型勾选框');
    for (const box of boxes) {
      // Checkbox 的 onChange 收的是事件对象，不是布尔值。
      if (box.props.checked) await act(async () => { box.props.onChange({ target: { checked: false } }); });
    }

    const publish = tree.root.findAll((node) => node.type === 'button'
      && String(node.children.join?.('') ?? '').includes('发布分享'));
    assert.equal(publish[0].props.disabled, true);
    assert.match(textOf(tree), /至少勾选一种/, '必须说明为什么不能发布');
    tree.unmount();
  });

  it('开播对话框：预览自动就绪，主按钮立即可用（不再有"灰着不说为什么"）', async () => {
    const client = makeFakeClient({ 'live.list': async () => [] });
    let tree;
    await act(async () => { tree = create(h(GoLiveDialog, { client, t, sessionId: 'sess_1', onClose() {} })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const text = textOf(tree);
    assert.match(text, /会广播/, '应显示当前粒度会广播多少条');

    const submit = tree.root.findAll((node) => node.type === 'button'
      && String(node.children.join?.('') ?? '').includes('开始直播'));
    assert.ok(submit.length > 0);
    assert.equal(submit[0].props.disabled, false, '预览自动就绪后开播按钮应可点');
    tree.unmount();
  });

  it('直播间：主播看到控制项，观众看不到', async () => {
    const client = makeFakeClient();
    let tree;
    await act(async () => { tree = create(h(LiveRoomDialog, { client, t, roomId: 'room_test', role: 'host' })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    let text = textOf(tree);
    assert.match(text, /暂停广播/, '主播应看到暂停按钮');
    assert.match(text, /结束直播/, '主播应看到结束按钮');
    assert.match(text, /帮我写一个登录页/, '应渲染出实时会话流');
    assert.match(text, /这个思路好/, '应渲染出聊天室内容');
    tree.unmount();

    await act(async () => { tree = create(h(LiveRoomDialog, { client, t, roomId: 'room_test', role: 'viewer' })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    text = textOf(tree);
    assert.match(text, /只有主播能控制直播/, '观众应看到权限边界提示');
    assert.doesNotMatch(text, /结束直播/, '观众不应看到结束按钮（规划 §7.6）');
    tree.unmount();
  });

  it('直播间：暂停时给出"本地会话仍在继续"的说明', async () => {
    const client = makeFakeClient({
      'live.snapshot': async () => ({
        room: { id: 'room_test', title: 'x', status: 'live', paused: true, eventCount: 1, seq: 1, scope: 'public', mode: 'standard' },
        events: [], chat: [], oldestSeq: null, latestSeq: 1, truncated: false, droppedEvents: 0,
      }),
    });
    let tree;
    await act(async () => { tree = create(h(LiveRoomDialog, { client, t, roomId: 'room_test', role: 'host' })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    assert.match(textOf(tree), /本地 DSH 会话仍在继续/);
    tree.unmount();
  });

  it('会话页入口：未开播时提供"分享会话"与"开启直播"，点击后把意图带出去', async () => {
    const client = makeFakeClient({ 'live.list': async () => [] });
    const jumps = [];
    let tree;
    await act(async () => { tree = create(h(SessionActions, { client, t, sessionId: 'sess_1', onJump: (j) => jumps.push(j) })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const text = textOf(tree);
    assert.match(text, /分享会话/);
    assert.match(text, /开启直播/);

    const shareButton = tree.root.findAll((node) => node.type === 'button'
      && String(node.children.join?.('') ?? '').includes('分享会话'));
    await act(async () => { shareButton[0].props.onClick(); });
    assert.equal(jumps.length, 1);
    assert.equal(jumps[0].kind, 'share');
    assert.equal(jumps[0].sessionId, 'sess_1');

    const liveButton = tree.root.findAll((node) => node.type === 'button'
      && String(node.children.join?.('') ?? '').includes('开启直播'));
    await act(async () => { liveButton[0].props.onClick(); });
    assert.equal(jumps[1].kind, 'live');
    tree.unmount();
  });

  it('会话页入口：已在直播中时把按钮换成直播状态，而不是再显示"开启直播"', async () => {
    const client = makeFakeClient();  // 假数据里 sess_1 已有一个进行中的直播间
    let tree;
    await act(async () => { tree = create(h(SessionActions, { client, t, sessionId: 'sess_1', onJump() {} })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const text = textOf(tree);
    assert.match(text, /分享会话/);
    assert.match(text, /LIVE|直播中/);
    assert.doesNotMatch(text, /开启直播/, '已在直播中就不该再提供开播入口');
    tree.unmount();
  });

  it('没有 sessionId 时入口不渲染（避免出现点了没反应的按钮）', async () => {
    const client = makeFakeClient();
    let tree;
    await act(async () => { tree = create(h(SessionActions, { client, t, sessionId: null, onJump() {} })); });
    assert.equal(tree.toJSON(), null);
    tree.unmount();
  });

  it('RPC 失败时显示错误而不是白屏', async () => {
    const client = makeFakeClient({
      overview: async () => { throw new Error('连接被拒绝'); },
      'node.snapshot': async () => { throw new Error('连接被拒绝'); },
    });
    let tree;
    await act(async () => { tree = create(h(DshChatApp, { client, t, jump: { section: 'node' } })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const text = textOf(tree);
    assert.match(text, /连接被拒绝|操作失败/, '失败应可见，而不是留一片空白');
    tree.unmount();
  });
});

/**
 * 会话页入口 + 对话框宿主的行为测试。
 *
 * 这一组对应的是**两个先后发生的真实故障**：
 *
 *   故障 A（按钮点了没反应）：点击 → `ctx.layout.selectPanel(...)` 切主面板 → 主面板再弹对话框。
 *     而 `layout` 是一次性快照，拿不到就永远是 undefined，整条链静默断掉。
 *   故障 B（跳到面板了但什么都没发生）：改成"自己就地弹对话框 + 顺便切面板"之后，
 *     切面板把 conversation 子树整个卸载，而对话框正住在里面，刚创建就跟着消失。
 *
 * 故障 B 的那条测试（下面第二条）是这一组里最重要的：
 * 它先渲染 SessionEntry + DialogHost，点击弹窗，**然后把 SessionEntry 卸载掉**
 * （模拟切主面板摧毁 conversation），再断言对话框仍在。
 * 也就是说，它把"弹窗组件不能住在会被导航卸载的子树里"这条教训固化成了断言。
 */
describe('会话页入口 + 对话框宿主', () => {
  async function clickButton(tree, label) {
    const buttons = tree.root.findAll((node) => node.type === 'button'
      && String(node.children.join?.('') ?? '').includes(label));
    assert.ok(buttons.length > 0, `没找到按钮「${label}」`);
    await act(async () => { buttons[0].props.onClick(); });
    return buttons[0];
  }

  /** 模拟真实布局：SessionEntry 在会话子树里，DialogHost 在常驻的 shell.overlay 上。 */
  async function setup({ client = null } = {}) {
    const fake = client ?? makeFakeClient({ 'live.list': async () => [] });
    intentStore.clear();
    let tree;
    await act(async () => {
      tree = create(h(Fragment, null,
        h(SessionEntry, { client: fake, t, sessionId: 'sess_1', onIntent: (i) => intentStore.set(i) }),
        h(DialogHost, { client: fake, t }),
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    return { tree, client: fake };
  }

  it('点「分享会话」写出意图，对话框由宿主渲染出来', async () => {
    const { tree } = await setup();
    assert.doesNotMatch(textOf(tree), /发布分享/, '一开始不该有对话框');

    await clickButton(tree, '分享会话');

    const text = textOf(tree);
    assert.match(text, /分享会话/, '对话框应已打开');
    assert.match(text, /发布分享/, '应出现发布按钮');
    assert.doesNotMatch(text, /正在加载预览/, '预览应已自动加载完成');
    tree.unmount();
  });

  it('【回归】会话页入口被卸载（切主面板）之后，对话框依然在', async () => {
    const { tree } = await setup();
    await clickButton(tree, '开启直播');
    assert.match(textOf(tree), /开始直播/, '对话框应先打开');

    // 关键一步：把 SessionEntry 从树里摘掉，模拟"切主面板 → conversation 被卸载"。
    // 旧实现里对话框长在 SessionEntry 内部，这一下就把它带走了。
    await act(async () => {
      tree.update(h(Fragment, null,
        null,
        h(DialogHost, { client: makeFakeClient({ 'live.list': async () => [] }), t }),
      ));
    });

    // 注意：DialogHost 的 client 换了实例无所谓，对话框本身必须还在。
    const text = textOf(tree);
    assert.match(text, /开始直播|已开播/, '入口被卸载后对话框必须仍然存在');
    tree.unmount();
    intentStore.clear();
  });

  it('开播对话框一打开就自动加载预览，主按钮不是"灰着不说为什么"', async () => {
    const { tree } = await setup();
    await clickButton(tree, '开启直播');

    const text = textOf(tree);
    assert.match(text, /会广播/, '应显示当前粒度会广播多少条');
    const start = tree.root.findAll((node) => node.type === 'button'
      && String(node.children.join?.('') ?? '').includes('开始直播'));
    assert.ok(start.length > 0, '应有开始直播按钮');
    assert.equal(start[0].props.disabled, false, '预览自动加载完成后主按钮应可点');
    tree.unmount();
    intentStore.clear();
  });

  it('点「开始直播」真的会调到 live.open，并进入直播间', async () => {
    const calls = [];
    const client = makeFakeClient({
      'live.list': async () => [],
      'live.open': async (payload) => {
        calls.push(payload);
        return { id: 'room_new', sessionId: payload.sessionId, title: payload.title || '未命名直播', status: 'live', paused: false, eventCount: 1, seq: 1, scope: 'public', mode: payload.mode };
      },
      'live.snapshot': async () => ({
        room: { id: 'room_new', title: '我的直播', status: 'live', paused: false, eventCount: 1, seq: 1, scope: 'public', mode: 'standard' },
        events: [], chat: [], oldestSeq: null, latestSeq: 1, truncated: false, droppedEvents: 0,
      }),
    });
    const { tree } = await setup({ client });

    await clickButton(tree, '开启直播');
    // 填个标题，验证参数确实传下去了
    const titleInput = tree.root.findAll((node) => node.type === 'input')[0];
    await act(async () => { titleInput.props.onChange({ target: { value: '我的直播' } }); });

    const start = tree.root.findAll((node) => node.type === 'button'
      && String(node.children.join?.('') ?? '').includes('开始直播')
      && node.props.disabled === false);
    assert.ok(start.length > 0, '主按钮应可用');
    await act(async () => { start[0].props.onClick(); await Promise.resolve(); await Promise.resolve(); });

    assert.equal(calls.length, 1, 'live.open 应被调用一次');
    assert.equal(calls[0].sessionId, 'sess_1');
    assert.equal(calls[0].previewed, true, '必须带上"看过预览"的标记，否则 Host 会拒绝');
    assert.equal(calls[0].title, '我的直播');

    const text = textOf(tree);
    assert.match(text, /我的直播|LIVE/, '应进入直播间');
    assert.match(text, /暂停广播/, '主播应看到暂停按钮');
    tree.unmount();
    intentStore.clear();
  });

  it('开播失败时错误可见，且不会假装已经开播', async () => {
    const client = makeFakeClient({
      'live.list': async () => [],
      'live.open': async () => { throw new Error('该会话已经在直播中'); },
    });
    const { tree } = await setup({ client });
    await clickButton(tree, '开启直播');
    const start = tree.root.findAll((node) => node.type === 'button'
      && String(node.children.join?.('') ?? '').includes('开始直播')
      && node.props.disabled === false);
    await act(async () => { start[0].props.onClick(); await Promise.resolve(); await Promise.resolve(); });

    assert.match(textOf(tree), /该会话已经在直播中/, '失败原因必须显示出来');
    assert.doesNotMatch(textOf(tree), /已开播/, '失败时不能显示成功');
    tree.unmount();
    intentStore.clear();
  });

  it('没有 sessionId 时不渲染任何按钮', async () => {
    intentStore.clear();
    let tree;
    await act(async () => { tree = create(h(SessionEntry, { client: makeFakeClient(), t, sessionId: null, onIntent() {} })); });
    assert.equal(tree.toJSON(), null);
    tree.unmount();
  });

  it('宿主在没有意图时不渲染任何东西（不会凭空多出一个遮罩）', async () => {
    intentStore.clear();
    let tree;
    await act(async () => { tree = create(h(DialogHost, { client: makeFakeClient(), t })); });
    assert.equal(tree.toJSON(), null);
    tree.unmount();
  });
});

/**
 * 结构性检查：用了 JSX 片段（`<>…</>`）的文件必须把 `Fragment` 带进作用域。
 *
 * 为什么单独写一条：这个 bug 在本项目里**犯了两次**（先在 7 个视图文件里，
 * 后在 app.js 的 SessionEntry 里）。它的特征很讨厌——
 *   - 静态看代码完全正常，`<>` 是合法 JSX；
 *   - esbuild 编译也不报错，它只把 `<>` 变成 `Fragment(...)`，那是个自由变量；
 *   - 构建产物看起来一切正常，直到组件被渲染的那一刻才抛
 *     `ReferenceError: Fragment is not defined`，然后**整个 slot 变空白**。
 *
 * 也就是说，它是"编译器抓不到、运行时才炸、而且炸得很难看"的组合。
 * 靠记性避免不可靠，所以让测试来记。
 */
describe('JSX 片段必须导入 Fragment（结构性检查）', () => {
  const CLIENT_DIR = join(ROOT, 'src/client');

  function clientSourceFiles(dir = CLIENT_DIR, out = []) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) clientSourceFiles(full, out);
      else if (entry.endsWith('.js')) out.push(full);
    }
    return out;
  }

  const files = clientSourceFiles();

  it('扫描到的客户端源文件数量合理（防止扫描逻辑本身失效）', () => {
    assert.ok(files.length >= 10, `只扫到 ${files.length} 个文件，扫描逻辑可能坏了`);
  });

  it('每个使用 <> 的文件都导入了 Fragment', () => {
    const offenders = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      // 只看真正的 JSX 片段：`<>` 或 `</>`，排除字符串里的尖括号。
      const usesFragment = /<>|<\/>/.test(text);
      if (!usesFragment) continue;
      // 必须真的出现在 import 语句里（而不是仅仅被提到）
      const importsFragment = /import\s*\{[^}]*\bFragment\b[^}]*\}\s*from/.test(text);
      if (!importsFragment) offenders.push(file.slice(ROOT.length + 1));
    }
    assert.deepEqual(offenders, [], `这些文件用了 <> 但没导入 Fragment：\n${offenders.map((f) => `  ${f}`).join('\n')}`);
  });

  it('反过来也检查：导入 Fact Fragment 却没用到不算错，但拼错的名字会被抓出来', () => {
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const usesFragment = /<>|<\/>/.test(text);
      if (!usesFragment) continue;
      // 常见拼错
      assert.doesNotMatch(text, /\bFragement\b|\bfragment\b(?!\s*[:=])/, `${file.slice(ROOT.length + 1)} 里 Fragment 可能拼错了`);
    }
  });
});
