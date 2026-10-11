/**
 * DSH 适配层（规划 §10.1 第 2 层、§13.1「DSH 适配层」）。
 *
 * 职责：把 DSH 的会话事件，翻译成 dsh-chat 自己的、可签名可外发的记录。
 *
 * 这一层必须遵守三条由实测得出的硬约束（见 dsh-chat-会话事件接口验证报告 §七）：
 *
 *   1. `session/event` 的派发是**同步的，在 append 路径上**。官方 dsh-session-telemetry
 *      明确要求 handler 只能做非阻塞入队。这里因此：handler 内部只做 Map 查表 + 数组 push，
 *      绝不做 await、绝不发网络请求、绝不 JSON.stringify 大对象。
 *   2. **监听器抛错会被静默吞掉**（只写一条 warning）。所以这里自己兜住所有异常并计数，
 *      否则故障会表现为「界面莫名其妙不动了」而没有任何线索。
 *   3. `agent/assistant-stream` 是**进程内且瞬时的**——没接住就永久丢失，且跨进程不可依赖。
 *      所以它只用于「观感」（打字机效果），事实来源永远是带 seq 的 `session/event`。
 *
 * 另外一个刻意的设计：**未授权的会话在进入这一层时就被丢弃**。
 * 授权查表是一次 Map.get，代价可以忽略；而一旦判定未授权，事件连深拷贝都不会发生。
 * 也就是说，关着分享的会话，它的正文根本不会在 dsh-chat 的内存里留下副本。
 */
import { LIVE_EVENT } from '../shared/protocol.js';

/** 记录种类。与官方 session-telemetry 的 ledger record 保持同构语义，便于对齐。 */
export const RECORD_KIND = Object.freeze({
  SESSION_EVENT: 'session-event',
  ASSISTANT_CHUNK: 'assistant-chunk',
  LIFECYCLE: 'lifecycle',
});

/**
 * 只保留这些事件类型。这是「什么值得进入外发管道」的白名单。
 *
 * 白名单而不是黑名单：DSH 的事件表是会被上游扩充的（实测本版本 59 种），
 * 黑名单会在上游新增事件时静默泄露新类型的内容；白名单只会漏掉新类型，
 * 而漏掉的表现是「功能少了」而不是「隐私漏了」。
 */
const CAPTURED_EVENT_TYPES = Object.freeze([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'assistant/message',
  'assistant/attempt',
  'tool/call',
  'tool/result',
  'session/title',
]);

/** 内容类型归类：事件类型 → dsh-chat 的可分享内容类型。 */
const EVENT_CONTENT_KIND = Object.freeze({
  'user/message': 'prompt',
  'assistant/message': 'answer',
  'assistant/attempt': 'answer',
  'tool/call': 'tool',
  'tool/result': 'tool',
});

/** 深拷贝并冻结——事件对象是深冻结的，但我们要存的是自己的副本。 */
function cloneJson(value, depth = 0) {
  if (depth > 12) return '[深度截断]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => cloneJson(item, depth + 1));
  // 只搬运 JSON 能表达的东西；类实例（如 KeyObject、Buffer）一律降级成描述串。
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    if (value instanceof Uint8Array) return `[bytes:${value.byteLength}]`;
    return `[${value.constructor?.name ?? 'object'}]`;
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = cloneJson(item, depth + 1);
  return out;
}

/** 从用户消息里抽出纯文本，供预览与聊天区显示使用。 */
export function extractText(message) {
  if (!message) return '';
  const blocks = Array.isArray(message.content) ? message.content : [];
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[图片]');
    else if (block.type === 'file') parts.push(`[文件 ${block.attachment?.name ?? ''}]`);
    else if (block.type === 'tool-call') parts.push(`[工具调用 ${block.name ?? ''}]`);
  }
  return parts.join('\n').trim();
}

/** 该事件是否携带可展示的正文。 */
function hasBody(eventType) {
  return eventType === 'user/message' || eventType === 'assistant/message' || eventType === 'tool/result';
}

/**
 * 一条 SessionEvent → 一条 ledger record。
 * 返回值里刻意**不含** session cwd 这类本地事实，避免顺带泄露工作目录。
 */
export function toLedgerRecord(session, event) {
  const eventType = event.type;
  const isError = eventType === 'tool/result' && event.data?.error !== undefined;
  const body = hasBody(eventType) ? cloneJson(event.data) : null;
  return {
    kind: RECORD_KIND.SESSION_EVENT,
    session: { id: session.id },
    seq: event.seq,
    type: eventType,
    time: event.time,
    severity: isError ? 'error' : 'info',
    contentKind: EVENT_CONTENT_KIND[eventType] ?? null,
    /** 不含 data 的信封副本：外发时 data 只以 body 形式出现一次，避免同一份正文两条路径出门。 */
    envelope: { type: eventType, seq: event.seq, time: event.time },
    body,
    text: body ? extractText(body.message) : '',
  };
}

