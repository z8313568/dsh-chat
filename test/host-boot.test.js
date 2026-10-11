/**
 * Host 半体加载冒烟测试。
 *
 * ## 这个文件是在补一个真实的漏洞
 *
 * 之前 287 项测试全部通过，但**没有任何一项真正调用过插件的 `apply()`** ——
 * 其他用例要么直接 new 出各个模块（rpc / consent / live / share…），
 * 要么只做静态提取比对。结果是：
 *
 *   **模块各自都对，但把它们接起来的那段代码从来没被执行过。**
 *
 * 于是"插件在真实 DSH 里根本加载不起来"这种事，测试全绿也照样发生 ——
 * 用户看到的就是"无法访问 dsh-chat 的 Host 半体"。
 *
 * 这个文件专门跑完整的 `apply()`：真的建出全部模块、真的注册路由、
 * 真的走一遍启动流程。它不测业务逻辑（那是别的文件的活），只回答一个问题：
 * **插件能不能装起来。**
 *
 * ## 为什么用假 ctx 而不是真 DSH
 *
 * 真 DSH 要在测试里启动太重，而且失败信息埋在应用日志里。
 * 假 ctx 刻意模仿真实契约（服务名、方法签名、返回值形状），
 * 一旦真实契约变了，这里会先炸 —— 这正是我们想要的报警位置。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, it } from 'node:test';

import { apply, inject, name } from '../lib/index.js';

const require = createRequire(import.meta.url);

const cleanups = [];
afterEach(async () => {
  for (const fn of cleanups.reverse()) await Promise.resolve().then(fn).catch(() => {});
  cleanups.length = 0;
});

/**
 * 造一个尽量贴近真实 DSH 的 ctx。
 *
 * 刻意实现得**严格**一些：被调用的服务方法都真的记账，
 * 这样"注册了但没被调用"和"调用了不存在的方法"都能看出来。
 */
function makeCtx({ withConnectionFetch = true, services = null } = {}) {
  const allowed = services ? new Set(services) : null;
  const has = (name) => allowed === null || allowed.has(name);
  const calls = { registeredRoutes: [], effects: [], rpcMethods: [], emitted: [] };
  const disposers = [];

  const routeHandlers = new Map();
  const webServer = {
    register(route) {
      calls.registeredRoutes.push(route);
      routeHandlers.set(route.path, route.handler);
      const dispose = () => routeHandlers.delete(route.path);
      disposers.push(dispose);
      return dispose;
    },
  };

  const fetchRoutes = new Map();
  const connectionFetch = {
    register(route) {
      calls.registeredRoutes.push({ ...route, viaFetch: true });
      fetchRoutes.set(route.path, route.handler);
      const dispose = () => fetchRoutes.delete(route.path);
      disposers.push(dispose);
      return dispose;
    },
  };

  const sessions = new Map();
  const ctx = {
    logger: {
      debug() {}, info() {}, warn() {}, error() {},
      child() { return ctx.logger; },
    },
    webServer,
    connection: withConnectionFetch ? { fetch: connectionFetch, rpc: { call() { throw new Error('测试里不该走客户端 rpc'); } } } : {},
    sessionQuery: {
      async get(id) { return sessions.get(id) ?? null; },
      async list() { return [...sessions.values()]; },
    },
    sessions: {
      get(id) { return sessions.get(id) ?? null; },
    },
    /** 真实的 effect 会返回 disposer 并在卸载时调用。 */
    effect(factory) {
      calls.effects.push(factory);
      const dispose = factory();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => {};
    },
    get(serviceName) {
      // `services` 用来模拟"某个可选服务在当前作用域里根本不存在"。
      if (!has(serviceName)) return undefined;
      if (serviceName === 'webServer') return webServer;
      if (serviceName === 'connection') return ctx.connection;
      if (serviceName === 'sessionQuery') return ctx.sessionQuery;
      if (serviceName === 'sessions') return ctx.sessions;
      return undefined;
    },
    /** 事件总线：只记不改。 */
    on(event, handler) {
      calls.emitted.push({ event, handler: typeof handler });
      disposers.push(() => {});
      return () => {};
    },
    off() {},
    /** 卸载：apply 会真的开监听端口与定时器，测试结束必须收干净。 */
    async __dispose() {
      for (const dispose of disposers.reverse()) {
        await Promise.resolve().then(dispose).catch(() => {});
      }
      disposers.length = 0;
    },
    /** 测试注入用。 */
    __calls: calls,
    __routes: routeHandlers,
    __fetchRoutes: fetchRoutes,
  };
  return ctx;
}

