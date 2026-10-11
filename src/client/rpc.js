/**
 * 客户端到 Host 的通道（两条）。
 *
 * 1. **RPC**：`ctx.connection.rpc.call('/api', 'dsh-chat/rpc', { method, payload }, signal)`。
 *    第二个参数是**不带 `/api/` 前缀的端点名**，Host 侧注册的路径正是 `/api/dsh-chat/rpc`。
 *    这条路径继承 DSH 的浏览器认证，返回 `{ok:true,value}` 或 `{ok:false,error}`，
 *    传输层失败会直接抛错（与 dsh-im 的用法一致）。
 *
 * 2. **SSE**：`/dsh-chat/events?token=…`。这条路径没有认证，所以 token 必须先从 RPC 拿到。
 *    拿不到 token 时整个实时推送降级为轮询——界面功能不受影响，只是刷新变慢。
 */
const ENDPOINT = 'dsh-chat/rpc';
const CHANNEL = '/api';
const SSE_PATH = '/dsh-chat/events';

export class RpcError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = 'RpcError';
    this.code = code ?? 'dsh-chat/rpc-error';
    this.details = details ?? {};
  }
}

export function createHostClient(ctx) {
  let token = null;
  let eventSource = null;
  const listeners = new Map(); // event → Set<handler>
  let sseState = 'idle';

  function rpcAvailable() {
    return typeof ctx.connection?.rpc?.call === 'function';
  }

  async function call(method, payload = {}, signal) {
    if (!rpcAvailable()) {
      throw new RpcError('DSH 连接服务不可用，无法与插件 Host 通信', 'dsh-chat/no-connection');
    }
    let response;
    try {
      response = await ctx.connection.rpc.call(CHANNEL, ENDPOINT, { method, payload }, signal);
    } catch (cause) {
      throw new RpcError(
        '无法访问 dsh-chat 的 Host 半体，请确认插件已加载并检查 DSH 连接',
        'dsh-chat/unreachable',
        { method, cause: cause?.message },
      );
    }
    if (response?.ok === true) return response.value;
    const error = response?.error ?? {};
    throw new RpcError(error.message ?? 'Host 返回未知错误', error.code, error.details);
  }

  /** 首次调用时顺带取回 SSE token。 */
  async function handshake() {
    const info = await call('handshake');
    token = info?.token ?? null;
    return info;
  }

  function emit(event, data) {
    for (const handler of listeners.get(event) ?? []) {
      try {
        handler(data);
      } catch (error) {
        console.error('[dsh-chat] 事件处理失败', error);
      }
    }
  }

  /**
   * 打开实时推送。失败不抛错——轮询兜底由调用方决定。
   * @returns {() => void} 关闭函数
   */
  function subscribe(events, { onState } = {}) {
    if (sseState === 'unsupported') return () => {};
    if (typeof EventSource !== 'function') {
      sseState = 'unsupported';
      onState?.('unsupported');
      return () => {};
    }
    if (eventSource) return () => {};

    const start = () => {
      if (token === null) return;
      const source = new EventSource(`${SSE_PATH}?token=${encodeURIComponent(token)}`);
      eventSource = source;
      source.onopen = () => {
        sseState = 'open';
        onState?.('open');
      };
      source.onerror = () => {
        // EventSource 自带重连；这里只汇报状态，不主动关闭。
        sseState = 'reconnecting';
        onState?.('reconnecting');
      };
      for (const event of events) {
        source.addEventListener(event, (message) => {
          try {
            emit(event, JSON.parse(message.data));
          } catch {
            // 忽略解析失败的单条事件。
          }
        });
      }
    };

    if (token === null) {
      handshake().then(start).catch(() => {
        sseState = 'unsupported';
        onState?.('unsupported');
      });
    } else {
      start();
    }

    return () => {
      eventSource?.close();
      eventSource = null;
      sseState = 'closed';
    };
  }

  function on(event, handler) {
    const set = listeners.get(event) ?? new Set();
    set.add(handler);
    listeners.set(event, set);
    return () => set.delete(handler);
  }

  return {
    call,
    handshake,
    subscribe,
    on,
    get sseState() {
      return sseState;
    },
    get hasToken() {
      return token !== null;
    },
  };
}

export { ENDPOINT, CHANNEL, SSE_PATH };
