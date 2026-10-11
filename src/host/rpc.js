/**
 * Host ↔ Client 通道：JSON-RPC + SSE 推送。
 *
 * 两条通道各有分工，用两条是因为它们的安全模型不同：
 *
 *   1. **RPC（请求/响应）** 走 `ctx.connection.fetch.register`，路径挂在 `/api/` 下。
 *      这条路径**继承 DSH Web 载体已有的浏览器认证与 Host/Origin 信任检查**，
 *      也就是说外部网页无法直接调用它。参考实现在 @xmanrui/dsh-im 的 management-rpc.mjs。
 *      该方法名在不同版本上可能是 `register` 或 `registerFetchRoute`，所以下面做了特征探测。
 *
 *   2. **SSE（服务端推送）** 走 `ctx.webServer.register`，拿到的是**原始
 *      node:http IncomingMessage/ServerResponse**（不是 Fetch API），可以直接 `res.write`
 *      长时间流式输出。官方 Web 载体的 gzip 过滤器明确排除了 `text/event-stream`，
 *      所以 SSE 在这条路上是被支持的。
 *
 *      **但这条路径没有认证。** 所以它必须自己带凭证：启动时生成一个进程内随机 token，
 *      只通过已认证的 RPC 通道发给界面，SSE 请求必须带上它。没有 token 就 403。
 *      （这正是「不向其他节点暴露本地 DSH 服务端口」那条要求的延伸——
 *       本地端口也不该被随便一个进程读走会话内容。）
 */
import { randomUUID } from 'node:crypto';

const RPC_PATH = '/api/dsh-chat/rpc';
/**
 * 端点名（不含 `/api/` 前缀）。
 *
 * 注意这个字符串在**两个不同的位置**出现，含义不同，混淆过一次：
 *   1. 客户端 `connection.rpc.call('/api', 'dsh-chat/rpc', …)` 的第二个参数；
 *   2. 请求体里 `message.method` 的值。
 *
 * 而真正的业务方法名（如 `handshake`）在 `message.payload.method` 里，
 * 不在 `message.method` 里。第一版把 `message.method` 当成业务方法名，
 * 于是后端永远报「未知方法: dsh-chat/rpc」。
 * 契约来自 `@deepseek-ai/dsh-client-connection/lib/client.js` 的 `createWebConnectionRpc`：
 *
 *   const message = { type: 'client-request', rpcId, method: endpoint, payload };
 *
 * 也就是说信封上的 `method` 字段承载的是**端点**，业务调用整体塞在 `payload` 里。
 */
const RPC_ENDPOINT = 'dsh-chat/rpc';
const SSE_PATH = '/dsh-chat/events';

