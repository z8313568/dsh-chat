/**
 * Host ↔ Client RPC 通道测试。
 *
 * 这个文件的由来值得写下来：第一版交付**没有**这个测试，原因是当时的验证只做到
 * 「路由挂载成功 + 无认证返回 401」——那两条能证明路由存在，但证明不了请求能被正确解析。
 * 结果用户在界面上拿到的是「未知方法: dsh-chat/rpc」。
 *
 * 根因：`connection.rpc.call(channel, endpoint, payload)` 发出的信封里，
 * **`method` 字段承载的是端点名**（`'dsh-chat/rpc'`），业务方法名在 `payload.method` 里。
 * 第一版把 `message.method` 当成了业务方法名。契约来自
 * `@deepseek-ai/dsh-client-connection/lib/client.js` 的 `createWebConnectionRpc`：
 *
 *   const message = { type: 'client-request', rpcId, method: endpoint, payload };
 *
 * 所以这里的测试**刻意按那条真实报文形状构造请求**，而不是按我们"以为"的形状。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { HostRpcServer, RPC_ENDPOINT, RPC_PATH, SSE_PATH } from '../src/host/rpc.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 造一个假的 cordis Context，把插件注册的两条路由抓下来。 */
function makeServer({ configure } = {}) {
  const captured = { fetchRoute: null, sseRoute: null, unregistered: 0 };
  const ctx = {
    get(name) {
      if (name === 'connection') {
        return {
          fetch: {
            register(route) {
              captured.fetchRoute = route;
              return () => { captured.unregistered += 1; };
            },
          },
        };
      }
      if (name === 'webServer') {
        return {
          register(route) {
            captured.sseRoute = route;
            return () => { captured.unregistered += 1; };
          },
        };
      }
      return undefined;
    },
  };
  const rpc = new HostRpcServer({ ctx });
  configure?.(rpc);
  const dispose = rpc.install();
  return { rpc, captured, dispose };
}

/** 按**真实报文形状**构造一次 client-request。 */
function wireRequest(rpcId, businessMethod, businessPayload, { endpoint = RPC_ENDPOINT } = {}) {
  return {
    type: 'client-request',
    rpcId,
    method: endpoint,
    payload: { method: businessMethod, payload: businessPayload ?? {} },
  };
}

