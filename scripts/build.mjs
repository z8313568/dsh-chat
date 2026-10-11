#!/usr/bin/env node
/**
 * dsh-chat 构建脚本。
 *
 * 产出两个文件，正是 DSH 加载器实际 import 的路径：
 *   lib/index.js   —— Host 半体，ESM，Node 平台（package.json 的 main）
 *   lib/client.js  —— Client 半体，先打成 CJS，再包进 window.__ModuleLoader__.load(...)
 *
 * 这两个契约来自对本机已安装的第三方插件（@xmanrui/dsh-im 4.38.0、
 * dsh-pocket 2.10.6）的实测：它们的 lib/ 产物就是这个形状。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptsDir, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const production = process.env.NODE_ENV === 'production';

async function buildHost() {
  const outfile = resolve(root, 'lib/index.js');
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    entryPoints: [resolve(root, 'src/host/index.js')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node22'],
    mainFields: ['module', 'main'],
    outfile,
    sourcemap: false,
    minify: false,
    legalComments: 'none',
    banner: {
      js: [
        "import { createRequire as __dshCreateRequire } from 'node:module';",
        'const require = __dshCreateRequire(import.meta.url);',
      ].join('\n'),
    },
  });
  console.log(`[dsh-chat] host  → lib/index.js`);
}

async function buildClient() {
  const outfile = resolve(root, 'lib/client.js');
  await mkdir(dirname(outfile), { recursive: true });

  // React 由 Web shell 自己的模块加载器提供，和参考实现保持一致。
  const result = await build({
    entryPoints: [resolve(root, 'src/client/index.js')],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: ['chrome100'],
    external: ['react', 'react-dom'],
    write: false,
    minify: production,
    legalComments: 'none',
    // 源码用 JSX 写（可读性远好于手写 h()）。esbuild 默认只在 .jsx/.tsx 里解析 JSX，
    // 所以这里显式把 .js 也当 JSX 解析，并把工厂指向插件自己的 h / Fragment。
    loader: { '.js': 'jsx' },
    jsx: 'transform',
    jsxFactory: 'h',
    jsxFragment: 'Fragment',
  });

  const bundled = result.outputFiles?.[0]?.text;
  if (!bundled) throw new Error('esbuild 未产出 client bundle');

  // window.__ModuleLoader__ 是 Web shell 的插件表；id 必须等于包名，
  // 否则 clientModules 的 dsh.client 扫描无法把 bundle 与条目对应起来。
  const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(manifest.name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${bundled}
    return module.exports;
  }
});
`;
  await writeFile(outfile, wrapped, 'utf8');
  console.log(`[dsh-chat] client → lib/client.js`);
}

await buildHost();
await buildClient();

/**
 * 额外产出一份「给测试用的」Client bundle。
 *
 * 为什么需要它：交付物里的 `lib/client.js` 是包在 `window.__ModuleLoader__.load(...)` 里的，
 * 在 Node 里没法直接 import。而本次交付没有浏览器控制能力，如果不做点什么，
 * 「界面到底会不会崩」这一项就只能写「未验证」。
 *
 * 于是把同一份源码再打一次（ESM、Node 平台、react 保持 external），
 * 测试里就能真的把组件渲染出来——这是在没有浏览器的情况下最接近真实的一步。
 * 它只服务于测试，不进 `files`，也不影响交付产物。
 */
async function buildClientForTest() {
  const outfile = resolve(root, '.test-build/client.mjs');
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    // 用专门的测试入口：交付入口只导出 name/inject/apply，而渲染测试需要各个组件。
    entryPoints: [resolve(root, 'test/support/client-entry.js')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node22'],
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    outfile,
    sourcemap: false,
    minify: false,
    legalComments: 'none',
    loader: { '.js': 'jsx' },
    jsx: 'transform',
    jsxFactory: 'h',
    jsxFragment: 'Fragment',
  });
  console.log('[dsh-chat] client → .test-build/client.mjs (仅测试用)');
}

await buildClientForTest();
