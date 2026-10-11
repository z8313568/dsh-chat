/**
 * 会话直播（规划 §7）。
 *
 * 规划对这一块的要求很具体，逐条对应到实现：
 *   §7.2 开播设置 → LiveRoom 的 title/tags/summary/scope/mode/contentKinds
 *   §7.4 事件驱动   → 不重发整段会话，只发有序事件（本文件的 LIVE_EVENT）
 *   §7.4 序号/去重  → 每条事件带 seq；接收端按 (roomId, seq) 去重、能发现空洞并请求补拉
 *   §7.2 暂停广播   → pause() 立刻停止推进 seq，且不影响本地会话继续跑
 *   §7.5 回放       → close({ keepReplay: true }) 把事件留成回放对象
 *   §7.7 一键结束   → close() 幂等，重复调用安全
 *
 * 一个关键取舍：**事件序号严格由主播推进，观众只读。**
 * 观众的聊天消息走另一条通道（room chat），不占直播事件序号，
 * 这样即使观众掉线重连、乱序到达，也不会污染主播的事件序列。
 */
import { LIVE_EVENT, LIVE_STATUS, isAccessScope, randomId } from '../shared/protocol.js';
import { contentHashOf } from './identity.js';

/** 观众重连时一次最多补多少条，防止一个老客户端把整个回放拖出来。 */
const DEFAULT_BACKFILL = 500;

/** 直播间观众聊天里允许的最大条数（环形保留）。 */
const MAX_CHAT_MESSAGES = 500;

/** 观众侧镜像保留的最大事件条数。 */
const MAX_MIRROR_EVENTS = 2000;

/** 一条直播事件去掉签名后参与签名的部分。 */
function signingPayload(event) {
  return {
    roomId: event.roomId,
    seq: event.seq,
    type: event.type,
    at: event.at,
    payload: event.payload,
  };
}

export class LiveError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'LiveError';
    this.code = detail.code ?? 'dsh-chat/live-error';
    this.detail = detail;
  }
}

/**
 * 直播间。
 *
 * 注意 `status` 与 `paused` 是两件事：
 *   - status='ended' 表示这场直播结束了；
 *   - paused=true 表示还在播，但此刻不外发任何内容（规划 §7.2：暂停广播不应影响本地 DSH 会话）。
 * 用 status 表达暂停会让「恢复」变成「重新开播」，那会让观众看到第二个直播间。
 */
export class LiveRoom {
  #events = [];
  #chat = [];
  #listeners = new Set();
  #maxEvents;

  constructor({ id, sessionId, host, config, title, tags, summary, scope, mode, contentKinds, createdAt }) {
    this.id = id;
    this.sessionId = sessionId;
    this.host = host;
    this.title = title;
    this.tags = tags;
    this.summary = summary;
    this.scope = scope;
    this.mode = mode;
    this.contentKinds = contentKinds;
    this.createdAt = createdAt;
    this.status = LIVE_STATUS.LIVE;
    this.paused = false;
    this.seq = 0;
    this.startedAt = createdAt;
    this.endedAt = null;
    this.keepReplay = false;
    this.replayPublished = false;
    this.viewerCount = 0;
    this.eventCount = 0;
    this.droppedEvents = 0;
    // 环形容量与「单次补拉上限」是两件事：
    //   maxRetainedEvents 决定回放能往回看多久，maxBackfillEvents 决定一次请求最多给多少条。
    // 混用同一个配置会让"把补拉上限调小"意外地把回放也截短。
    this.#maxEvents = Math.max(config.live.maxRetainedEvents, config.live.maxBackfillEvents);
  }