async function post(captured, body, { method = 'POST', contentType = 'application/json' } = {}) {
  const request = new Request(`http://127.0.0.1${RPC_PATH}`, {
    method,
    headers: contentType === null ? {} : { 'content-type': contentType },
    body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  const response = await captured.fetchRoute.fetch(request);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应（405/415 等） */ }
  return { status: response.status, json, text };
}

describe('RPC 报文解析（真实 wire 格式）', () => {
  it('能按真实报文形状调用到业务方法（这就是那个"未知方法"的回归测试）', async () => {
    const { captured } = makeServer({
      configure: (rpc) => rpc.register('handshake', (payload) => ({ ok: true, echo: payload })),
    });

    const { status, json } = await post(captured, wireRequest('r1', 'handshake', { a: 1 }));
    assert.equal(status, 200);
    assert.equal(json.type, 'server-response');
    assert.equal(json.rpcId, 'r1');
    assert.deepEqual(json.result, { ok: true, value: { ok: true, echo: { a: 1 } } });
  });

  it('端点名的位置被正确区分：message.method 是端点，payload.method 才是业务方法', async () => {
    const { captured } = makeServer({
      configure: (rpc) => rpc.register('ping', () => 'pong'),
    });

    const { json } = await post(captured, wireRequest('r2', 'ping'));
    assert.deepEqual(json.result, { ok: true, value: 'pong' });
    // 关键断言：业务方法名绝不能是端点名本身
    assert.notEqual(json.result.error?.message, `未知方法: ${RPC_ENDPOINT}`);
  });

  it('未知业务方法报的是业务方法名，而不是端点名', async () => {
    const { captured } = makeServer();
    const { json } = await post(captured, wireRequest('r3', 'no.such.method'));
    assert.equal(json.result.ok, false);
    assert.equal(json.result.error.code, 'dsh-chat/unknown-method');
    assert.equal(json.result.error.message, '未知方法: no.such.method');
  });

  it('端点不匹配时明确报端点错，而不是伪装成"未知方法"', async () => {
    const { captured } = makeServer();
    const { json } = await post(captured, wireRequest('r4', 'handshake', {}, { endpoint: 'someone-else/rpc' }));
    assert.equal(json.result.ok, false);
    assert.equal(json.result.error.code, 'dsh-chat/bad-request');
    assert.match(json.result.error.message, /端点不匹配/);
  });

  it('业务方法抛错时返回结构化错误，并把 details 原样带给界面', async () => {
    const { captured } = makeServer({
      configure: (rpc) => rpc.register('boom', () => {
        const error = new Error('出事了');
        error.code = 'dsh-chat/test-code';
        error.detail = { hint: '细节' };
        throw error;
      }),
    });
    const { status, json } = await post(captured, wireRequest('r5', 'boom'));
    assert.equal(status, 200, '业务错误是 200 + 错误信封，不是 HTTP 错误码');
    assert.equal(json.result.ok, false);
    assert.equal(json.result.error.code, 'dsh-chat/test-code');
    assert.equal(json.result.error.message, '出事了');
    assert.deepEqual(json.result.error.details, { hint: '细节' });
  });

  it('同步抛出的 handler 也会被兜住（不会被当成 500）', async () => {
    const { captured } = makeServer({
      configure: (rpc) => rpc.register('sync-boom', () => { throw new TypeError('同步炸'); }),
    });
    const { status, json } = await post(captured, wireRequest('r6', 'sync-boom'));
    assert.equal(status, 200);
    assert.equal(json.result.error.message, '同步炸');
  });

  it('handler 返回 undefined 被规范成 null（JSON 里 undefined 会消失）', async () => {
    const { captured } = makeServer({ configure: (rpc) => rpc.register('void', () => undefined) });
    const { json } = await post(captured, wireRequest('r7', 'void'));
    assert.deepEqual(json.result, { ok: true, value: null });
  });

  it('rpcId 会被原样回传（客户端靠它做请求关联）', async () => {
    const { captured } = makeServer({ configure: (rpc) => rpc.register('ping', () => 1) });
    const { json } = await post(captured, wireRequest('a-very-specific-id', 'ping'));
    assert.equal(json.rpcId, 'a-very-specific-id');
  });
});

describe('RPC 请求校验', () => {
  it('畸形报文一律被拒，且不会走到业务方法', async () => {
    let called = 0;
    const { captured } = makeServer({ configure: (rpc) => rpc.register('ping', () => { called += 1; return 1; }) });

    const cases = [
      ['type 不对', { type: 'server-response', rpcId: 'x', method: RPC_ENDPOINT, payload: { method: 'ping' } }],
      ['payload 不是对象', { type: 'client-request', rpcId: 'x', method: RPC_ENDPOINT, payload: 'nope' }],
      ['payload 是数组', { type: 'client-request', rpcId: 'x', method: RPC_ENDPOINT, payload: [] }],
      ['payload 缺 method', { type: 'client-request', rpcId: 'x', method: RPC_ENDPOINT, payload: { payload: {} } }],
      ['payload.method 是空串', { type: 'client-request', rpcId: 'x', method: RPC_ENDPOINT, payload: { method: '' } }],
      ['payload.method 不是字符串', { type: 'client-request', rpcId: 'x', method: RPC_ENDPOINT, payload: { method: 7 } }],
    ];
    for (const [label, body] of cases) {
      const { json } = await post(captured, body);
      assert.equal(json.result.ok, false, `${label} 应被拒`);
      assert.equal(json.result.error.code, 'dsh-chat/bad-request', `${label} 的 code 应为 bad-request`);
    }
    assert.equal(called, 0, '业务方法一次都不该被调用');
  });

  it('非 POST 返回 405、content-type 不对返回 415、body 不是 JSON 返回 400', async () => {
    const { captured } = makeServer({ configure: (rpc) => rpc.register('ping', () => 1) });
    assert.equal((await post(captured, null, { method: 'GET' })).status, 405);
    assert.equal((await post(captured, wireRequest('x', 'ping'), { contentType: 'text/plain' })).status, 415);
    assert.equal((await post(captured, 'not json at all')).status, 400);
  });

  it('没有 rpcId 时也能给出结构化的 bad-request，而不是炸掉', async () => {
    const { captured } = makeServer();
    const { json } = await post(captured, { type: 'client-request', method: RPC_ENDPOINT, payload: { method: 'ping' } });
    assert.equal(json.rpcId, 'invalid-request');
    assert.equal(json.result.ok, false);
  });
});

describe('RPC 注册与卸载', () => {
  it('重复注册同名方法时后者生效（返回的撤销函数只摘掉自己那一层）', async () => {
    const { captured } = makeServer({
      configure: (rpc) => {
        rpc.register('greet', () => 'first');
        rpc.register('greet', () => 'second');
      },
    });
    const { json } = await post(captured, wireRequest('x', 'greet'));
    assert.deepEqual(json.result, { ok: true, value: 'second' });
  });

  it('install 返回的卸载函数会清掉路由', () => {
    const { captured, dispose } = makeServer();
    assert.ok(captured.fetchRoute);
    assert.ok(captured.sseRoute);
    dispose();
    assert.equal(captured.unregistered, 2);
  });

  it('没有 connection.fetch 时降级到 webServer，并只允许本机请求', async () => {
    // 注意：降级模式下 webServer 上会注册**两条**路由（RPC 与 SSE），
    // 所以这里按 path 取，而不是"最后一个注册的"——第一次写这个测试时就踩了这个坑。
    const routes = new Map();
    const ctx = {
      get(name) {
        if (name === 'webServer') {
          return {
            register(route) {
              routes.set(route.path, route);
              return () => {};
            },
          };
        }
        return undefined;
      },
    };
    const rpc = new HostRpcServer({ ctx });
    rpc.register('ping', () => 'pong');
    rpc.install();

    const route = routes.get(RPC_PATH);
    assert.ok(route, `应注册 ${RPC_PATH}`);
    assert.ok(routes.has(SSE_PATH), `应同时注册 ${SSE_PATH}`);

    const makeRes = () => ({
      statusCode: 0, headers: null, body: '',
      writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
      end(body) { this.body = body ?? ''; },
    });

    // 非本机 Host 头 → 403
    const foreign = makeRes();
    await route.handler({ headers: { host: '192.168.1.5:19387' }, url: RPC_PATH }, foreign);
    assert.equal(foreign.statusCode, 403);

    // 本机 → 正常应答
    const local = makeRes();
    const body = JSON.stringify(wireRequest('r9', 'ping'));
    const req = {
      headers: { host: '127.0.0.1:19387' },
      url: RPC_PATH,
      async *[Symbol.asyncIterator]() { yield Buffer.from(body); },
    };
    await route.handler(req, local);
    assert.equal(local.statusCode, 200);
    assert.deepEqual(JSON.parse(local.body), {
      type: 'server-response', rpcId: 'r9', result: { ok: true, value: 'pong' },
    });

    // localhost 与 [::1] 同样算本机
    for (const host of ['localhost:19387', '[::1]:19387']) {
      const res = makeRes();
      await route.handler({
        headers: { host },
        url: RPC_PATH,
        async *[Symbol.asyncIterator]() { yield Buffer.from(body); },
      }, res);
      assert.equal(res.statusCode, 200, `${host} 应被当作本机`);
    }
  });
});

describe('SSE token 门禁', () => {
  function connectSse(captured, token) {
    const res = {
      statusCode: 0, headers: null, chunks: [], ended: false,
      writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
      write(chunk) { this.chunks.push(chunk); return true; },
      end() { this.ended = true; },
      on() {},
    };
    const req = {
      url: `${SSE_PATH}${token === null ? '' : `?token=${encodeURIComponent(token)}`}`,
      headers: { host: '127.0.0.1:19387' },
      on() {},
    };
    captured.sseRoute.handler(req, res);
    return res;
  }

  it('无 token 与错 token 都是 403，且不建立流', () => {
    const { captured } = makeServer();
    const missing = connectSse(captured, null);
    assert.equal(missing.statusCode, 403);
    const wrong = connectSse(captured, 'wrong');
    assert.equal(wrong.statusCode, 403);
  });

  it('正确 token 建立 SSE 流，并且能收到广播', () => {
    const { rpc, captured } = makeServer();
    const client = connectSse(captured, rpc.token);
    assert.equal(client.statusCode, 200);
    assert.match(client.headers['content-type'], /text\/event-stream/);
    assert.match(client.chunks.join(''), /stream open/);

    const delivered = rpc.broadcast('live', { hello: 'world' });
    assert.equal(delivered, 1);
    assert.match(client.chunks.join(''), /event: live/);
    assert.match(client.chunks.join(''), /"hello":"world"/);
  });

  it('token 每次进程内随机，不会重复', () => {
    const a = makeServer().rpc.token;
    const b = makeServer().rpc.token;
    assert.notEqual(a, b);
    assert.ok(a.length >= 16);
  });
});

/**
 * 结构性交叉检查：**客户端调用的每个 RPC 方法，Host 都必须注册了**。
 *
 * 加这个测试的原因：「未知方法: dsh-chat/rpc」这个线上故障暴露了一件事——
 * 我此前只验证了"路由挂载成功"，没有任何东西保证两端的方法名是对得上的。
 * 方法名是字符串，没有类型检查，写错一个字母就会在用户点按钮时才炸。
 *
 * 这里做静态提取而不是运行时捕获，因为运行时需要把整个 Host `apply` 跑起来
 * （会写身份文件、开网络端口），代价太高且不稳。静态提取同样能挡住
 * "改了名字忘了改另一边"和"新加调用忘了加处理器"这两类问题。
 */
function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkFiles(full, out);
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

function extractMatches(files, pattern) {
  const found = new Map(); // 方法名 → 出现在哪个文件
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(pattern)) {
      if (!found.has(match[1])) found.set(match[1], file.slice(ROOT.length + 1));
    }
  }
  return found;
}