/** 兜底：把原始 node:http 请求体读完（webServer 路径用；fetch 路径有 request.json()）。 */
async function readNodeRequestBody(req, { limit = 4 * 1024 * 1024 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class HostRpcServer {
  #ctx;
  #logger;
  #handlers = new Map();
  #disposers = [];
  #token;
  #sseClients = new Set();
  #metrics = { rpcCalls: 0, rpcErrors: 0, sseConnections: 0, sseEvents: 0, lastCallAt: null, byMethod: Object.create(null) };

  constructor({ ctx, logger = null }) {
    this.#ctx = ctx;
    this.#logger = logger;
    // token 只在进程内存里，不落盘、不进日志。
    this.#token = randomUUID();
  }

  get token() {
    return this.#token;
  }

  get metrics() {
    return { ...this.#metrics, byMethod: { ...this.#metrics.byMethod }, sseClients: this.#sseClients.size };
  }

  /** 注册一个 RPC 方法。handler 形如 (payload, context) => Promise<value> | value。 */
  register(method, handler) {
    if (typeof method !== 'string' || typeof handler !== 'function') {
      throw new TypeError('register(method, handler) 参数不合法');
    }
    this.#handlers.set(method, handler);
    return () => this.#handlers.delete(method);
  }

  /** 装配两条路由。返回卸载函数。 */
  install() {
    this.#installRpc();
    this.#installSse();
    return () => {
      for (const dispose of this.#disposers.reverse()) {
        try {
          dispose();
        } catch (error) {
          this.#logger?.warn?.('卸载 RPC 路由失败', { message: error?.message });
        }
      }
      this.#disposers = [];
      for (const client of this.#sseClients) {
        try {
          client.res.end();
        } catch {
          // 已经关了。
        }
      }
      this.#sseClients.clear();
    };
  }

  #installRpc() {
    const fetchRegistry = this.#ctx.get?.('connection')?.fetch ?? this.#ctx.connection?.fetch;
    // 特征探测：不同 DSH 版本的注册方法名不一样，不要在启动时炸掉整个插件。
    const register = typeof fetchRegistry?.register === 'function'
      ? fetchRegistry.register.bind(fetchRegistry)
      : (typeof fetchRegistry?.registerFetchRoute === 'function' ? fetchRegistry.registerFetchRoute.bind(fetchRegistry) : null);

    if (register) {
      const dispose = register({
        path: RPC_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => this.#handleFetchRequest(request),
      });
      this.#disposers.push(dispose);
      this.#logger?.info?.('RPC 已挂载（连接通道，继承浏览器认证）', { path: RPC_PATH });
      return;
    }

    // 降级：用 webServer 原始 http。安全性弱一档，所以额外要求请求来自回环地址。
    const webServer = this.#ctx.get?.('webServer');
    if (!webServer) {
      throw new Error('既没有 connection.fetch 也没有 webServer，无法挂载 RPC 通道');
    }
    const dispose = webServer.register({
      kind: 'exact',
      path: RPC_PATH,
      handler: async (req, res) => {
        if (!this.#isLoopback(req)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('dsh-chat: 仅允许本机访问');
          return;
        }
        try {
          const body = await readNodeRequestBody(req);
          const response = await this.#dispatchRaw(body);
          res.writeHead(response.status, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(response.body));
        } catch (error) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: error.message }));
        }
      },
    });
    this.#disposers.push(dispose);
    this.#logger?.info?.('RPC 已挂载（webServer 降级通道，仅本机）', { path: RPC_PATH });
  }

  #installSse() {
    const webServer = this.#ctx.get?.('webServer');
    if (!webServer) {
      this.#logger?.warn?.('没有 webServer，实时推送不可用；界面将退化为轮询');
      return;
    }
    const dispose = webServer.register({
      kind: 'exact',
      path: SSE_PATH,
      handler: (req, res) => this.#handleSse(req, res),
    });
    this.#disposers.push(dispose);
    this.#logger?.info?.('SSE 已挂载（带进程内 token 校验）', { path: SSE_PATH });
  }

  #isLoopback(req) {
    const host = req.headers?.host ?? '';
    const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  }

  #handleSse(req, res) {
    const url = new URL(req.url ?? SSE_PATH, 'http://localhost');
    if (url.searchParams.get('token') !== this.#token) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('dsh-chat: token 无效');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // 关掉反向代理缓冲，否则事件会被攒着一起发。
      'x-accel-buffering': 'no',
    });
    res.write(': dsh-chat stream open\n\n');

    const client = { id: randomUUID(), res };
    this.#sseClients.add(client);
    this.#metrics.sseConnections += 1;

    // 心跳：某些代理/内核会在一段时间无数据后掐断空闲连接。
    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        // 下面 close 会清理。
      }
    }, 20000);
    heartbeat.unref?.();

    const cleanup = () => {
      clearInterval(heartbeat);
      this.#sseClients.delete(client);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('error', cleanup);
  }

  /** 向所有 SSE 客户端推一个事件。 */
  broadcast(event, data) {
    if (this.#sseClients.size === 0) return 0;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    let delivered = 0;
    for (const client of [...this.#sseClients]) {
      try {
        client.res.write(payload);
        delivered += 1;
      } catch {
        this.#sseClients.delete(client);
      }
    }
    this.#metrics.sseEvents += delivered;
    return delivered;
  }

  async #handleFetchRequest(request) {
    if (request.method !== 'POST') {
      return new Response('method not allowed', { status: 405 });
    }
    if ((request.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      return new Response('content type must be application/json', { status: 415 });
    }
    let message;
    try {
      message = await request.json();
    } catch {
      return new Response('body is not JSON', { status: 400 });
    }
    const result = await this.#handleMessage(message);
    return Response.json({ type: 'server-response', rpcId: result.rpcId, result: result.result });
  }

  async #dispatchRaw(body) {
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      return { status: 400, body: { error: 'body is not JSON' } };
    }
    const result = await this.#handleMessage(message);
    return { status: 200, body: { type: 'server-response', rpcId: result.rpcId, result: result.result } };
  }

  /**
   * 解析一条 client-request 并调用业务方法。
   *
   * 这里是曾经出过错的地方，所以把层次写清楚：
   *   message.method          = 端点名（'dsh-chat/rpc'），用来确认请求确实是发给我们的
   *   message.payload.method  = 业务方法名（'handshake'、'share.create' …）
   *   message.payload.payload = 业务参数
   */
  async #handleMessage(message) {
    const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request';
    const badRequest = (detail) => ({
      rpcId,
      result: { ok: false, error: { code: 'dsh-chat/bad-request', message: `请求格式不合法：${detail}`, details: {} } },
    });

    if (message?.type !== 'client-request') return badRequest('type 不是 client-request');
    if (message.method !== RPC_ENDPOINT) return badRequest(`端点不匹配（收到 ${String(message.method)}）`);

    const call = message.payload;
    if (call === null || typeof call !== 'object' || Array.isArray(call)) {
      return badRequest('payload 不是对象');
    }
    if (typeof call.method !== 'string' || call.method.length === 0) {
      return badRequest('payload.method 不是非空字符串');
    }
    const result = await this.#invoke(call.method, call.payload);
    return { rpcId, result };
  }

  async #invoke(method, payload) {
    this.#metrics.rpcCalls += 1;
    this.#metrics.lastCallAt = Date.now();
    this.#metrics.byMethod[method] = (this.#metrics.byMethod[method] ?? 0) + 1;

    const handler = this.#handlers.get(method);
    if (!handler) {
      this.#metrics.rpcErrors += 1;
      return { ok: false, error: { code: 'dsh-chat/unknown-method', message: `未知方法: ${method}`, details: {} } };
    }
    try {
      const value = await handler(payload ?? {}, { method });
      return { ok: true, value: value === undefined ? null : value };
    } catch (error) {
      this.#metrics.rpcErrors += 1;
      // 只把可安全外传的信息给界面；堆栈留在日志里。
      this.#logger?.warn?.(`RPC ${method} 失败`, { message: error?.message, code: error?.code });
      return {
        ok: false,
        error: {
          code: error?.code ?? 'dsh-chat/internal',
          message: error?.message ?? '内部错误',
          details: error?.detail ?? {},
        },
      };
    }
  }
}

export { RPC_PATH, RPC_ENDPOINT, SSE_PATH };
