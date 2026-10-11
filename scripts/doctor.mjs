#!/usr/bin/env node
/**
 * dsh-chat 自检（doctor）。
 *
 * 存在的理由：插件加载失败可能是**完全静默**的 —— Cordis 的 `inject` 是硬依赖，
 * 只要有一个服务没就绪，`apply()` 就永远不会被调用，不报错、不写日志，
 * 界面上只显示"无法访问 dsh-chat 的 Host 半体"。上一次排查就卡在这里：
 * 客户端半体是活的、路由却没注册，没有任何地方能说明原因。
 *
 * 这个脚本把"从磁盘上的文件到运行中的 DSH"整条链路逐段检查一遍，
 * 每一段都给出**明确的结论**，而不是让人去猜。
 *
 * 用法：node scripts/doctor.mjs
 */

import { existsSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');
const PROFILE = join(homedir(), '.dsh', 'profiles', 'desktop');
const DATA = join(homedir(), '.dsh', 'dsh-chat');

const results = [];
const ok = (name, detail = '') => results.push({ level: 'ok', name, detail });
const warn = (name, detail = '') => results.push({ level: 'warn', name, detail });
const bad = (name, detail = '') => results.push({ level: 'bad', name, detail });

// ---------------------------------------------------------------------------
// 1. 构建产物
// ---------------------------------------------------------------------------
const hostBundle = join(PLUGIN, 'lib', 'index.js');
const clientBundle = join(PLUGIN, 'lib', 'client.js');
for (const [label, file] of [['Host 产物 lib/index.js', hostBundle], ['Client 产物 lib/client.js', clientBundle]]) {
  if (!existsSync(file)) {
    bad(label, '不存在 —— 先跑 npm run build');
    continue;
  }
  const ageMin = Math.round((Date.now() - statSync(file).mtimeMs) / 60000);
  if (ageMin > 24 * 60) warn(label, `已有 ${Math.round(ageMin / 60)} 小时未更新`);
  else ok(label, `${Math.round(statSync(file).size / 1024)} KB，${ageMin} 分钟前构建`);
}

// ---------------------------------------------------------------------------
// 2. package.json 契约
// ---------------------------------------------------------------------------
try {
  const pkg = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'));
  const want = { '.': './lib/index.js', './client': './lib/client.js' };
  for (const [key, value] of Object.entries(want)) {
    if (pkg.exports?.[key] === value) ok(`exports["${key}"]`, value);
    else bad(`exports["${key}"]`, `期望 ${value}，实际 ${JSON.stringify(pkg.exports?.[key])}`);
  }
  if (pkg.type === 'module') ok('type', 'module');
  else bad('type', `期望 module，实际 ${JSON.stringify(pkg.type)}`);
  if (pkg.dsh?.bundle?.patch) ok('dsh.bundle.patch', pkg.dsh.bundle.patch);
  else bad('dsh.bundle.patch', '缺失 —— 加载器不会插入这个插件');
  if (pkg.dsh?.client?.platform === 'web') ok('dsh.client.platform', 'web');
  else warn('dsh.client.platform', JSON.stringify(pkg.dsh?.client?.platform));
} catch (error) {
  bad('package.json', `解析失败：${error.message}`);
}

// ---------------------------------------------------------------------------
// 3. 是否装进了 profile
// ---------------------------------------------------------------------------
const link = join(PROFILE, 'node_modules', 'dsh-chat');
if (!existsSync(link)) {
  bad('profile 里没有 dsh-chat', `期望位置 ${link}`);
} else {
  try {
    const target = readlinkSync(link);
    // 软链通常是相对的，必须解析成绝对路径再比 —— 否则自己吓自己。
    const resolved = resolve(dirname(link), target);
    if (resolved === PLUGIN) ok('profile 软链', `→ ${PLUGIN}`);
    else warn('软链指向', `解析为 ${resolved}，本仓库是 ${PLUGIN}`);
  } catch {
    ok('profile 里的 dsh-chat', '实体目录（非软链）');
  }
  try {
    const pkg = JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8'));
    const bundles = pkg.dsh?.profile?.bundles ?? [];
    if (bundles.includes('dsh-chat')) ok('已在 bundle 列表', `共 ${bundles.length} 个 bundle`);
    else bad('不在 bundle 列表', '需要在 dsh.profile.bundles 里出现，插件才会被加载');
  } catch (error) {
    bad('profile package.json', error.message);
  }
}

// ---------------------------------------------------------------------------
// 4. 启动诊断（关键）
// ---------------------------------------------------------------------------
const bootPath = join(DATA, 'boot.json');
if (!existsSync(bootPath)) {
  bad(
    'boot.json 不存在',
    '说明 apply() 从未在这个数据目录里跑过 —— 插件没有加载，或者数据目录不是这个',
  );
} else {
  try {
    const boot = JSON.parse(readFileSync(bootPath, 'utf8'));
    const ageMin = Math.round((Date.now() - Date.parse(boot.atHuman)) / 60000);
    const detail = `${boot.phase}（${ageMin} 分钟前，pid ${boot.pid}，node ${boot.node}，inject=[${(boot.inject ?? []).join(',')}]）`;
    if (boot.phase === 'apply-completed' || boot.phase === 'rpc-mounted') ok('启动诊断', detail);
    else if (boot.phase === 'apply-called') {
      bad('启动诊断', `${detail} —— apply 进入了但没走完，后续步骤中途失败`);
    } else bad('启动诊断', `${detail}${boot.message ? `；error=${boot.message}` : ''}`);
    if (boot.stack) console.log(`\n  失败堆栈：\n  ${boot.stack.join('\n  ')}`);
  } catch (error) {
    bad('boot.json', `解析失败：${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// 5. Host 半体能不能在 DSH 的运行时里被 import
// ---------------------------------------------------------------------------
const appBin = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
if (!existsSync(appBin)) {
  warn('DSH 运行时', '找不到应用可执行文件，跳过 import 检查');
} else {
  try {
    const out = execFileSync(appBin, ['-e', `
      import(${JSON.stringify(`file://${hostBundle}`)}).then((m) => {
        console.log(JSON.stringify({ name: m.name, inject: m.inject ?? null, hasApply: typeof m.apply === 'function' }));
      }).catch((e) => { console.log(JSON.stringify({ error: e.message })); });
    `], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30000 });
    const parsed = JSON.parse(out.trim().split('\n').pop());
    if (parsed.error) bad('Host 半体 import', `失败：${parsed.error}`);
    else if (parsed.hasApply) ok('Host 半体 import', `name=${parsed.name}，inject=[${(parsed.inject ?? []).join(',')}]`);
    else bad('Host 半体 import', '没有导出 apply');
  } catch (error) {
    bad('Host 半体 import', `在 DSH 运行时里加载失败：${String(error.message).split('\n')[0]}`);
  }
}

// ---------------------------------------------------------------------------
// 6. 运行中的 DSH 是否挂着路由
// ---------------------------------------------------------------------------
try {
  const raw = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' });
  const dsh = raw.split('\n').filter((line) => /DeepSeek/i.test(line));
  const ports = dsh.map((line) => line.match(/:(\d+) \(LISTEN\)/)?.[1]).filter(Boolean);
  if (ports.length === 0) warn('DSH 监听端口', '没找到 DSH 的监听端口，DSH 可能没在运行');
  else {
    ok('DSH 监听端口', [...new Set(ports)].join(', '));
    const base = `http://127.0.0.1:${ports[0]}`;
    const code = execFileSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '5', `${base}/dsh-chat/events`], { encoding: 'utf8' });
    // 404 = 插件路由没挂上；401/200 = 路由存在（401 是 token 校验）
    if (code === '404') bad('插件路由 /dsh-chat/events', '404 —— Host 半体的路由没有注册（插件未加载或挂载失败）');
    else ok('插件路由 /dsh-chat/events', `HTTP ${code}（路由已注册）`);
  }
} catch (error) {
  warn('DSH 监听端口', `检查失败：${String(error.message).split('\n')[0]}`);
}

// ---------------------------------------------------------------------------
const order = { bad: 0, warn: 1, ok: 2 };
results.sort((a, b) => order[a.level] - order[b.level]);
const icon = { ok: '✔', warn: '!', bad: '✘' };
console.log('\n=== dsh-chat 自检 ===\n');
for (const r of results) console.log(`${icon[r.level]} ${r.name}${r.detail ? `\n    ${r.detail}` : ''}`);

const badCount = results.filter((r) => r.level === 'bad').length;
console.log(`\n结论：${badCount === 0 ? '各项正常' : `有 ${badCount} 项需要处理（见上）`}`);
process.exit(badCount === 0 ? 0 : 1);