describe('RPC 方法名两端一致（结构性检查）', () => {
  const hostMethods = extractMatches(
    [join(ROOT, 'src/host/index.js')],
    /rpc\.register\(\s*'([^']+)'/g,
  );

  const clientFiles = walkFiles(join(ROOT, 'src/client'));
  const clientCalls = extractMatches(
    clientFiles,
    /\bclient\.call\(\s*'([^']+)'/g,
  );

  it('两边的清单都不是空的（否则说明提取逻辑本身坏了）', () => {
    assert.ok(hostMethods.size > 20, `Host 注册的方法太少：${hostMethods.size}`);
    assert.ok(clientCalls.size > 10, `客户端调用的方法太少：${clientCalls.size}`);
  });

  it('客户端调用的每个方法都在 Host 注册过', () => {
    const missing = [...clientCalls.entries()].filter(([method]) => !hostMethods.has(method));
    assert.deepEqual(
      missing,
      [],
      `客户端调用了 Host 没有注册的方法：\n${missing.map(([m, f]) => `  ${m}  (${f})`).join('\n')}`,
    );
  });

  it('方法名风格统一（小写点分层，没有误写成端点名）', () => {
    for (const [method, file] of [...hostMethods, ...clientCalls]) {
      assert.match(method, /^[a-z][A-Za-z]*(\.[a-zA-Z]+)*$/, `${file} 里的方法名不合规范: ${method}`);
      assert.notEqual(method, RPC_ENDPOINT, '业务方法名不应该是端点名');
      assert.notEqual(method, 'rpc', '业务方法名不应该是端点的一段');
    }
  });

  it('Host 注册的方法里没有重复键（重复会让后者静默覆盖前者）', () => {
    const text = readFileSync(join(ROOT, 'src/host/index.js'), 'utf8');
    const all = [...text.matchAll(/rpc\.register\(\s*'([^']+)'/g)].map((m) => m[1]);
    const seen = new Map();
    const duplicates = [];
    for (const name of all) {
      if (seen.has(name)) duplicates.push(name);
      seen.set(name, true);
    }
    assert.deepEqual(duplicates, [], `重复注册的 RPC 方法：${duplicates.join(', ')}`);
  });
});