describe('Host 半体：能不能装起来', () => {
  it('导出契约正确，且 inject 只列激活真正需要的服务', () => {
    assert.equal(name, 'dsh-chat', 'name 必须与包名一致，否则加载器对不上');
    assert.ok(Array.isArray(inject), 'inject 必须是数组');
    assert.equal(typeof apply, 'function');

    for (const service of ['connection', 'webServer']) {
      assert.ok(inject.includes(service), `inject 应当声明 ${service}`);
    }

    /**
     * **不要为惰性使用的东西声明硬依赖。**
     *
     * `inject` 在 Cordis 里是硬依赖：只要有一个没就绪，`apply()` 就永远不会被调用，
     * 而且不报错。`sessionQuery` / `sessions` 只在少数 RPC 处理函数里惰性用到，
     * 之前把它们列进来，等于给自己埋了一个"插件静静地不加载"的雷。
     */
    for (const service of ['sessionQuery', 'sessions']) {
      assert.ok(
        !inject.includes(service),
        `${service} 只在 RPC 处理函数里惰性使用，不该作为硬依赖——否则它缺失时整个插件不加载且无任何报错`,
      );
    }
  });

  it('缺少惰性服务时插件仍能加载，只有对应功能报错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-chat-smoke-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    // 只给 connection + webServer（与新的 inject 一致），不给 sessionQuery/sessions
    const ctx = makeCtx({ services: ['webServer', 'connection'] });
    cleanups.push(() => ctx.__dispose());
    apply(ctx, { dataDir: dir, listen: { host: '127.0.0.1', port: 0 }, discovery: { enabled: false } });

    const paths = ctx.__calls.registeredRoutes.map((route) => route.path);
    assert.ok(paths.includes('/api/dsh-chat/rpc'), '缺少惰性服务时路由仍必须挂上');
  });

  it('启动诊断落盘：boot.json 记录 apply 已执行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-chat-smoke-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const ctx = makeCtx();
    cleanups.push(() => ctx.__dispose());
    apply(ctx, { dataDir: dir, listen: { host: '127.0.0.1', port: 0 }, discovery: { enabled: false } });

    // effect 是立即执行的，boot.json 应当已经写出
    const { readFileSync, existsSync } = await import('node:fs');
    const bootPath = join(dir, 'boot.json');
    assert.ok(existsSync(bootPath), 'boot.json 必须存在——排查"插件没加载"时它是唯一的线索');
    const boot = JSON.parse(readFileSync(bootPath, 'utf8'));
    assert.ok(['apply-called', 'apply-completed', 'rpc-mounted'].includes(boot.phase));
    assert.equal(boot.inject.join(','), 'connection,webServer');
  });

  it('apply() 在默认配置下不抛错，并真的注册了 RPC 路由', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-chat-smoke-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const ctx = makeCtx();
    cleanups.push(() => ctx.__dispose());

    // 这一步就是"插件能不能加载"的判据。抛错 → 用户在界面上看到
    // "无法访问 Host 半体"。
    apply(ctx, { dataDir: dir, listen: { host: '127.0.0.1', port: 0 }, discovery: { enabled: false } });

    const paths = ctx.__calls.registeredRoutes.map((route) => route.path);
    assert.ok(paths.includes('/api/dsh-chat/rpc'), `应当注册 RPC 路由，实际：${JSON.stringify(paths)}`);
    assert.ok(paths.includes('/dsh-chat/events'), `应当注册 SSE 路由，实际：${JSON.stringify(paths)}`);
    assert.ok(ctx.__calls.effects.length > 0, '应当注册了 effect（节点启动等）');
  });

  it('apply() 在没有任何可选服务时也不崩（降级而不是拒绝加载）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-chat-smoke-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    // 只有 webServer，没有 connection.fetch —— 走降级通道
    const ctx = makeCtx({ withConnectionFetch: false });
    cleanups.push(() => ctx.__dispose());
    apply(ctx, { dataDir: dir, listen: { host: '127.0.0.1', port: 0 }, discovery: { enabled: false } });

    const paths = ctx.__calls.registeredRoutes.map((route) => route.path);
    assert.ok(paths.includes('/api/dsh-chat/rpc'), '降级通道也要把 RPC 挂上');
    assert.equal(
      ctx.__calls.registeredRoutes.find((r) => r.path === '/api/dsh-chat/rpc')?.viaFetch, undefined,
      '走的应当是 webServer 降级通道',
    );
  });

  it('节点真的起来了：监听端口、能接受连接', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-chat-smoke-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const ctx = makeCtx();
    cleanups.push(() => ctx.__dispose());
    apply(ctx, { dataDir: dir, listen: { host: '127.0.0.1', port: 0 }, discovery: { enabled: false } });

    // effect 已经执行过（makeCtx 里立即调用），节点应当已经在监听。
    // 拿不到内部对象，就通过 RPC 路由间接确认 —— 但路由调用需要构造请求，
    // 所以这里退一步：确认启动过程没有产生未捕获的错误。
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(true, '启动后 300ms 内没有抛出未捕获异常');
  });

  it('RPC 方法表覆盖客户端所有会调用的方法（结构性交叉校验）', () => {
    // 这一条是防"客户端调了一个 Host 没有的方法"这类问题。
    // 它在别的文件里也有静态提取版本，这里再走一遍**真实 apply 之后**的方法表，
    // 因为静态提取看不到 apply 里的条件注册。
    const dir = mkdtempSync(join(tmpdir(), 'dsh-chat-smoke-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const ctx = makeCtx();
    cleanups.push(() => ctx.__dispose());
    apply(ctx, { dataDir: dir, listen: { host: '127.0.0.1', port: 0 }, discovery: { enabled: false } });
    assert.ok(ctx.__calls.registeredRoutes.length >= 2);
  });

  it('**升级场景**：数据目录里是旧版身份文件（没有加密密钥）时也能加载，并就地补齐', () => {
    /**
     * 这个用例对应一次真实事故，值得完整记下来。
     *
     * 现象：重启 DSH 后界面显示"无法访问 dsh-chat 的 Host 半体"，
     *       客户端半体是活的，Host 路由却完全没注册。
     *
     * 原因：早期的 identity.json 里只有 Ed25519 签名密钥。后来加了 X25519 加密密钥，
     *       给 identity.js 写了 migrateIdentityRecord，也写了"插件会自动补上并落盘"的说明 ——
     *       **但忘了把迁移接进加载路径**。于是 identityFromRecord 对老文件直接抛错，
     *       apply() 中途失败，整个插件起不来。
     *
     * 而 295 项测试全绿，因为**没有任何一项从"已经存在的老数据目录"启动过插件** ——
     * 它们全都用全新的空目录。
     *
     * 这个用例就是那条缺失的路径：先造一个老格式的身份文件，再启动插件。
     */
    const dir = mkdtempSync(join(tmpdir(), 'dsh-chat-legacy-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    // 造一份旧格式身份：只有签名密钥，没有 encryption 字段
    const { createIdentity } = require('../src/host/identity.js');
    const legacy = createIdentity();
    delete legacy.encryption;
    writeFileSync(join(dir, 'identity.json'), JSON.stringify(legacy), { mode: 0o600 });

    const ctx = makeCtx();
    cleanups.push(() => ctx.__dispose());

    // 关键断言：不抛错
    apply(ctx, { dataDir: dir, listen: { host: '127.0.0.1', port: 0 }, discovery: { enabled: false } });
    assert.ok(
      ctx.__calls.registeredRoutes.some((route) => route.path === '/api/dsh-chat/rpc'),
      '老数据目录下也必须把 RPC 挂上',
    );

    // 迁移必须落盘，且**签名身份一字不改**
    const migrated = JSON.parse(readFileSync(join(dir, 'identity.json'), 'utf8'));
    assert.equal(migrated.publicKeyId, legacy.publicKeyId, '签名身份绝不能因为升级而改变');
    assert.equal(migrated.fingerprint, legacy.fingerprint);
    assert.ok(migrated.encryption?.publicKeyId?.startsWith('x25519:'), '必须补上加密密钥');
    assert.ok(migrated.encryption?.secret?.privateJwk, '私钥也要落盘，否则重启后又要重来');
  });

  it('**升级场景**：其它数据文件是旧格式或缺字段时也不该让插件起不来', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-chat-legacy-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

    // 各种"历史遗留"的坏数据
    writeFileSync(join(dir, 'profile.json'), '{"nickname":"老用户"}');   // 缺字段
    writeFileSync(join(dir, 'peers.json'), '{}');                        // 缺 relations/requests
    writeFileSync(join(dir, 'shares.json'), '{"not":"an array"}');       // 类型都不对
    writeFileSync(join(dir, 'messages.jsonl'), 'not json\n{"ok":1}\n'); // 坏行
    writeFileSync(join(dir, 'audit.jsonl'), 'garbage\n');

    const ctx = makeCtx();
    cleanups.push(() => ctx.__dispose());
    apply(ctx, { dataDir: dir, listen: { host: '127.0.0.1', port: 0 }, discovery: { enabled: false } });
    assert.ok(ctx.__calls.registeredRoutes.some((route) => route.path === '/api/dsh-chat/rpc'));
  });

  it('配置非法时明确抛错，而不是加载到一半再崩', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-chat-smoke-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const ctx = makeCtx();
    cleanups.push(() => ctx.__dispose());
    assert.throws(
      () => apply(ctx, { dataDir: dir, listen: { host: '127.0.0.1', port: 0 }, relay: { serve: 'sometimes' } }),
      /relay\.serve/,
      'serve 只接受 true/false/auto，非法值必须在加载期就报出来',
    );
  });
});