/**
 * 采集器。
 *
 * 用法：
 *   const capture = new Capture({ logger, shouldCapture, onRecord, onChunk });
 *   const stop = capture.attach(ctx);   // 内部 ctx.on(..., { global: true })
 */
export class Capture {
  #logger;
  #shouldCapture;
  #onRecord;
  #onChunk;
  #metrics = {
    eventsSeen: 0,
    eventsFiltered: 0,
    eventsCaptured: 0,
    eventsDropped: 0,
    handlerErrors: 0,
    chunksSeen: 0,
    chunksDropped: 0,
    lastEventAt: null,
  };
  #dedupe = new Map(); // sessionId -> Set<seq>（有界）
  #dedupeLimit;
  #stopped = false;

  constructor({
    logger = null,
    shouldCapture = () => false,
    onRecord = () => {},
    onChunk = () => {},
    dedupeLimit = 4096,
  } = {}) {
    this.#logger = logger;
    this.#shouldCapture = shouldCapture;
    this.#onRecord = onRecord;
    this.#onChunk = onChunk;
    this.#dedupeLimit = dedupeLimit;
  }

  get metrics() {
    return { ...this.#metrics };
  }

  /**
   * 挂到 cordis Context 上。返回卸载函数。
   * 注意 `{ global: true }`：不加的话监听器会被 context 过滤器限制，收不到其它 session 的事件。
   */
  attach(ctx) {
    const disposers = [];

    disposers.push(ctx.on('session/event', (session, event) => {
      // ===== 这里是同步热路径。只允许 O(1) 工作。=====
      try {
        this.#metrics.eventsSeen += 1;
        this.#metrics.lastEventAt = Date.now();

        const sessionId = session?.id;
        if (typeof sessionId !== 'string') return;

        // 1) 授权查表（一次 Map.get）。未授权直接返回，连拷贝都不做。
        if (!this.#shouldCapture(sessionId)) {
          this.#metrics.eventsFiltered += 1;
          return;
        }

        // 2) 类型白名单。
        if (!CAPTURED_EVENT_TYPES.includes(event?.type)) return;

        // 3) 去重：与官方一致，按 (session, seq) 判重。重放/重连时同一条会再来一次。
        if (!this.#markSeen(sessionId, event.seq)) return;

        // 4) 归一化并入队。
        const record = toLedgerRecord(session, event);
        this.#metrics.eventsCaptured += 1;
        try {
          this.#onRecord(record);
        } catch (error) {
          this.#metrics.eventsDropped += 1;
          this.#logger?.warn?.('入队失败，记录被丢弃', { sessionId, seq: event.seq, message: error?.message });
        }
      } catch (error) {
        // 上层会静默吞掉我们的异常，所以这里必须自己记账，否则故障不可见。
        this.#metrics.handlerErrors += 1;
        this.#logger?.warn?.('session/event 处理抛错（已吞掉以免打断 agent 主循环）', { message: error?.message });
      }
    }, { global: true }));

    disposers.push(ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      // token 级通道：只喂观感，不进事实链路，所以允许丢。
      try {
        this.#metrics.chunksSeen += 1;
        const sessionId = agent?.session?.id ?? agent?.id;
        if (typeof sessionId !== 'string') return;
        if (!this.#shouldCapture(sessionId)) return;
        this.#onChunk({ sessionId, frame });
      } catch (error) {
        this.#metrics.chunksDropped += 1;
        this.#metrics.handlerErrors += 1;
        this.#logger?.warn?.('assistant-stream 处理抛错（已吞掉）', { message: error?.message });
      }
    }, { global: true }));

    this.#logger?.info?.('已订阅 session/event 与 agent/assistant-stream', { global: true });

    return () => {
      this.#stopped = true;
      for (const dispose of disposers.reverse()) {
        try {
          dispose?.();
        } catch (error) {
          this.#logger?.warn?.('卸载监听器失败', { message: error?.message });
        }
      }
    };
  }

  /** 有界的判重集合：超过上限就丢掉最早的一半，保证内存不随会话长度增长。 */
  #markSeen(sessionId, seq) {
    let seen = this.#dedupe.get(sessionId);
    if (!seen) {
      seen = new Set();
      this.#dedupe.set(sessionId, seen);
    }
    if (seen.has(seq)) return false;
    seen.add(seq);
    if (seen.size > this.#dedupeLimit) {
      const keep = [...seen].slice(-Math.floor(this.#dedupeLimit / 2));
      this.#dedupe.set(sessionId, new Set(keep));
    }
    return true;
  }

  /** 会话结束后清掉判重状态。 */
  forget(sessionId) {
    this.#dedupe.delete(sessionId);
  }

  get stopped() {
    return this.#stopped;
  }
}

export { CAPTURED_EVENT_TYPES, EVENT_CONTENT_KIND, LIVE_EVENT };
