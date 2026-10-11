/**
 * dsh-chat Host 半体入口。
 *
 * 这个文件只做三件事：**装配**、**接线**、**暴露 RPC**。
 * 业务逻辑都在各自的模块里（identity / consent / redaction / capture / share / live /
 * peers / directory / net），这里不重复实现。
 *
 * 装配顺序刻意如此——它反映了数据流的方向：
 *   配置 → 存储 → 身份 → 授权门 → 脱敏 → 采集 → 分享/直播 → 网络 → RPC
 *
 * 任何一步失败都不应该"带着半套配置"继续跑：宁可插件加载失败，
 * 也不要出现「以为没开直播，其实在广播」的状态。
 */
import { homedir } from 'node:os';

import {
  ACCESS_SCOPE,
  CONTENT_KINDS,
  LIVE_EVENT,
  MESSAGE_KIND,
  NODE_ROLE,
  RATING_DIMENSIONS,
  SHARING_MODE,
  SHARING_MODES,
  randomId,
} from '../shared/protocol.js';
import { Capture, toLedgerRecord } from './capture.js';
import { normalizeConfig } from './config.js';
import { ConsentGate } from './consent.js';
import { PluginDirectory, EXPERIENCE } from './directory.js';
import { createIdentity, identityFromRecord, migrateIdentityRecord } from './identity.js';
import { LiveEngine } from './live.js';
import { createLogger } from './log.js';
import { PeerBook } from './peers.js';
import { createRedactionPipeline } from './redaction.js';
import { HostRpcServer, RPC_PATH } from './rpc.js';
import { ShareRegistry } from './share.js';
import { JsonDocument, JsonlLog, ensureDir, resolveDataDir } from './store.js';
import { EnvelopeCodec } from './net/envelope.js';
import { LanTransport } from './net/lan.js';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { RelayTransport } from './relay.js';
import { describeLedger } from './reputation.js';
import { LiveSwarm } from './live-swarm.js';
import { REACHABILITY, ReachabilityMonitor } from './reachability.js';
import { isSealedPayload } from './crypto.js';
import { verifyIdentityDocument } from './identity.js';

export const name = 'dsh-chat';
/**
 * 声明式依赖 —— **只列激活时真正需要的**。
 *
 * `inject` 在 Cordis 里是**硬依赖**：列在这里的服务只要有一个还没就绪，
 * `apply()` 就永远不会被调用，而且**不会报任何错**。
 *
 * 之前这里还列了 `sessionQuery` 和 `sessions`，但那两个只在少数 RPC 处理函数里
 * 用到（惰性使用），激活阶段根本不需要。把它们写成硬依赖的后果是：
 * 只要它们在当前作用域里取不到，整个插件就静静地不加载 ——
 * 用户看到的是"无法访问 Host 半体"，而日志里什么都没有。
 *
 * 教训：**不要为惰性使用的东西声明硬依赖。** 现在它们通过 ctx.get 按需获取，
 * 拿不到时只有那一个 RPC 方法报错，插件其余部分照常工作。
 */
export const inject = ['connection', 'webServer'];

/**
 * 惰性取一个可选服务。
 *
 * 报错信息要能直接指向"哪个功能不可用、缺什么"，而不是一句笼统的失败 ——
 * 排查插件问题最贵的就是"没线索"。
 */
function requireService(ctx, name, purpose) {
  const service = ctx.get?.(name) ?? null;
  if (!service) {
    throw Object.assign(
      new Error(`当前 DSH 没有提供 ${name} 服务，无法${purpose}`),
      { code: 'dsh-chat/service-unavailable', detail: { service: name } },
    );
  }
  return service;
}

const PLUGIN_VERSION = '0.1.0';

/**
 * 启动诊断的落盘位置。
 *
 * 为什么需要它：Cordis 的失败模式可以是**完全静默**的 ——
 * 硬依赖没就绪时 `apply()` 根本不会被调用；`apply()` 中途抛错时，
 * 错误也只是被加载器记走，用户只看到"无法访问 Host 半体"。
 * 上一次排查就卡在这里：能确认 `apply` 进入了，却完全不知道它死在哪一行。
 */
let bootDir = null;

function resolveBootDir(rawConfig) {
  try {
    return rawConfig?.dataDir
      || process.env.DSH_CHAT_DATA_DIR
      || `${process.env.HOME ?? '.'}/.dsh/dsh-chat`;
  } catch {
    return null;
  }
}

function recordBoot(phase, extra = {}) {
  if (!bootDir) return;
  try {
    mkdirSync(bootDir, { recursive: true });
    const payload = {
      phase,
      at: Date.now(),
      atHuman: new Date().toISOString(),
      pid: process.pid,
      node: process.version,
      inject: [...inject],
      ...extra,
    };
    // 原子写：不留下半截文件。
    const target = join(bootDir, 'boot.json');
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2));
    renameSync(tmp, target);
  } catch {
    // 诊断本身绝不能成为新的失败点。
  }
}

/**
 * 插件入口 —— 一层薄包装，**专门负责把失败原因留下来**。
 *
 * 内层 `applyInner` 是原来的全部逻辑。这里只做三件事：
 *   进入时记一条、成功时记一条、**抛错时把 message 与堆栈一起记下来再重新抛出**。
 *
 * 为什么必须重新抛出：静默失败是最贵的失败。让加载器照常知道插件没起来，
 * 同时让磁盘上留下能直接定位的原因。
 */
export function apply(ctx, rawConfig = {}) {
  bootDir = resolveBootDir(rawConfig);
  recordBoot('apply-called', { note: 'apply 已进入' });
  try {
    applyInner(ctx, rawConfig);
    recordBoot('apply-completed', {
      note: 'apply 正常执行完毕；若界面仍报无法访问 Host 半体，问题在路由/通道而不在加载',
    });
  } catch (error) {
    recordBoot('apply-failed', {
      message: error?.message ?? String(error),
      name: error?.name ?? null,
      code: error?.code ?? null,
      stack: String(error?.stack ?? '').split('\n').slice(0, 12),
    });
    throw error;
  }
}