  /** 订阅本房间的事件流（SSE 与测试都用它）。 */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emitLive(event) {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // 单个订阅者出错不能影响其它订阅者，也不能影响主播的事件推进。
      }
    }
  }

  /**
   * 追加一条已签名事件。seq 由这里唯一分配，调用方不得自带。
   * @param {string} type LIVE_EVENT 之一
   * @param {object} payload 已经过脱敏的内容
   * @param {(value: object) => string} signer 签名函数
   */
  append(type, payload, signer) {
    const event = {
      roomId: this.id,
      seq: this.seq + 1,
      type,
      at: Date.now(),
      payload,
    };
    event.sig = signer(signingPayload(event));
    this.seq = event.seq;
    this.eventCount += 1;

    this.#events.push(event);
    // 环形裁剪：只影响「新观众能回看多久」，不影响已经发出的直播。
    if (this.#events.length > this.#maxEvents) {
      const overflow = this.#events.length - this.#maxEvents;
      this.#events.splice(0, overflow);
      this.droppedEvents += overflow;
    }
    this.#emitLive(event);
    return event;
  }

  /** 从某序号之后的事件，用于重连补洞（规划 §7.4「重连后可以请求缺失的公开事件」）。 */
  eventsSince(sinceSeq, limit = DEFAULT_BACKFILL) {
    const from = Number.isFinite(sinceSeq) ? Math.max(0, Math.floor(sinceSeq)) : 0;
    const slice = this.#events.filter((event) => event.seq > from);
    const bounded = slice.length > limit ? slice.slice(0, limit) : slice;
    return {
      events: bounded,
      /** 最早还能拿到的事件序号；调用方发现 sinceSeq+1 < oldestSeq 就知道中间已经裁掉了。 */
      oldestSeq: this.#events.length > 0 ? this.#events[0].seq : null,
      latestSeq: this.seq,
      truncated: bounded.length < slice.length,
      /** 已经被环形裁剪掉的条数，观众据此知道回放不完整。 */
      droppedEvents: this.droppedEvents,
    };
  }

  /** 完整状态快照，新观众进场或断线重连时用。 */
  snapshot({ sinceSeq = 0 } = {}) {
    const backfill = this.eventsSince(sinceSeq);
    return {
      room: this.describe(),
      events: backfill.events,
      oldestSeq: backfill.oldestSeq,
      latestSeq: backfill.latestSeq,
      truncated: backfill.truncated,
      droppedEvents: backfill.droppedEvents,
      chat: [...this.#chat],
    };
  }

  /** 可公开的房间描述（不含任何会话正文）。 */
  describe() {
    return {
      id: this.id,
      sessionId: this.sessionId,
      host: this.host,
      title: this.title,
      tags: [...this.tags],
      summary: this.summary,
      scope: this.scope,
      mode: this.mode,
      contentKinds: [...this.contentKinds],
      status: this.status,
      paused: this.paused,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      seq: this.seq,
      eventCount: this.eventCount,
      droppedEvents: this.droppedEvents,
      viewerCount: this.viewerCount,
      replayPublished: this.replayPublished,
    };
  }

  /** 观众聊天（规划 §7.3 右侧聊天室）。 */
  addChat(message) {
    this.#chat.push(message);
    if (this.#chat.length > MAX_CHAT_MESSAGES) this.#chat.splice(0, this.#chat.length - MAX_CHAT_MESSAGES);
    this.#emitLive({ roomId: this.id, seq: this.seq, type: 'chat', at: message.at, payload: message });
    return message;
  }

  get chat() {
    return [...this.#chat];
  }

  get events() {
    return [...this.#events];
  }
}

/**
 * 直播引擎：管理本机开出的所有直播间，并把采集到的会话记录翻译成直播事件。
 */
export class LiveEngine {
  #config;
  #identity;
  #consent;
  #redaction;
  #logger;
  #profile;
  #rooms = new Map();
  #mirrors = new Map();
  #listeners = new Set();
  #mirrorListeners = new Set();
  #transientChunkListeners = new Set();

  constructor({ config, identity, consent, redaction, logger = null, profile = () => ({}) }) {
    this.#config = config;
    this.#identity = identity;
    this.#consent = consent;
    this.#redaction = redaction;
    this.#logger = logger;
    this.#profile = profile;
  }

  /** 有没有正在进行的直播（界面顶栏用它显示状态）。 */
  get activeRoom() {
    for (const room of this.#rooms.values()) {
      if (room.status === LIVE_STATUS.LIVE || room.status === LIVE_STATUS.PAUSED) return room;
    }
    return null;
  }

  listRooms() {
    return [...this.#rooms.values()].map((room) => room.describe());
  }

  getRoom(roomId) {
    return this.#rooms.get(roomId) ?? null;
  }

  findBySession(sessionId) {
    for (const room of this.#rooms.values()) {
      if (room.sessionId === sessionId && room.status !== LIVE_STATUS.ENDED) return room;
    }
    return null;
  }

  /** 订阅房间增删改，SSE 用它推给界面。 */
  onRoomChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 订阅某个房间的直播事件。 */
  onRoomEvent(roomId, listener) {
    const room = this.#rooms.get(roomId);
    if (!room) throw new LiveError('直播间不存在', { code: 'dsh-chat/room-not-found', roomId });
    // 只挂在房间自己的订阅表上。
    // 早先这里同时又往引擎的 #roomListeners 里放了一份，而 ingest() 也会手动 fan-out，
    // 结果是每个订阅者收到两遍——测试「第二个订阅者收到几条」时才暴露出来。
    // 保持单一投递路径：LiveRoom.append → #emitLive → 订阅者。
    return room.subscribe(listener);
  }

  /** token 级瞬时帧（打字机效果）。不落盘、不签名、可丢。 */
  onTransientChunk(listener) {
    this.#transientChunkListeners.add(listener);
    return () => this.#transientChunkListeners.delete(listener);
  }

  #notifyRooms() {
    for (const listener of this.#listeners) {
      try {
        listener(this.listRooms());
      } catch {
        // 界面订阅者出错不影响引擎。
      }
    }
  }

  /**
   * 开播。
   *
   * 之前必须先 authorize()——本方法不自己授权，只消费授权。
   * 这样「开播」与「同意」就是同一个动作的两半，不可能只发生一半。
   */
  open(sessionId, {
    title,
    tags = [],
    summary = '',
    scope = 'public',
    mode = null,
    contentKinds = null,
    previewed = false,
  } = {}) {
    if (this.findBySession(sessionId)) {
      throw new LiveError('该会话已经在直播中', { code: 'dsh-chat/already-live', sessionId });
    }
    const active = [...this.#rooms.values()].filter((r) => r.status !== LIVE_STATUS.ENDED);
    if (active.length >= this.#config.live.maxConcurrentRooms) {
      throw new LiveError('同时进行的直播数已达上限', {
        code: 'dsh-chat/too-many-rooms', limit: this.#config.live.maxConcurrentRooms,
      });
    }
    if (!isAccessScope(scope)) throw new LiveError(`未知访问范围: ${scope}`, { code: 'dsh-chat/bad-scope' });

    // 授权与开播在同一步完成：没有授权就没有直播间。
    const grant = this.#consent.authorize(sessionId, {
      mode, contentKinds, scope, previewed, reason: 'live-open',
    });

    const identity = this.#profile();
    const room = new LiveRoom({
      id: randomId('room'),
      sessionId,
      host: {
        publicKeyId: this.#identity.publicKeyId,
        fingerprint: this.#identity.fingerprint,
        nickname: identity.nickname ?? null,
        avatar: identity.avatar ?? null,
      },
      config: this.#config,
      title: typeof title === 'string' && title.trim() ? title.trim() : '未命名直播',
      tags: Array.isArray(tags) ? tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()).slice(0, 8) : [],
      summary: typeof summary === 'string' ? summary : '',
      scope: grant.scope,
      mode: grant.mode,
      contentKinds: [...grant.contentKinds],
      createdAt: Date.now(),
    });

    this.#rooms.set(room.id, room);
    const signer = (value) => this.#identity.sign(value);
    room.append(LIVE_EVENT.SESSION_STARTED, {
      title: room.title,
      tags: room.tags,
      summary: room.summary,
      mode: room.mode,
      scope: room.scope,
      host: room.host,
      contentId: contentHashOf({ title: room.title, tags: room.tags, summary: room.summary }),
    }, signer);

    this.#logger?.info?.('已开播', { roomId: room.id, sessionId, mode: room.mode, scope: room.scope });
    this.#notifyRooms();
    return room;
  }

  /** 暂停广播。规划 §7.2：暂停不应影响本地 DSH 会话继续运行——这里只停 seq 推进。 */
  pause(roomId, reason = 'user-action') {
    const room = this.#requireActive(roomId);
    if (room.paused) return room.describe();
    room.paused = true;
    room.append(LIVE_EVENT.STREAM_PAUSED, { reason }, (value) => this.#identity.sign(value));
    this.#logger?.info?.('已暂停广播', { roomId, reason });
    this.#notifyRooms();
    return room.describe();
  }

  resume(roomId) {
    const room = this.#requireActive(roomId);
    if (!room.paused) return room.describe();
    room.paused = false;
    room.append(LIVE_EVENT.STREAM_RESUMED, {}, (value) => this.#identity.sign(value));
    this.#logger?.info?.('已恢复广播', { roomId });
    this.#notifyRooms();
    return room.describe();
  }

  /** 结束直播。幂等（规划 §7.7 一键结束）。 */
  close(roomId, { keepReplay = false, reason = 'user-action' } = {}) {
    const room = this.#rooms.get(roomId);
    if (!room) throw new LiveError('直播间不存在', { code: 'dsh-chat/room-not-found', roomId });
    if (room.status === LIVE_STATUS.ENDED) return room.describe();
    room.paused = false;
    room.status = LIVE_STATUS.ENDED;
    room.endedAt = Date.now();
    room.keepReplay = keepReplay === true;
    room.append(LIVE_EVENT.SESSION_ENDED, {
      reason,
      keepReplay: room.keepReplay,
      durationMs: room.endedAt - room.startedAt,
      eventCount: room.eventCount,
    }, (value) => this.#identity.sign(value));
    // 授权随直播一起结束：规划 §2.4 要求暂停/结束必须真的停止外发。
    this.#consent.revoke(room.sessionId, 'live-closed');
    this.#logger?.info?.('直播已结束', { roomId, keepReplay: room.keepReplay });
    this.#notifyRooms();
    return room.describe();
  }

  /** 发布回放（规划 §7.5「结束后按主播设置保存、隐藏或公开」）。 */
  publishReplay(roomId) {
    const room = this.#rooms.get(roomId);
    if (!room) throw new LiveError('直播间不存在', { code: 'dsh-chat/room-not-found', roomId });
    if (room.status !== LIVE_STATUS.ENDED) {
      throw new LiveError('直播尚未结束，无法发布回放', { code: 'dsh-chat/still-live', roomId });
    }
    room.keepReplay = true;
    room.replayPublished = true;
    this.#notifyRooms();
    return room.describe();
  }

  #requireActive(roomId) {
    const room = this.#rooms.get(roomId);
    if (!room) throw new LiveError('直播间不存在', { code: 'dsh-chat/room-not-found', roomId });
    if (room.status === LIVE_STATUS.ENDED) {
      throw new LiveError('直播已结束', { code: 'dsh-chat/room-ended', roomId });
    }
    return room;
  }

  /**
   * 采集器送来的 ledger record。这是「会话 → 直播事件」的唯一翻译点。
   *
   * 每个分支都先过 consent.check：即使房间开着，用户没勾选的内容类型也不会出去。
   * 脱敏在内容成形之后、签名之前——签名的对象必须已经是最终外发字节，
   * 否则签名证明了「未脱敏的原文」，等于把原文的哈希泄露出去。
   */
  ingest(record) {
    const room = this.findBySession(record.session.id);
    if (!room || room.status === LIVE_STATUS.ENDED) return null;
    if (room.paused) return null;
    if (record.contentKind === null) {
      // turn/step/session-title 这类没有正文的事件，只在标题变化时更新房间标题。
      if (record.type === 'session/title' && typeof record.body?.title === 'string') {
        room.title = record.body.title;
        this.#notifyRooms();
      }
      return null;
    }

    const verdict = this.#consent.check(record.session.id, record.contentKind, { scope: room.scope });
    if (!verdict.allowed) return null;

    const payload = this.#buildPayload(record);
    const redacted = this.#redaction.apply(payload);
    if (redacted.withheld) {
      // fail-closed：脱敏失败就不发，而不是发原文。
      this.#logger?.warn?.('直播事件被扣下（脱敏未通过）', {
        roomId: room.id, seq: record.seq, reasons: redacted.reasons,
      });
      return null;
    }

    const event = room.append(LIVE_EVENT.MESSAGE_ADDED, redacted.value, (value) => this.#identity.sign(value));
    return event;
  }

  /** 把 ledger record 变成直播事件的 payload。 */
  #buildPayload(record) {
    const base = {
      sessionSeq: record.seq,
      eventType: record.type,
      contentKind: record.contentKind,
      role: record.contentKind === 'prompt' ? 'user' : 'assistant',
      text: record.text ?? '',
      contentId: contentHashOf({ seq: record.seq, text: record.text ?? '' }),
      at: record.time,
    };
    if (record.contentKind === 'tool' && record.body) {
      return {
        ...base,
        role: 'tool',
        tool: {
          name: record.body.name ?? record.body.message?.source?.callId ?? null,
          isError: record.severity === 'error',
        },
      };
    }
    return base;
  }

  /**
   * token 级瞬时帧转发（规划 §7.4 的「实时」观感）。
   * 只转已授权会话，且只转文本增量；不落盘、不签名、可丢。
   */
  ingestChunk({ sessionId, frame }) {
    const room = this.findBySession(sessionId);
    if (!room || room.paused || room.status === LIVE_STATUS.ENDED) return;
    if (frame?.type !== 'chunk') return;
    const chunk = frame.chunk;
    if (!chunk || (chunk.type !== 'text-delta' && chunk.type !== 'reasoning-delta')) return;
    const contentKind = chunk.type === 'text-delta' ? 'answer' : 'reasoning';
    if (!this.#consent.check(sessionId, contentKind, { scope: room.scope }).allowed) return;

    const redacted = this.#redaction.apply({ text: chunk.text });
    if (redacted.withheld) return;
    const text = redacted.value?.text ?? '';
    if (text.length === 0) return;

    const packet = {
      roomId: room.id,
      seq: room.seq,
      index: frame.index,
      blockIndex: chunk.index,
      kind: chunk.type,
      text,
      at: Date.now(),
    };
    for (const listener of this.#transientChunkListeners) {
      try {
        listener(packet);
      } catch {
        // 瞬时帧丢了就丢了，不影响任何事实。
      }
    }
  }

  /**
   * 观众侧：接收远端节点发来的直播事件。
   *
   * 远端直播以「镜像」形式存在本地：本机不是主播，因此**不持有事件的所有权**，
   * 只维护「我看到的最高序号」。这样观众节点不会因为本地重排而改变主播的事实序列。
   *
   * 去重与空洞检测都在这里：
   *   - seq <= 已见最大序号 → 重复事件，丢弃（规划 §7.4 要求处理重复事件）；
   *   - seq > 已见最大序号 + 1 → 中间丢了事件，记进 gapSeqs 供上层触发补拉。
   */
  acceptRemoteEvent(roomId, event) {
    const mirror = this.#mirrors.get(roomId);
    if (!mirror) return false;
    if (!Number.isInteger(event?.seq) || event.seq <= mirror.latestSeq) return false;

    if (event.seq > mirror.latestSeq + 1) {
      mirror.gaps.push({ from: mirror.latestSeq + 1, to: event.seq - 1, at: Date.now() });
      // 只保留最近 32 个空洞描述，避免长时间弱网把内存吃满。
      if (mirror.gaps.length > 32) mirror.gaps.splice(0, mirror.gaps.length - 32);
    }
    mirror.latestSeq = event.seq;
    mirror.events.push(event);
    if (mirror.events.length > MAX_MIRROR_EVENTS) {
      mirror.events.splice(0, mirror.events.length - MAX_MIRROR_EVENTS);
    }
    this.#notifyMirrors(mirror);
    return true;
  }

  /** 建立/更新一个远端直播镜像。 */
  mirrorRemote(descriptor) {
    const existing = this.#mirrors.get(descriptor.id);
    if (existing) {
      existing.descriptor = descriptor;
      this.#notifyMirrors(existing);
      return existing;
    }
    const mirror = {
      descriptor,
      latestSeq: 0,
      events: [],
      gaps: [],
      chat: [],
      listeners: new Set(),
      startedAt: Date.now(),
    };
    this.#mirrors.set(descriptor.id, mirror);
    this.#notifyMirrors(mirror);
    return mirror;
  }

  getMirror(roomId) {
    return this.#mirrors.get(roomId) ?? null;
  }

  listWatched() {
    return [...this.#mirrors.values()].map((mirror) => ({
      ...mirror.descriptor,
      watchedLatestSeq: mirror.latestSeq,
      pendingGaps: mirror.gaps.length,
      receivedEvents: mirror.events.length,
    }));
  }

  unwatch(roomId) {
    return this.#mirrors.delete(roomId);
  }

  /** 订阅任意镜像房间的变化（观众界面用它刷新）。 */
  onMirrorChange(listener) {
    this.#mirrorListeners.add(listener);
    return () => this.#mirrorListeners.delete(listener);
  }

  #notifyMirrors(mirror) {
    for (const listener of this.#mirrorListeners) {
      try {
        listener(mirror);
      } catch {
        // 界面订阅者出错不影响网络接收。
      }
    }
  }

  /** 供界面展示的统计。 */
  get metrics() {
    return {
      rooms: this.listRooms(),
      watched: this.listWatched(),
      maxConcurrentRooms: this.#config.live.maxConcurrentRooms,
    };
  }
}

export { DEFAULT_BACKFILL, MAX_MIRROR_EVENTS, signingPayload };