function applyInner(ctx, rawConfig = {}) {
  recordBoot('apply-called', { note: 'apply 已进入；若只看到这一条，说明后续步骤中途失败' });

  const config = normalizeConfig(rawConfig);
  recordBoot('config-ok', { note: '配置校验通过' });
  const logger = createLogger(ctx, 'dsh-chat');
  const dataDir = ensureDir(resolveDataDir(config.dataDir));
  logger.info('数据目录', { dataDir });

  // ===== 存储 =====
  const identityFile = new JsonDocument(`${dataDir}/identity.json`);
  const profileFile = new JsonDocument(`${dataDir}/profile.json`, { fallback: {} });
  const peersFile = new JsonDocument(`${dataDir}/peers.json`, { fallback: { relations: {}, requests: {} } });
  const sharesFile = new JsonDocument(`${dataDir}/shares.json`, { fallback: [] });
  const messagesLog = new JsonlLog(`${dataDir}/messages.jsonl`);
  const auditLog = new JsonlLog(`${dataDir}/audit.jsonl`);

  // ===== 身份 =====
  // 私钥只写在本机 0600 文件里，绝不出现在日志、网络或界面传输中。
  let identity;
  if (identityFile.exists) {
    /**
     * **就地补齐加密密钥。**
     *
     * 早期版本的身份文件里只有 Ed25519 签名密钥；后来加了 X25519 加密密钥，
     * 但**忘了把迁移接进加载路径** —— `identityFromRecord` 直接抛
     * "身份记录缺少加密密钥"，`apply()` 中途失败，插件整个起不来。
     * 界面上的表现是"无法访问 dsh-chat 的 Host 半体"，而原因完全看不出来。
     *
     * 这里补上并立刻落盘：**签名身份一字不改**，只是多一套加密密钥 ——
     * 用户不会因为升级插件就换了一个人。
     */
    const { record, migrated } = migrateIdentityRecord(identityFile.read());
    if (migrated) {
      identityFile.write(record);
      logger.info('已为本机身份补齐加密密钥（签名身份保持不变）', { fingerprint: record.fingerprint });
    }
    identity = identityFromRecord(record);
    logger.info('已载入本机身份', { fingerprint: identity.fingerprint });
  } else {
    const record = createIdentity();
    identityFile.write(record);
    identity = identityFromRecord(record);
    logger.info('已生成新的本机身份（私钥保存在本机，请自行备份）', { fingerprint: identity.fingerprint });
  }

  const profile = {
    nickname: profileFile.read()?.nickname ?? config.identity.nickname,
    bio: profileFile.read()?.bio ?? config.identity.bio,
    avatar: profileFile.read()?.avatar ?? null,
  };
  const saveProfile = (patch) => {
    Object.assign(profile, patch ?? {});
    profileFile.write({ ...profile });
    return { ...profile };
  };

  // ===== 授权门 / 脱敏 =====
  const consent = new ConsentGate({ config, logger, auditLog });
  const redaction = createRedactionPipeline({ config, logger, homeDir: homedir() });

  // ===== 采集 =====
  // 未授权会话在采集层就被丢弃：正文连深拷贝都不会发生。
  const capture = new Capture({
    logger,
    shouldCapture: (sessionId) => consent.isAuthorized(sessionId),
    onRecord: (record) => {
      try {
        live.ingest(record);
        sse.broadcast('live', { kind: 'record', sessionId: record.session.id, seq: record.seq, type: record.type });
        // 我手上有到第几号事件 —— 同房间的观众据此判断能不能从我这里补数据。
        if (record.session?.id) {
          broadcastToPeers(MESSAGE_KIND.LIVE_HAVE, { roomId: record.session.id, upToSeq: record.seq });
        }
      } catch (error) {
        // 采集回调抛错会被 DSH 静默吞掉，所以必须自己记下来。
        logger.warn('采集回调处理失败', { message: error?.message, sessionId: record.session.id });
      }
    },
    onChunk: (chunk) => {
      try {
        live.ingestChunk(chunk);
      } catch (error) {
        logger.debug('瞬时帧转发失败', { message: error?.message });
      }
    },
  });

  // ===== 分享 / 直播 / 目录 =====
  const readLedgerEvents = async (sessionId) => {
    const snapshot = await requireService(ctx, 'sessionQuery', '读取会话事件').readSession(sessionId);
    const session = { id: sessionId };
    return (snapshot?.events ?? [])
      .map((event) => toLedgerRecord(session, event))
      .filter((record) => record.contentKind !== null);
  };

  const shares = new ShareRegistry({
    config, identity, consent, redaction, logger,
    profile: () => profile,
    readEvents: readLedgerEvents,
    sourceIndex: new JsonDocument(`${dataDir}/share-sources.json`, { fallback: {} }),
  });
  // 分享对象落盘（规划 §6.7：公开会话可以由作者本地保存）。
  // 用整体 JSON 而不是 oplog：分享数量级远小于事件，可读性更重要。
  /**
   * 载入已保存的分享。
   *
   * `?? []` 只挡得住 null/undefined，挡不住"文件里是个对象"这种历史遗留 ——
   * 那时 `for...of` 会抛 "not iterable"，**插件整个起不来**。
   * 一个字段坏掉不该让插件罢工，所以这里显式要求它是数组，不是就跳过并记账。
   */
  const savedShares = sharesFile.read();
  if (Array.isArray(savedShares)) {
    for (const share of savedShares) shares.import(share);
  } else if (savedShares != null) {
    logger.warn('shares.json 不是数组，已忽略', { type: typeof savedShares });
  }
  shares.onPublish(() => sharesFile.write(shares.list().map((s) => shares.get(s.id)).filter(Boolean)));

  const live = new LiveEngine({
    config, identity, consent, redaction, logger,
    profile: () => profile,
  });

  const directory = new PluginDirectory({ identity, logger });

  // ===== 网络 =====
  const codec = new EnvelopeCodec({ identity, logger });

  /**
   * 可达性证据：**只统计别人主动连进来的次数**。
   *
   * 这比"我在配置里写了 serve: true"诚实得多 —— 在 NAT 后面打开中继开关不会让任何人连得进来。
   * 所以界面上区分「已配置」与「实测有人连进来过」，两者不是一回事。
   */
  /**
   * 可达性监控：**唯一**的可达性事实来源。
   *
   * 早先这里是几个散落的计数器（inboundPeers / lastInboundAt），
   * 与后来加入的 ReachabilityMonitor 形成了**两套并行状态** ——
   * 同一件事有两个地方记，迟早会不一致，而且不一致时没人知道该信哪个。
   * 现在统一到监控器里，计数器只是它的一个视图。
   */
  const reachabilityMonitor = new ReachabilityMonitor({ logger });

  const innerTransport = new LanTransport({
    config, identity, codec, logger,
    nodeInfo: () => ({
      nickname: profile.nickname,
      // 只有配置打开、且**确实有人连进来过**时才对外宣称自己是中继 ——
      // 否则会误导别人把消息发给一个根本连不上的地址。
      relay: config.relay.serve
        ? {
          serve: true,
          /**
           * 对外通告里带的是**实证结果**，不是配置值。
           * 在 NAT 后面写 serve: true 也不会有人连得进来；
           * 如果这里回 true，别人就会把消息发给一个连不上的地址。
           */
          verified: reachabilityMonitor.report().state === REACHABILITY.PROVEN,
          state: reachabilityMonitor.report().state,
          load: relayServer?.metrics ?? null,
        }
        : null,
    }),
  });

  const transport = new RelayTransport({
    inner: innerTransport,
    identity,
    logger,
    // 'auto' 需要在启动时就把服务端构造出来，否则第一次实证成功时无从开启。
    // 注意：构造 ≠ 对外宣称可达 —— 对外通告里带的是"是否实测过"，见下方 nodeInfo。
    enableRelayServer: config.relay.serve === true || config.relay.serve === 'auto',
    policy: config.relay.policy,
    punch: { timeoutMs: config.relay.punch.timeoutMs, dialTimeoutMs: config.relay.punch.dialTimeoutMs },
  }).useCodecSeal((kind, payload, to) => codec.seal(kind, payload, { to }));

  const relayServer = transport.relayServer;
  const relayClient = transport.relayClient;

  /** 对端身份文档缓存：公钥标识 → 自签名文档（含加密公钥）。 */
  const peerDocuments = new Map();
  /** 直连握手公告里带来的加密公钥（比中继转交的更可信：它来自端到端握手）。 */
  const knownEncryptionKeys = new Map();
  const peers = new PeerBook({ config, identity, logger, document: peersFile });

  /**
   * 观众间分发（规划 §5.4）。
   *
   * 默认**开启** —— 它和"给陌生人当中继"是两件不同的事：
   * 你已经在看这场直播、已经收到了这些数据，转给同房间观众
   * 既没有多下载任何东西，又直接决定发布者扛不扛得住。
   */
  const swarm = new LiveSwarm({ policy: config.contribution.swarm });

  recordBoot('modules-ready', { note: '数据层与网络层模块构造完成' });

  /** 把一条消息发给所有直连/经中继可达的对端。 */
  function broadcastToPeers(kind, payload) {
    try {
      if (typeof transport.broadcast !== 'function') return;
      transport.broadcast(codec.seal(kind, payload));
    } catch (error) {
      logger?.debug?.('分发可用性广播失败', { message: error?.message });
    }
  }

  // ===== RPC =====
  const sse = new HostRpcServer({ ctx, logger });
  const rpc = sse; // 同一个对象同时提供 RPC 与广播

  // ------------------------------------------------------------------
  // 网络事件处理
  // ------------------------------------------------------------------

  function sendTo(peerKey, kind, payload) {
    try {
      const envelope = codec.seal(kind, payload, { to: peerKey });
      const ok = transport.send(peerKey, envelope);
      if (!ok) logger.warn('发送失败：目标节点未连接', { peerKey, kind });
      return ok;
    } catch (error) {
      logger.warn('封装信封失败', { message: error?.message, kind });
      return false;
    }
  }

  function onEnvelope({ envelope, peerKey }) {
    try {
      switch (envelope.kind) {
        case MESSAGE_KIND.FRIEND_REQUEST: {
          peers.receiveFriendRequest(envelope.from, { note: envelope.payload?.note ?? '' });
          sse.broadcast('peers', { reason: 'incoming-request', from: envelope.from });
          break;
        }
        case MESSAGE_KIND.FRIEND_RESPONSE: {
          if (envelope.payload?.accepted === true) peers.acceptFriend(envelope.from);
          else peers.rejectFriend(envelope.from);
          sse.broadcast('peers', { reason: 'response', from: envelope.from });
          break;
        }
        case MESSAGE_KIND.DIRECT_MESSAGE: {
          // 拉黑即拒收（规划 §9.5）。
          if (!peers.acceptsMessagesFrom(envelope.from)) {
            logger.debug('已拉黑该身份，丢弃私聊消息', { from: envelope.from });
            break;
          }

          // 密文优先：能解开就是密文，解不开就如实标记，绝不把乱码当正文存下来。
          let payload = envelope.payload;
          let encrypted = false;
          if (isSealedPayload(envelope.payload)) {
            try {
              payload = identity.decrypt(envelope.payload);
              encrypted = true;
            } catch (error) {
              logger.warn('收到发给本机的密文但解不开（可能不是发给我的，或已损坏）', {
                from: envelope.from, message: error?.message,
              });
              break;
            }
          }

          const message = {
            id: envelope.id,
            direction: 'in',
            peerKey: envelope.from,
            at: envelope.time,
            text: String(payload?.text ?? '').slice(0, 20000),
            encrypted,
            /** 经过中继的如实标注：用户有权知道这条不是直连来的。 */
            relayed: envelope.relayed === true,
          };
          messagesLog.append(message);
          sse.broadcast('messages', message);
          break;
        }
        case MESSAGE_KIND.LIVE_HAVE: {
        // 对端告诉我它手上有到第几号事件。
        swarm.noteAvailability(envelope.from, envelope.payload?.roomId, envelope.payload?.upToSeq);
        break;
      }

      case MESSAGE_KIND.LIVE_FETCH: {
        /**
         * 有人想从**我这里**补数据。
         *
         * 先过策略（房间够不够大、有没有超出服务上限与预算），
         * 被拒时**必须给出原因** —— 对端据此换一个来源，而不是干等。
         */
        const request = envelope.payload ?? {};
        const verdict = swarm.shouldServe({
          roomId: request.roomId,
          requesterKey: envelope.from,
          sinceSeq: request.sinceSeq,
          latestSeq: request.latestSeq,
          roomSize: request.roomSize ?? 0,
        });
        if (!verdict.allow) {
          sendTo(envelope.from, MESSAGE_KIND.LIVE_FETCH_RESULT, {
            roomId: request.roomId, ok: false, reason: verdict.reason,
          });
          break;
        }
        const room = live.getRoom(request.roomId);
        const events = room ? room.eventsSince(request.sinceSeq).events.slice(-verdict.maxEvents) : [];
        swarm.noteServing(request.roomId, envelope.from);
        swarm.noteForwarded(JSON.stringify(events).length);
        sendTo(envelope.from, MESSAGE_KIND.LIVE_FETCH_RESULT, {
          roomId: request.roomId, ok: true, events,
        });
        logger?.debug?.('为对端补了直播数据', { peer: envelope.from, count: events.length });
        break;
      }

      case MESSAGE_KIND.LIVE_FETCH_RESULT: {
        swarm.noteServeFinished(envelope.payload?.roomId, envelope.from);
        sse.broadcast('live-swarm', { kind: 'fetch-result', from: envelope.from, ...envelope.payload });
        break;
      }

      case MESSAGE_KIND.PRESENCE: {
          peers.markOnline({ peerKey, fingerprint: peers.describe(peerKey).fingerprint, nickname: envelope.payload?.nickname ?? null, address: null });
          sse.broadcast('peers', { reason: 'presence', from: peerKey });
          break;
        }
        case MESSAGE_KIND.LIVE_EVENT: {
          const accepted = live.acceptRemoteEvent(envelope.payload?.roomId, envelope.payload?.event);
          if (accepted) sse.broadcast('live', { kind: 'remote-event', roomId: envelope.payload?.roomId });
          break;
        }
        case MESSAGE_KIND.LIVE_STATE: {
          live.mirrorRemote(envelope.payload?.room);
          for (const event of envelope.payload?.events ?? []) live.acceptRemoteEvent(envelope.payload.room.id, event);
          sse.broadcast('live', { kind: 'remote-state', roomId: envelope.payload?.room?.id });
          break;
        }
        case MESSAGE_KIND.LIVE_STATE_REQUEST: {
          // 只有主播本人能回答自己的直播间状态。
          const room = live.getRoom(envelope.payload?.roomId);
          if (room && room.host.publicKeyId === identity.publicKeyId) {
            sendTo(envelope.from, MESSAGE_KIND.LIVE_STATE, room.snapshot({ sinceSeq: envelope.payload?.sinceSeq ?? 0 }));
          }
          break;
        }
        case MESSAGE_KIND.SHARE_ANNOUNCE: {
          const share = envelope.payload?.share;
          if (share) {
            const result = shares.import(share);
            if (result.accepted) sse.broadcast('shares', { reason: 'remote-share', id: share.id });
          }
          break;
        }
        case MESSAGE_KIND.PLUGIN_MANIFEST: {
          if (envelope.payload?.manifest) {
            const result = directory.importManifest(envelope.payload.manifest);
            if (result.accepted) sse.broadcast('directory', { reason: 'manifest', pluginId: envelope.payload.manifest.pluginId });
          }
          break;
        }
        case MESSAGE_KIND.PLUGIN_RATING: {
          if (envelope.payload?.rating) {
            const result = directory.importRating(envelope.payload.rating);
            if (result.accepted) sse.broadcast('directory', { reason: 'rating', pluginId: envelope.payload.rating.pluginId });
          }
          break;
        }
        case MESSAGE_KIND.ACK: {
          const awaiting = peers.describe(peerKey);
          if (awaiting.relation === 'outgoing') {
            peers.requestFriend(peerKey, { note: awaiting.note, delivered: true });
            sse.broadcast('peers', { reason: 'ack', from: peerKey });
          }
          break;
        }
        default:
          logger.debug('收到未处理类型的信封', { kind: envelope.kind });
      }
    } catch (error) {
      // 单条消息处理失败不能影响其它消息，更不能让插件崩掉。
      logger.warn('处理信封失败', { kind: envelope.kind, message: error?.message });
    }
  }

  transport.on('envelope', onEnvelope);
  transport.on('peer-up', (peer) => {
    peers.markOnline(peer);
    if (peer.direction === 'inbound') {
      // L3：真的有人连进来过 —— 这是唯一能证明可达的证据。
      reachabilityMonitor.noteInbound({ address: peer.address ?? null });
      maybeAutoServe();
    } else if (peer.direction === 'outbound') {
      reachabilityMonitor.noteOutbound();
    }
    // 直连握手公告里带着对方的加密公钥 —— 记录它，之后就能发加密私聊。
    if (!peer.relayed) {
      const announced = peer.encryptionKeyId ?? peer.announcement?.encryptionKeyId ?? null;
      if (typeof announced === 'string' && announced.startsWith('x25519:')) {
        knownEncryptionKeys.set(peer.peerKey, announced);
      }
    }
    // 上线即打招呼，让对方也把我标为在线（规划 §5.2 的在线状态）。
    sendTo(peer.peerKey, MESSAGE_KIND.PRESENCE, { nickname: profile.nickname, encryptionKeyId: identity.encryptionKeyId });
    sse.broadcast('peers', { reason: 'up', peerKey: peer.peerKey, relayed: peer.relayed === true });
  });

  // 中继转交的自签名文档：只接受通过校验的，并单独提示密钥变更。
  transport.on('relay-document', ({ peerKey, document, online }) => {
    if (!document) return;
    const known = peerDocuments.get(peerKey) ?? null;
    const verdict = verifyIdentityDocument(document, { known });
    if (!verdict.valid) {
      logger.warn('中继转交的身份文档未通过签名校验，已丢弃', { peerKey, problems: verdict.problems });
      return;
    }
    if (verdict.keyChanged) {
      logger.warn('对端的加密公钥发生变化（可能是换设备，也可能是中间人）', { peerKey });
    }
    peerDocuments.set(peerKey, document);
    sse.broadcast('peers', { reason: 'document', peerKey, keyChanged: verdict.keyChanged, online });
  });

  /**
   * 有节点只能经中继到达时，**后台**试一次打洞。
   *
   * 刻意不做成同步等待：打洞要几秒，而中继本来就能用 ——
   * 让用户为了一个"可能更快"的路径干等，是拿确定性换可能性。
   * 打通了后续流量自动走直连（send() 里判断），打不通什么都没发生。
   */
  const punchAttempts = new Set();
  transport.on('peer-up', (peer) => {
    if (!config.relay.punch.enabled || !peer.relayed) return;
    if (punchAttempts.has(peer.peerKey)) return;
    punchAttempts.add(peer.peerKey);
    transport.punchWith(peer.peerKey).then((outcome) => {
      sse.broadcast('relay', { reason: 'punch', peerKey: peer.peerKey, ...outcome });
      if (!outcome.ok) punchAttempts.delete(peer.peerKey); // 允许以后重试
    }).catch((error) => {
      punchAttempts.delete(peer.peerKey);
      logger.debug('打洞尝试出错（不影响中继可用）', { message: error?.message });
    });
  });

  /**
   * `relay.serve: 'auto'` —— 只有**实测到有人成功连入过**才真的开启中继服务。
   *
   * 刻意不做成"检测到公网 IP 就开"：公网 IP 不等于可被连入
   * （国内家宽普遍封入站），按 IP 判断会对外宣称一台谁也用不了的中继。
   */
  let autoServeDone = false;
  function maybeAutoServe() {
    if (autoServeDone) return;
    if (config.relay.serve !== 'auto') return;
    if (!transport.relayServer) {
      logger.info('实测可达，但中继服务需要在启动时构造（relay.serve 为 auto 时启动即构造）');
      return;
    }
    autoServeDone = true;
    logger.info('实测有人成功连入 → 按 relay.serve=auto 开始提供中继服务');
    sse.broadcast('relay', { reason: 'auto-serve' });
  }

  transport.on('relay-state', (state) => {
    logger.info('中继状态变化', { relay: state.relay, registered: state.registered, address: state.address });
    sse.broadcast('relay', { reason: 'state', ...state });
  });
  transport.on('punch-endpoint', ({ observer, observed }) => {
    // L2：中继看到的来源地址 —— 零额外泄露，用的就是打洞那次探测。
    const parsed = observed ? observed.match(/^\[?([^\]]+)\]?:(\d+)$/) : null;
    if (parsed) reachabilityMonitor.noteObservation(observer, parsed[1], Number(parsed[2]));
  });

  transport.on('relay-unreachable', (payload) => {
    sse.broadcast('relay', { reason: 'unreachable', ...payload });
  });
  transport.on('peer-down', (peer) => {
    peers.markOffline(peer.peerKey);
    sse.broadcast('peers', { reason: 'down', peerKey: peer.peerKey });
  });
  transport.on('discovered', (entry) => sse.broadcast('discovered', entry));
  transport.on('error', (error, context) => logger.warn('传输层错误', { message: error?.message, ...context }));

  // 直播事件与房间变化推给界面。
  live.onRoomChange((rooms) => sse.broadcast('live', { kind: 'rooms', rooms }));
  live.onMirrorChange((mirror) => sse.broadcast('live', { kind: 'mirror', roomId: mirror.descriptor?.id }));
  live.onTransientChunk((packet) => sse.broadcast('live-chunk', packet));
  directory.onChange(() => sse.broadcast('directory', { reason: 'changed' }));
  shares.onPublish(() => sse.broadcast('shares', { reason: 'changed' }));

  // ===== 时区/版本等静态信息 =====
  const buildInfo = { version: PLUGIN_VERSION, startedAt: Date.now() };

  function nodeSnapshot() {
    return {
      identity: identity.describe(profile),
      dataDir,
      transport: {
        name: transport.name,
        running: transport.running,
        address: transport.address,
        metrics: transport.metrics,
      },
      codec: codec.metrics,
      capture: capture.metrics,
      rpc: sse.metrics,
      consent: consent.summary(),
      peers: peers.metrics,
      live: live.metrics,
      shares: shares.metrics,
      directory: directory.metrics,
      contribution: {
        roles: config.contribution.roles,
        maxCacheBytes: config.contribution.maxCacheBytes,
        maxUploadBps: config.contribution.maxUploadBps,
        maxDownloadBps: config.contribution.maxDownloadBps,
        onlyOnPower: config.contribution.onlyOnPower,
        autoStopMinutes: config.contribution.autoStopMinutes,
        /** 诚实标注：限速与"仅接电源"这两项目前只是配置项，尚未真正执行。 */
        enforced: ['maxCacheBytes', 'pauseAll'],
        declaredOnly: ['maxUploadBps', 'maxDownloadBps', 'onlyOnPower', 'autoStopMinutes'],
      },
      redaction: { ruleCount: redaction.ruleCount },
      build: buildInfo,
    };
  }

  // ------------------------------------------------------------------
  // RPC 方法表
  // ------------------------------------------------------------------

  rpc.register('handshake', () => ({
    version: PLUGIN_VERSION,
    token: sse.token,
    identity: identity.describe(profile),
    protocol: { version: 1 },
  }));

  rpc.register('overview', () => ({
    node: nodeSnapshot(),
    rooms: live.listRooms(),
    watched: live.listWatched(),
    peers: peers.list(),
    shares: shares.list(),
    directory: directory.list().slice(0, 50),
    messages: messagesLog.readAll({ limit: 200 }).slice(-200).reverse(),
  }));

  // --- 身份 / 资料 ---
  rpc.register('profile.get', () => ({ profile: { ...profile }, identity: identity.describe(profile) }));
  rpc.register('profile.update', (patch) => saveProfile({
    nickname: typeof patch.nickname === 'string' ? patch.nickname.slice(0, 60) : undefined,
    bio: typeof patch.bio === 'string' ? patch.bio.slice(0, 500) : undefined,
  }));
  /**
   * 导出身份备份。规划 §5.1 要求提供安全的备份与恢复说明，
   * 所以这里把「导出的是什么、意味着什么」连同数据一起返回，而不是只给一个字符串。
   */
  rpc.register('identity.export', () => ({
    warning: '这是你的身份私钥。任何拿到它的人都能完全冒充你。请离线保存，不要粘贴到聊天、云盘或任何节点。',
    record: identity.exportSecret(),
  }));

  // --- 会话（供分享/直播对话框选择与预览）---
  rpc.register('sessions.list', async () => {
    const sessionQuery = requireService(ctx, 'sessionQuery', '列出会话');
    const records = await sessionQuery.listSessions();
    const titles = await Promise.all((records ?? []).slice(0, 200).map(async (record) => {
      try {
        const title = await sessionQuery.readTitle(record.header.id);
        return title?.title ?? null;
      } catch {
        return null;
      }
    }));
    return (records ?? []).slice(0, 200).map((record, index) => ({
      sessionId: record.header.id,
      title: titles[index],
      createdAt: record.header.createdAt,
      live: record.live,
      persisted: record.persisted,
      authorized: consent.isAuthorized(record.header.id),
      liveRoom: live.findBySession(record.header.id)?.describe() ?? null,
    }));
  });

  rpc.register('sessions.preview', async ({ sessionId }) => {
    if (typeof sessionId !== 'string') throw new TypeError('sessionId 必填');
    const records = await readLedgerEvents(sessionId);
    // 预览只按内容类型归类，不套用授权粒度——预览的意义正是让用户在看到内容后再决定。
    return {
      sessionId,
      total: records.length,
      items: records.map((record) => ({
        seq: record.seq,
        type: record.type,
        contentKind: record.contentKind,
        role: record.contentKind === 'prompt' ? 'user' : 'assistant',
        text: record.text,
        // 预览阶段也过一遍脱敏，让用户看到"实际会发出去的样子"。
        redacted: redaction.apply({ text: record.text }),
      })),
    };
  });

  // --- 授权（同意机制）---
  rpc.register('consent.summary', () => consent.summary());
  rpc.register('consent.authorize', ({ sessionId, mode, contentKinds, scope, previewed, ttlMs }) =>
    consent.authorize(sessionId, { mode, contentKinds, scope, previewed, ttlMs }));
  rpc.register('consent.revoke', ({ sessionId }) => ({ revoked: consent.revoke(sessionId) }));
  rpc.register('consent.revokeAll', () => ({ revoked: consent.revokeAll('user-panic-button') }));

  // --- 分享 ---
  rpc.register('share.create', async (payload) => {
    const share = await shares.create(payload.sessionId, payload);
    // 规划 §10.3「公开会话分享」：生成内容对象和哈希、签名之后，
    // 由在线节点传播**目录信息**（这里只发分享对象本身；它不含源会话 id，
    // 且已经过脱敏与授权过滤）。私密范围不发——那需要先加密再点对点分发密钥。
    if (share.policy.scope === 'public') {
      let announced = 0;
      for (const peer of transport.peers()) {
        if (sendTo(peer.peerKey, MESSAGE_KIND.SHARE_ANNOUNCE, { share })) announced += 1;
      }
      logger.info('已创建分享对象并公告给在线节点', { id: share.id, announced });
      return { ...share, announcedTo: announced };
    }
    return { ...share, announcedTo: 0 };
  });
  rpc.register('share.list', () => shares.list());
  rpc.register('share.get', ({ id }) => {
    const share = shares.get(id);
    if (!share) throw new Error('分享不存在');
    return { share, verdict: shares.verify(share) };
  });
  rpc.register('share.revoke', ({ id }) => ({ revoked: shares.revoke(id) }));
  rpc.register('share.verify', ({ share }) => shares.verify(share));

  /**
   * 「复制为新会话」（规划 §6.6）。
   *
   * 用官方现成的 `ctx.sessions.fork(source, boundary, childSessionId)`：它是按 seq 分叉的，
   * 所以「复制」= 在原会话的某个边界上开一个新会话，而不是把文本重新灌一遍。
   * 注意这**不会**修改原作者的内容（规划 §6.6 表格里明确写了「是否修改原作者内容：否」）。
   */
  rpc.register('share.clone', async ({ id, atSeq }) => {
    const share = shares.get(id);
    if (!share) throw new Error('分享不存在');
    if (share.policy.copyable !== true) {
      throw Object.assign(new Error('作者未允许复制该分享'), { code: 'dsh-chat/not-copyable' });
    }
    const verdict = shares.verify(share);
    if (!verdict.integrity || !verdict.authenticity) {
      throw Object.assign(new Error('分享未通过校验，拒绝复制'), { code: 'dsh-chat/share-invalid', detail: verdict });
    }
    // 只有本机自己的会话才能被 fork（fork 需要本机有这条会话日志）。
    const sourceSessionId = shares.sourceSessionOf(share.id);
    if (!sourceSessionId) {
      throw Object.assign(new Error('该分享来自远端节点，本机没有对应会话日志，无法 fork；请先导出再导入'), {
        code: 'dsh-chat/no-local-session',
      });
    }
    const childId = `dsh-chat-clone-${randomId('s')}`;
    const boundary = Number.isInteger(atSeq) ? atSeq : undefined;
    await requireService(ctx, 'sessions', '派生会话').fork(sourceSessionId, boundary, childId);
    return { childSessionId: childId, sourceSessionId };
  });

  // --- 直播 ---
  rpc.register('live.list', () => live.listRooms());
  rpc.register('live.watched', () => live.listWatched());
  rpc.register('live.open', (payload) => live.open(payload.sessionId, payload));
  rpc.register('live.pause', ({ roomId }) => live.pause(roomId));
  rpc.register('live.resume', ({ roomId }) => live.resume(roomId));
  rpc.register('live.close', ({ roomId, keepReplay }) => live.close(roomId, { keepReplay }));
  rpc.register('live.publishReplay', ({ roomId }) => live.publishReplay(roomId));
  rpc.register('live.snapshot', ({ roomId, sinceSeq }) => {
    const room = live.getRoom(roomId);
    if (!room) throw new Error('直播间不存在');
    return room.snapshot({ sinceSeq: sinceSeq ?? 0 });
  });
  rpc.register('live.chat', ({ roomId, text, from }) => {
    const room = live.getRoom(roomId);
    if (!room) throw new Error('直播间不存在');
    const message = {
      id: randomId('chat'),
      at: Date.now(),
      from: String(from ?? profile.nickname ?? '我').slice(0, 40),
      text: String(text ?? '').slice(0, 1000),
      local: true,
    };
    room.addChat(message);
    // 观众聊天是本地房间行为；MVP 不把它广播到全网（规划 §7.5 把聊天室与直播事件分开）。
    sse.broadcast('live', { kind: 'chat', roomId, message });
    return message;
  });

  // --- 好友 / 关注 ---
  rpc.register('peers.list', () => peers.list().map((peer) => ({
    ...peer,
    relayed: relayClient.isRelayed(peer.peerKey),
    /** 有没有拿到对方的加密公钥 —— 没有就发不了加密私聊，界面要据此禁用发送。 */
    canEncrypt: Boolean(peerDocuments.get(peer.peerKey)?.encryptionKeyId
      ?? knownEncryptionKeys.get(peer.peerKey)),
  })));
  rpc.register('peers.discovered', () => transport.discovered());
  rpc.register('peers.connected', () => transport.peers());
  rpc.register('peers.invite', () => ({ invite: transport.createInvite(), address: transport.address }));
  rpc.register('peers.connect', async ({ address }) => {
    const peerKey = await transport.connect(address);
    return { peerKey, peers: transport.peers() };
  });
  rpc.register('peers.request', ({ peerKey, note }) => {
    const description = peers.requestFriend(peerKey, { note, delivered: false });
    const delivered = sendTo(peerKey, MESSAGE_KIND.FRIEND_REQUEST, { note: note ?? '', nickname: profile.nickname });
    if (delivered) peers.requestFriend(peerKey, { note, delivered: true });
    return { ...peers.describe(peerKey), delivered };
  });
  rpc.register('peers.respond', ({ peerKey, accepted }) => {
    const description = accepted ? peers.acceptFriend(peerKey) : peers.rejectFriend(peerKey);
    sendTo(peerKey, MESSAGE_KIND.FRIEND_RESPONSE, { accepted: accepted === true });
    sse.broadcast('peers', { reason: 'responded', peerKey });
    return description;
  });
  rpc.register('peers.remove', ({ peerKey }) => peers.removeFriend(peerKey));
  rpc.register('peers.block', ({ peerKey, reason }) => peers.block(peerKey, reason));
  rpc.register('peers.unblock', ({ peerKey }) => peers.unblock(peerKey));
  rpc.register('peers.follow', ({ peerKey }) => peers.follow(peerKey));
  rpc.register('peers.unfollow', ({ peerKey }) => peers.unfollow(peerKey));

  // --- 私聊 ---
  rpc.register('messages.list', ({ peerKey }) => messagesLog.readAll()
    .filter((message) => !peerKey || message.peerKey === peerKey)
    .slice(-200)
    .reverse());
  rpc.register('messages.send', ({ peerKey, text }) => {
    if (!peers.isFriend(peerKey)) {
      throw Object.assign(new Error('只能给好友发私聊；请先建立好友关系'), { code: 'dsh-chat/not-friend' });
    }
    if (!peers.acceptsMessagesFrom(peerKey)) throw new Error('已拉黑该身份');
    const body = String(text ?? '').slice(0, 20000);
    if (body.length === 0) throw new Error('消息不能为空');

    /**
     * 私聊一律**加密后**再发出。
     *
     * 这不是"加个选项"：中继对明文私聊是**直接拒绝转发**的（见 relay.js 的 classifyForward），
     * 所以不加密的话，经过中继的消息根本发不出去。加密是这条链路的必要条件。
     *
     * 收件人的加密公钥来自两个来源，都必须可验证：
     *   1. 直连握手时对方公告的 `encryptionKeyId`；
     *   2. 中继转交的**自签名身份文档**（中继只能转交，伪造不了）。
     */
    const recipientDoc = peerDocuments.get(peerKey) ?? null;
    const recipientEncryptionKeyId = recipientDoc?.encryptionKeyId
      ?? knownEncryptionKeys.get(peerKey)
      ?? null;
    if (!recipientEncryptionKeyId) {
      throw Object.assign(
        new Error('还不知道对方的加密公钥，无法发加密消息。请先直连一次，或通过中继查询其身份文档。'),
        { code: 'dsh-chat/no-encryption-key', detail: { peerKey } },
      );
    }

    const sealed = identity.encryptFor(recipientEncryptionKeyId, { text: body, at: Date.now() });
    const ok = sendTo(peerKey, MESSAGE_KIND.DIRECT_MESSAGE, sealed);
    const relayed = !transport.directTransport.peers().some((peer) => peer.peerKey === peerKey);
    const message = {
      id: randomId('msg'),
      direction: 'out',
      peerKey,
      at: Date.now(),
      text: body,
      delivered: ok,
      encrypted: true,
      relayed,
    };
    messagesLog.append(message);
    sse.broadcast('messages', message);
    return message;
  });

  // --- 插件目录 ---
  rpc.register('directory.list', () => directory.list());
  rpc.register('directory.ratings', ({ pluginId }) => directory.ratingsFor(pluginId));
  rpc.register('directory.rate', ({ pluginId, version, scores, text, experience }) =>
    directory.rate(pluginId, { version, scores, text, experience: experience ?? EXPERIENCE.UNKNOWN }));
  rpc.register('directory.helpful', ({ pluginId, contentHash }) => directory.markHelpful(pluginId, contentHash));
  rpc.register('directory.report', ({ pluginId, contentHash, reason }) => directory.report(pluginId, contentHash, reason));
  rpc.register('directory.publish', (payload) => directory.publishManifest(payload));
  rpc.register('directory.broadcast', ({ pluginId }) => {
    const manifest = directory.resolveVersion(pluginId);
    if (!manifest) throw new Error('本机没有该插件的签名清单');
    let sent = 0;
    for (const peer of transport.peers()) {
      if (sendTo(peer.peerKey, MESSAGE_KIND.PLUGIN_MANIFEST, { manifest })) sent += 1;
    }
    return { sent };
  });

  // --- 中继 ---
  rpc.register('relay.status', () => ({
    enabled: config.relay.enabled,
    /** 本机是否在对外提供中继服务。 */
    serving: Boolean(relayServer),
    /**
     * 可达性证据：**只统计别人主动连进来的次数**。
     * 「我在配置里开了 serve」和「真的有人连得进来」是两回事，界面必须分开显示。
     */
    reachability: (() => {
      const report = reachabilityMonitor.report();
      const proven = report.state === REACHABILITY.PROVEN;
      const serveWanted = config.relay.serve === true || config.relay.serve === 'auto';
      return {
        state: report.state,
        inboundPeers: report.inbound.count,
        outboundPeers: report.outbound.count,
        lastInboundAt: report.inbound.lastAt,
        verdict: proven ? 'reachable' : serveWanted ? 'unproven' : 'client-only',
        localVerdict: report.local.verdict,
        localReason: report.local.reason,
        note: proven
          ? `实测有节点主动连入过 ${report.inbound.count} 次，本机可以被当作中继。`
          : serveWanted
            ? '已配置为提供中继服务，但**还没有任何节点成功连入过** —— 如果你在 NAT 后面，别人是连不进来的。'
              + '（判断依据是实测，不是"我的 IP 看起来是公网"。）'
            : '本机只使用别人的中继，不对外提供服务。',
      };
    })(),
    server: relayServer?.metrics ?? null,
    client: relayClient.metrics,
    servers: relayClient.relays(),
    relayedPeers: relayClient.relayedPeers().map((peer) => ({
      peerKey: peer.peerKey,
      nickname: peer.document?.nickname ?? null,
      viaRelay: peer.viaRelay,
      lastSeen: peer.lastSeen,
    })),
  }));

  rpc.register('relay.add', async ({ address }) => {
    if (typeof address !== 'string' || address.length === 0) throw new TypeError('address 必填');
    const peerKey = await transport.addRelay(address);
    if (!peerKey) throw Object.assign(new Error('中继未接受登记（可能已满或地址不对）'), { code: 'dsh-chat/relay-refused' });
    sse.broadcast('relay', { reason: 'added', address });
    return { peerKey, servers: relayClient.relays() };
  });

  rpc.register('relay.lookup', ({ peerKey }) => {
    const known = peerDocuments.get(peerKey) ?? null;
    if (known) return { document: known, cached: true };
    relayClient.lookup(peerKey);
    return { document: null, cached: false, note: '已向中继发起查询，结果会通过实时推送到达。' };
  });

  rpc.register('live.swarm', () => ({
    policy: swarm.policy,
    metrics: swarm.metrics,
    /** 各房间当前的可用性快照：谁手上有到第几号事件。 */
    availability: Object.fromEntries(
      (live.listRooms?.() ?? []).map((room) => [
        room.id ?? room.roomId,
        swarm.availability(room.id ?? room.roomId).map((entry) => ({
          peerKey: entry.peerKey, upToSeq: entry.upToSeq,
        })),
      ]),
    ),
    note: '会话内分发与"给陌生人当中继"是两件事：你已经在看这场直播、已经收到数据，'
      + '转给同房间观众不额外消耗下载，却直接决定发布者扛不扛得住。',
  }));

  rpc.register('reachability', () => {
    const report = reachabilityMonitor.report();
    const suggestion = reachabilityMonitor.shouldSuggestServing({ alreadyServing: Boolean(relayServer) });
    return {
      state: report.state,
      reason: report.reason,
      /** L1：本机地址分类 —— 只有否定结论可靠。 */
      local: {
        verdict: report.local.verdict,
        reason: report.local.reason,
        publicV4: report.local.publicV4,
        publicV6Count: report.local.publicV6.length,
        hasCgnat: report.local.hasCgnat,
        interfaces: report.local.entries.map((entry) => ({
          name: entry.name, address: entry.address, class: entry.class,
        })),
      },
      /** L2：中继看到的来源地址数量（不把对端看到的地址本身暴露给界面以外的日志）。 */
      observations: report.observations.length,
      /** L3：入站实证。这才是判据。 */
      inbound: report.inbound,
      probes: report.probes,
      serving: Boolean(relayServer),
      serveConfig: config.relay.serve,
      suggestion,
    };
  });

  rpc.register('reachability.prove', async () => {
    if (!transport.address) return { ok: false, reason: 'transport-not-started' };
    const result = await transport.proveReachable(transport.address);
    reachabilityMonitor.noteProbeConfirmation(result.ok === true);
    sse.broadcast('reachability', result);
    return result;
  });

  rpc.register('relay.reputation', () => ({
    /** 本机实测出来的中继信誉排序。他人证明只作参考，永远压不过本地实测。 */
    relays: describeLedger(transport.ledger),
    contribution: transport.ledger.contribution(),
    /** 打洞统计：省下了多少中继带宽。 */
    punch: transport.punch.metrics,
    note: '信誉只反映本机的实测经历。一台中继可以一直表现良好再突然作恶 —— '
      + '这是历史记录，不是保证。',
  }));

  rpc.register('relay.punch', async ({ peerKey }) => {
    if (typeof peerKey !== 'string' || peerKey.length === 0) throw new TypeError('peerKey 必填');
    if (!config.relay.punch.enabled) {
      return { ok: false, reason: 'punch-disabled', note: '打洞在配置里被关掉了（relay.punch.enabled）' };
    }
    return transport.punchWith(peerKey);
  });

  rpc.register('relay.ensureReachable', async ({ peerKey }) => {
    if (typeof peerKey !== 'string' || peerKey.length === 0) throw new TypeError('peerKey 必填');
    /** 三级决策：已经直连 → 直连；试打通 → 直连；否则 → 中继兜底。 */
    return transport.ensureReachable(peerKey);
  });

  rpc.register('relay.setServing', ({ serve }) => ({
    accepted: false,
    note: '中继服务开关属于启动期配置（relay.serve），需要改 cordis.patch.yml 并重启 DSH 才能生效。'
      + '当前状态：' + (relayServer ? '正在提供' : '未提供'),
    requested: serve,
  }));

  // --- 节点设置 ---
  rpc.register('node.snapshot', () => nodeSnapshot());
  rpc.register('node.pauseAll', () => {
    // 规划 §9.2「一键暂停所有节点贡献」。
    const revoked = consent.revokeAll('pause-all');
    for (const room of live.listRooms()) {
      if (room.status !== 'ended') {
        try {
          live.close(room.id, { keepReplay: false, reason: 'pause-all' });
        } catch {
          // 已经结束了。
        }
      }
    }
    return { revokedGrants: revoked, revokedAt: Date.now() };
  });
  rpc.register('node.contribution', ({ contribution }) => {
    // 贡献设置里只有"暂停"是即时生效的；其余是声明值，改完需要重启插件。
    if (!contribution || typeof contribution !== 'object') throw new TypeError('contribution 必填');
    for (const role of contribution.roles ?? []) {
      if (!Object.values(NODE_ROLE).includes(role)) throw new TypeError(`未知节点角色: ${role}`);
    }
    return {
      accepted: true,
      note: '配置已接收。当前进程内实际生效的只有「一键暂停」；角色、限速与容量上限需要通过 cordis.patch.yml 配置并重启 DSH 后生效。',
      received: contribution,
    };
  });
  rpc.register('node.invite', () => ({ invite: transport.createInvite(), address: transport.address }));

  // ===== 生命周期 =====
  // 一切都注册在 ctx.effect 里：插件卸载时监听器、路由、定时器会被一并清理。
  ctx.effect(() => {
    const stopCapture = capture.attach(ctx);
    return () => stopCapture();
  }, 'dsh-chat: 订阅会话事件');

  ctx.effect(() => {
    try {
      const disposeRpc = rpc.install();
      recordBoot('rpc-mounted', { path: RPC_PATH });
      return () => disposeRpc();
    } catch (error) {
      // 挂不上路由是最致命的一种失败：客户端会看到"无法访问 Host 半体"，
      // 而真正的原因（端口冲突 / 通道不可用）必须留下来。
      recordBoot('rpc-mount-failed', { message: error?.message, stack: error?.stack?.split('\n').slice(0, 6) });
      logger.error('RPC 挂载失败；界面将无法与 Host 通信', { message: error?.message });
      return () => {};
    }
  }, 'dsh-chat: 挂载 RPC 与 SSE');

  ctx.effect(() => {
    let stopped = false;
    transport.start().then(async () => {
      if (!config.relay.enabled) return;
      for (const address of config.relay.servers) {
        try {
          const peerKey = await transport.addRelay(address);
          logger.info('已接入配置的中继', { address, ok: Boolean(peerKey) });
        } catch (error) {
          logger.warn('接入配置的中继失败', { address, message: error?.message });
        }
      }
    }).catch((error) => {
      logger.error('节点启动失败；插件其余部分仍可用，但不会有网络功能', { message: error?.message });
    });
    return () => {
      if (stopped) return;
      stopped = true;
      transport.stop().catch((error) => logger.warn('节点停止失败', { message: error?.message }));
    };
  }, 'dsh-chat: 启动节点');

  // 本机已装插件（未签名）进入目录，供"我的插件"展示。
  // 来源是 clientModules 的启动图，拿不到就跳过——不要为此让插件加载失败。
  try {
    const graph = ctx.get?.('clientModules')?.graph?.();
    if (graph?.entries) {
      directory.ingestLocal(graph.entries.map((entry) => ({
        name: entry.id,
        version: entry.rev ?? '0.0.0',
        description: '本机已加载的 Web 插件包（未签名，来源不可验证）',
      })));
    }
  } catch (error) {
    logger.debug('读取本机插件列表失败', { message: error?.message });
  }

  logger.info('dsh-chat 已就绪', {
    fingerprint: identity.fingerprint,
    dataDir,
    sharingDefault: config.privacy.defaultSharingMode,
    contributionRoles: config.contribution.roles.join(','),
  });
}

export {
  ACCESS_SCOPE, CONTENT_KINDS, LIVE_EVENT, SHARING_MODE, SHARING_MODES, RATING_DIMENSIONS,
};
