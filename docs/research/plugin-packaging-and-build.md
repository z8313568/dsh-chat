# DSH third-party plugin packaging & build (Desktop 0.2.0-rc.2)

READ-ONLY research. Everything below is quoted from files on this machine.

**Evidence base**

| Source | How to read it |
|---|---|
| `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` | `node ".../dsh-chat-会话事件验证/asar-tool.js" "<asar>" read /dsh/<path>` — DSH packages live under `/dsh/node_modules/@deepseek-ai/`; many ship `src/*.ts` next to `lib/*.js` |
| `/Users/twoants/.dsh/profiles/desktop/` | live Desktop profile (`cordis.yml`, `cordis.patch.yml`, `package.json`, `node_modules/`) |
| `~/.dsh/profiles/desktop/node_modules/@xmanrui/dsh-im` v4.38.0 | best host+client reference (ships `plugin-src/{host,client}` + `lib/*.js`) |
| `~/.dsh/profiles/desktop/node_modules/dsh-pocket` v2.10.6 | second host+client reference (`client/index.jsx` + `client/build.mjs` + built `client/client.js`) |
| `~/.dsh/profiles/desktop/node_modules/dshmarket` v1.66.14 | third-party installer/hot-mounter; documents the real install path in code |
| `/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/` | **official** authoring skill + `templates/decoration/` skeleton shipped inside DSH |

Line numbers for asar files below refer to the extracted copies at `/tmp/asarx/...` (extract with
`asar-tool.js "<asar>" extract /dsh/node_modules/@deepseek-ai/<pkg>/ /tmp/out`); the line numbers match the asar bytes.

---

## 1. `package.json` contract

### 1.1 The authoritative field list

`@deepseek-ai/dsh-package-manifest` is the *declaration* package (`DshPackageManifest`, `DshManifest`, `DshClientManifest`).
`/tmp/asarx/dsh/node_modules/@deepseek-ai/dsh-package-manifest/README.md:46`:

> `DshPackageManifest` describes the package.json fields used by DSH, with required `name` and `version` … `DshBundleManifest.patch` is one patch file path or an ordered list of them, each relative to the package root; the launcher applies a list in order as one bundle layer.

…and the two "compatibility-looking" fields are **declarative only** (`README.md:93`):

> **Compatibility is declarative.** Current installers and loaders do not enforce `dsh.manifestVersion` or `engines.dsh`; declaring a range does not reject incompatible hosts or validate SemVer syntax.

| Field | Required | Who reads it | Evidence |
|---|---|---|---|
| `name`, `version` | yes for published packages | identity, compatibility key, client module id | dsh-package-manifest `README.md:46` |
| `type: "module"` | effectively yes | host half is imported as ESM | dsh-im `package.json:30`; dsh-pocket `package.json:4` |
| `main` and/or `exports["."]` | yes | the Loader imports the host half by package name | dsh-im `package.json:45-47`; dsh-pocket `package.json:5,10-12` |
| `exports["./client"]` | only with `dsh.client` | client bundle path; **required** when `dsh.client` exists | client-modules `lib/index.js:170-181,718-719` |
| `exports["./package.json"]`, `exports["./locale/*.json"]` | recommended | display metadata for Plugin Manager / plugin inventory | skill `references/host-plugin.md:40`; dsh-im `package.json:49-50` |
| `dsh.bundle.patch` | for a bundle | string **or ordered list** of patch files | app-boot `lib/index.js:495-499`; dsh-im `package.json:76-78` |
| `dsh.client.platform` | yes with `dsh.client` | must be the string `"web"`; any other value ⇒ row ignored | client-modules `lib/index.js:65,714` |
| `dsh.client.inject` | no | string[] of **package names** whose client rows must arrive first | client-modules `lib/index.js:66,724`, `lib/client.js:656-659` |
| `dsh.client.external` | no | string[] of non-baseline module requests | client-modules `lib/index.js:67,725`; `README.md:46` |
| `dsh.client.immediately` | no | boolean; prefetch tier at boot | `lib/index.js:68,726`; frontend `dist/assets/index-5SrrfWpU.js:126` (`filter(e=>e.immediately)`) |
| `dsh.manifestVersion` | optional, inert | declared format `1` | dsh-package-manifest `README.md:52` |
| `engines.dsh` | optional, **inert** | author-declared SemVer range | `README.md:53,93` |
| `icon` (top-level), `locale/en.json`, `locale/zh.json` | recommended | card artwork (path relative to package dir) + `meta.title`/`meta.description` text read without activating the plugin | skill `host-plugin.md:29-45`; dsh-im `package.json:4`, `locale/` |
| `peerDependencies["@deepseek-ai/dsh*"]` | — | **the only enforced compatibility gate** (§7) | app-boot `lib/index.js:286-313` |
| `dsh.compatibility.{dsh,dshReleases,profiles}` | — | **not a DSH core contract** (§7.3) | 0 hits in the entire `app.asar` text scan |
| `files` | for npm publish | must contain `cordis.patch.yml`, `lib`, `client` | dsh-im `package.json:52-74`; dsh-pocket `package.json:16-23` |
| `private: true` | for local, unpublished bundles | — | skill `templates/decoration/package.json:4` |

### 1.2 VERBATIM real example — `@xmanrui/dsh-im/package.json` (installed third-party host+client plugin)

`/Users/twoants/.dsh/profiles/desktop/node_modules/@xmanrui/dsh-im/package.json` (lines 1-51, 75-103 verbatim; `keywords`/`dependencies` elided and marked):

```json
{
  "name": "@xmanrui/dsh-im",
  "version": "4.38.0",
  "icon": "./assets/logo-plugin-message-link-gradient.webp",
  "description": "把微信、飞书、企微、钉钉、QQ、Telegram、WhatsApp、Slack、Discord、Matrix接入DSH。 …",
  "keywords": [ /* 20 keywords, elided */ ],
  "author": "xmanrui (https://github.com/xmanrui)",
  "license": "MIT",
  "type": "module",
  "repository": { "type": "git", "url": "git+https://github.com/xmanrui/dsh-im.git" },
  "homepage": "https://github.com/xmanrui/dsh-im#readme",
  "bugs": { "url": "https://github.com/xmanrui/dsh-im/issues" },
  "publishConfig": { "access": "public" },
  "bin": { "dsh-im": "bin/dsh-im.mjs" },
  "main": "./lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json",
    "./locale/*.json": "./locale/*.json"
  },
  "files": [ "assets", "bin", "cordis.patch.yml", "lib", "locale/*.json", "plugin-src", "scripts/…", "src",
             "PROACTIVE_DELIVERY.md", "PROACTIVE_DELIVERY.en.md", "docs/client-integration.md", "LICENSE",
             "README.md", "README.en.md", "THIRD_PARTY_NOTICES.md" ],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-connection",
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-ui-slots",
        "@deepseek-ai/dsh-client-locale"
      ],
      "platform": "web"
    },
    "compatibility": {
      "dsh": "0.2.0-rc.2",
      "dshReleases": { "0.2.0-rc.2": "compatible" },
      "profiles": ["web"]
    }
  },
  "scripts": {
    "build": "node plugin-src/client/build.mjs && node plugin-src/host/build.mjs",
    "test": "node --test test/*.test.mjs test/channels/*/*.test.mjs",
    "check": "npm run build && npm test && node scripts/verify-package.mjs"
  },
  "engines": { "node": ">=22.19" },
  "dependencies": { "@matrix-org/olm": "3.2.15", "…": "…" }
}
```

`dsh-pocket/package.json:9-15` shows the conditional form of the same contract:

```json
  "exports": {
    ".": { "default": "./lib/index.js" },
    "./client": "./client/client.js",
    "./package.json": "./package.json"
  },
```

Both forms are accepted: `clientExportOf` takes `"string"` or `"object with a string default"`
(`/tmp/asarx/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js:170-181`).

**Note on `@deepseek-ai/dsh-client-runtime`**: dsh-im declares it in `dsh.client.inject`, but no package of that name exists in
this installation (`/tmp/asarpkg` package list). Unknown names in `inject` are simply *not found in the graph* and skipped
(`dsh-client-modules/lib/client.js:656-659` only acts when `graphRows.get(name)` exists) — harmless, but it means an
`inject` entry silently does nothing if the package is not installed. ⚠️ 未验证 whether that name resolves on other DSH builds.

---

## 2. `cordis.patch.yml` — exact syntax and semantics

### 2.1 Where it comes from

* A bundle declares it: `dsh.bundle.patch` → `bundlePatchFiles()` normalises *one path or an ordered list* and throws
  `"dsh.bundle.patch must be a file path or a list of file paths"` on anything else
  (`/tmp/asarx/…/dsh-app-boot/lib/index.js:495-509`).
* The profile's own layer is `<profile>/cordis.patch.yml` (`PROFILE_PATCH_FILENAME`, `dsh-app-boot/lib/index.js:487`),
  "hot-reloaded on long-lived surfaces" (same line).
* Layer order: each bundle in `dsh.profile.bundles`, **then** the profile's `cordis.patch.yml`, then `--patch` overlays
  (`~/.dsh/profiles/desktop/cordis.yml:1-4`; `dsh-app-boot/README.md` §Profiles).

### 2.2 Parser

`parsePatchList` (`dsh-app-boot/lib/index.js:3559-3571`):

```js
parsed = yaml.load(content, { schema: userPatchesSchema });
if (!Array.isArray(parsed)) throw new Error(`… must be a top-level YAML array of loader patch entries`);
parsed.forEach((entry, index) => { if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw … });
return anchorInsertedPluginNames(parsed, file);
```

* A **missing optional patch file = "no layer"**; an unreadable/unparsable/non-array file **throws at boot**
  (`loadOptionalPatches`, `:3500-3517`). A bundle's own patch file is *required* — a missing one throws
  (`loadOverlayPatches`, `:3527-3535`) and that skips the whole bundle.
* `anchorInsertedPluginNames` (`:3536-3545`) rewrites `insert[].name` values that are absolute or start with `./` `../`
  into `file://` URLs **relative to the patch file's directory**. Bare package names stay literal.
* `!!js` expressions are allowed and are *not* evaluated at parse time (dump prints them verbatim, `:3579-3580`).

### 2.3 Semantics (the one algorithm, shared by boot and `--dump-config`)

`applyEntryPatches` (`dsh-app-boot/lib/index.js:61-110`) is authoritative. Its own schema description
(`:2755-2762`) states it in prose:

> An insert appends entries, optionally inside the group identified by id. Other patches replace supplied fields; config is replaced wholesale, not deep-merged. A truthy name asserts the existing plugin name rather than renaming it. Unknown targets and non-insert patches without a nonempty id are warned and skipped.

Verbatim core (`:72-108`):

```js
for (const patch of patches) {
  const { id, insert, name, ...overrides } = patch;
  if (insert) {
    if (id) {
      const target = entryMap.get(id);
      if (!target) { warn("patch insert: entry %C not found", id); continue; }
      if (!target.group) { warn("patch insert: entry %C is not a group", id); continue; }
      if (!Array.isArray(target.config)) target.config = [];
      target.config.push(...insert);
    } else data.push(...insert);
    buildMap(insert);
    continue;
  }
  if (!id) { warn("patch: id is required for non-insert patches"); continue; }
  const target = entryMap.get(id);
  if (!target) { warn("patch: entry %C not found", id); continue; }
  if (name && name !== target.name) { warn("patch: name mismatch for %C (expected %C, got %C), skipping", id, target.name, name); continue; }
  for (const [key, value] of Object.entries(overrides)) { if (key === "id") continue; target[key] = value; }
}
```

Consequences that matter when authoring:

| Goal | Patch shape |
|---|---|
| Add a plugin row to the root list | `- insert: [ { id: …, name: … } ]` (no `id` on the patch) |
| Add rows inside an existing group | `- id: <group-id>` + `insert: [...]`; target must have `group: true` |
| Override a row's config | `- id: <row-id>` + `config: {...}` — **whole-object replacement, never a deep merge** |
| Disable / enable an existing row | `- id: <row-id>` + `disabled: true` (later layer wins, so `disabled: false` force-enables) |
| Assert you are patching the row you think | include `name:` — a mismatch warns and skips instead of silently retargeting |
| Target a row an earlier patch inserted | works: inserted entries are indexed as they are added (`:53-55`) |

Entry keys accepted inside `insert` (`EntryOptions`, `/tmp/asarx/…/cordis-plugin-loader/src/config/entry.ts:9-23`):
`id` (stable id inside the tree), `name` (module specifier), `config`, `group`, `disabled`, `inject`
(*required Cordis **services*** — a different thing from `dsh.client.inject`).
`disabled` may be a `!!js` expression evaluated against the loader context (`entry.ts:85-93`).

### 2.4 VERBATIM real examples

Third-party plugin bundle patches (whole files):

```yaml
# ~/.dsh/profiles/desktop/node_modules/@xmanrui/dsh-im/cordis.patch.yml (1-3)
- insert:
    - id: xmanrui-dsh-im
      name: '@xmanrui/dsh-im'
```
```yaml
# ~/.dsh/profiles/desktop/node_modules/dshmarket/cordis.patch.yml (1-4)
# dsh bundle patch: inserts this plugin into a profile's layer stack.
- insert:
    - id: dsh-market
      name: 'dshmarket'
```
```yaml
# ~/.dsh/profiles/desktop/node_modules/dsh-pocket/cordis.patch.yml (1-4)
# dsh-pocket bundle patch（dsh.bundle manifest 要求的加载配置）
# 单包单插件：装一次，设置页「手机访问」全部功能到位。
- insert:
    - id: dsh-pocket
      name: dsh-pocket
```

The live profile layer, showing id-targeted config override and `disabled`
(`/Users/twoants/.dsh/profiles/desktop/cordis.patch.yml:1-59`, excerpt):

```yaml
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
- id: ui-settings-account
  name: "@deepseek-ai/dsh-client-ui-settings-account"
  config:
    version: 1
    step: done
    usage: detailed
- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    presets:
      read-only: { sandbox: read-only, approval: ask }
    defaultPreset: danger-full-access
- id: remote-web-ui
  disabled: true
- id: better-sidebar
  disabled: true
```

A shipped bundle layer may also carry `!!js` config and group inserts, e.g.
`/tmp/asarx/…/dsh-web-app/cordis.patch.yml:202-224` (`- id: connection` … `trustedHosts: !!js ctx.webRuntime.trustedHosts`),
and `- id: hmr` / `disabled: !!js "!ctx.get('profileContext')"` in `/dsh/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:27-32`.

---

## 3. Directory layout of a working host+client plugin

`@xmanrui/dsh-im` (v4.38.0) — source dirs **and** build output both shipped:

```
@xmanrui/dsh-im/
├── package.json, cordis.patch.yml
├── plugin-src/host/{index.mjs,build.mjs,…}   # esbuild entry + config → lib/index.js
├── plugin-src/client/{index.js,build.mjs,…}  # esbuild entry + config → lib/client.js
├── src/channels/**                           # shared semantic code imported by plugin-src/host
├── lib/index.js    ← exports["."]            (built, shipped)
├── lib/client.js   ← exports["./client"]     (built, shipped)
└── locale/{en,zh}.json, assets/**, bin/, docs/, scripts/
```

`dsh-pocket` (v2.10.6) uses a flatter variant:

```
dsh-pocket/
├── package.json, cordis.patch.yml
├── lib/index.js  ← exports["."]  (hand-written ESM, not bundled) + lib/*.mjs helpers
├── client/index.jsx  # source
├── client/build.mjs  # esbuild → client/client.js
└── client/client.js  ← exports["./client"] (built, shipped)
```

Official DSH packages (`/dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/`) follow the same contract with
`main: lib/index.js`, `exports["./client"].default: ./lib/client.js`, and additional `exports["./src/*"]`.

**What the loader actually imports**

* Host half: the row's `name` (`'@xmanrui/dsh-im'`, `'dshmarket'`) is imported as a module specifier. Bare names are
  resolved through the launcher's runtime resolution, whose entries carry `scope: "installation" | "profile"`
  (`dsh-app-boot/lib/index.js:726-760`), with bundle *directory* lookup being installation-first then profile
  (`resolveBundleDir`, `:889-907`).
* Client half: **not** resolved through `exports` at runtime — the host half reads `package.json`, takes
  `exports["./client"]`, and joins it to the manifest directory to get an absolute file path
  (`dsh-client-modules/lib/index.js:718-723`).
* Client artifacts are read from disk as built files; DSH never compiles them at serve time:
  "The host serves built client bundles, so `pnpm run build` must have produced each `lib/client.js` before launch;
  a missing bundle fails activation loudly with one build instruction and a package/path list"
  (`dsh-client-modules/README.md:50`).

---

## 4. Build tooling

### 4.1 Third-party reference builds (both use esbuild)

**Host half — ESM, node platform, bundled, externals for real runtime deps**
(`~/.dsh/profiles/desktop/node_modules/@xmanrui/dsh-im/plugin-src/host/build.mjs:26-50`):

```js
await build({
  entryPoints: [resolve(sourceDirectory, 'index.mjs')],
  bundle: true, format: 'esm', platform: 'node', target: ['node22'],
  mainFields: ['module', 'main'],
  external,                       // e.g. undici, sharp, dingtalk-stream, …
  plugins: [larkSdkHandshakePatch],
  outfile: resolve(packageRoot, 'lib/index.js'),
  banner: { js: [                 // bundled ESM still needs require/__dirname/__filename
    "import { createRequire as __dshCreateRequire } from 'node:module';",
    "const require = __dshCreateRequire(import.meta.url);",
    'const __filename = __dshFileURLToPath(import.meta.url);',
    'const __dirname = __dshDirname(__filename);',
  ].join('\n') },
  sourcemap: false, minify: true, legalComments: 'eof',
});
```

**Client half — CJS + the `__ModuleLoader__` wrapper** (`…/dsh-im/plugin-src/client/build.mjs:12-37`):

```js
const result = await build({
  entryPoints: [resolve(sourceDirectory, 'index.js')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome100'],
  external: ['react', 'react-dom'],
  write: false, minify: process.env.NODE_ENV === 'production', legalComments: 'none',
});
const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(loaderId)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${bundled}
    return module.exports;
  }
});
`;
```

`dsh-pocket/client/build.mjs:12-46` is the same shape with `external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives']`
and an explicit warning that matters if you use JSX (`:32-38`):

> The DSH client module system provides react as a module, never as a global. esbuild keeps react external … its classic
> JSX transform emits bare `React.createElement` calls … so the bundle must bind React itself - otherwise every mobile
> component crashes at render time with "ReferenceError: React is not defined".
> → hence `var React = require("react");` inside the factory.

Emitted artifact confirmed on disk: `~/.dsh/profiles/desktop/node_modules/dsh-pocket/client/client.js:1-3` starts
`window.__ModuleLoader__.load({ id: "dsh-pocket", factory: (require) => { …`.

**Format summary**

| Half | Format | Module system | Example |
|---|---|---|---|
| Host | ESM (`"type": "module"`), can be plain `.js`/`.mjs` or an esbuild bundle | Node `import()` by the Cordis Loader | `lib/index.js` (dsh-im, dsh-pocket), `src/index.ts` for shipped pkgs |
| Client | **CJS** code inside an IIFE-style wrapper that *calls* `window.__ModuleLoader__.load({id, factory})` | the browser's lazy-CJS table; `require` = frozen seed table + declared externals | `lib/client.js` (dsh-im), `client/client.js` (dsh-pocket) |

The official DSH build chain is different but produces the identical wrapper: DSH's own bundles contain a rolldown runtime
marker and are built by **tsdown** (`/dsh/node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js:6` `//#region \0rolldown/runtime.js`;
`dsh-client-modules/README.md:38,74`: "A source `import()` split by tsdown compiles to `require.async("./client.<name>.js")`";
`dsh-client-hmr/README.md:32`: "the shared Client tsdown preset"). A third-party plugin does **not** need tsdown —
esbuild + the wrapper is sufficient and is what all three installed third-party plugins use. ⚠️ 未验证 whether `require.async`
(code-splitting chunks) is needed for anything except very large plugins.

### 4.2 React / JSX availability

React is available; it comes from a frozen table in the shell, not from a global. The **exact** table in 0.2.0-rc.2 is the
`rM()` function in `/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-5SrrfWpU.js:126` (single-line minified bundle):

```js
function rM(){return{react:Ef,"react/jsx-runtime":If,"react-dom":Rf,"react-dom/client":Df,
"@deepseek-ai/cordis":sf,"@deepseek-ai/dsh-client-store":lh,
"@deepseek-ai/dsh-client-ui-slots":hh,"@deepseek-ai/dsh-client-ui-primitives":sE,
"@deepseek-ai/dsh-client-ui-dockkit":XS}}
```

It is handed to the module system as `staticModules` during boot
(same file, line 126: `this.modules=o.create({boot:n.__DSH_BOOT__,staticModules:rM(),…})`).
These 9 specifiers are the *complete* baseline; anything else must be declared in `dsh.client.external`
and answered by another plugin row (`dsh-client-modules/README.md:46`). The official authoring skill advises third-party
UI plugins **not** to import Harness client packages at all (`…/cordis-plugin-development/SKILL.md:25`), even though the
table technically allows it.

So: JSX is possible but must be compiled away (esbuild `jsx: 'automatic'` → `react/jsx-runtime`, or classic + a bound
`React`), and the client half is plain JS calling the slot/hyperscript API — the official template uses
`React.createElement` (`templates/decoration/client.js:5`).

---

## 5. How the client half is discovered and injected

### 5.1 Host side (discovery + serving)

1. `dsh-client-modules` is itself a row of the web bundle (`/tmp/asarx/…/dsh-web-app/cordis.patch.yml:211-213`, `id: modules`).
   Its node half "scans **enabled Loader entries** and composes the boot graph" (`dsh-client-modules/README.md:12`).
2. Per package: locate the manifest of the package the row names → `parseDshClient(packageName, pkg.dsh.client)`
   (`lib/index.js:701-731`).

```js
const decl = parseDshClient(packageName, dsh !== null && typeof dsh === "object" ? dsh.client : void 0);
if (decl === void 0 || decl.platform !== "web") { this.pkgMeta.set(sourceKey, null); return null; }
const clientRel = clientExportOf(packageName, pkg.exports);
if (clientRel === void 0) throw new Error(`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`);
```
3. `parseDshClient` (`lib/index.js:61-75`) accepts exactly `platform` (required string), `inject`, `external`, `immediately`;
   a non-object `dsh.client`, a non-string `platform`, a non-string-array `inject`/`external`, or a non-boolean
   `immediately` each **throws a named `client-modules: …` error**.
4. Rows become `WebBootEntry` records injected into the document as `window.__DSH_BOOT__`
   (`dsh-client-modules/README.md:64,80`), and bundles are served from the absolute route `PLUGIN_ROUTE = "/plugins"`,
   `contentType: "text/javascript; charset=utf-8"` (`lib/index.js:201,661-673,953`), e.g.
   `/plugins/<pkg>/client.js` or the combo `/plugins/??a/client.js,b/client.js&rev=<hash>`.
   The file body is snapshotted from disk at publication; its revision is the sha1 of `mtimeMs|ctimeMs|size` — **no content
   hashing, no rebuild on request** (`lib/index.js:192-199`; `README.md:74`).
5. Because discovery is driven by **Loader entries**, a package that declares `dsh.client` but ships no host row
   (no `dsh.bundle`) is never served, even after a restart — verified in a real third-party installer's comment:
   `/Users/twoants/.dsh/profiles/desktop/node_modules/dshmarket/lib/hot.js:562-570`
   ("Client-only packages (dsh.client, no dsh.bundle) never get a loader entry — not even after a restart — so
   client-modules would never serve their bundle"). **Always ship a host half + patch.**

### 5.2 Browser side (execution)

* The page installs `window.__ModuleLoader__`, a small facade: "The facade's `create()` materializes the modules bundle,
  delegates construction to its `createClientModuleSystem` export, and leaves the same facade in live-registration mode"
  (`README.md:80`).
* A bundle's only job at script-evaluation time is to register a factory:

```js
window.__ModuleLoader__.load({ id: "<package name>", factory: (require) => { /* … */ return exports } })
```
  documented at `/tmp/asarx/…/dsh-client-modules/lib/client.js:16-23`:
  "executing a plugin bundle only REGISTERS its factory … Materialization (`factory(require)` → exports) happens on first
  import/require and is memoized in `ClientModuleLoader.loadCache`" and "factory-form CJS cannot deliver partial exports"
  (require cycles throw, `lib/client.js:677`).
* The **factory's return value is the module's exports** — the official template returns the plugin object directly
  (`templates/decoration/client.js:13-20`), dsh-im returns `module.exports` from its esbuild CJS body.
* Each graph row becomes a Cordis Loader entry named after the package: `create(loader, id)` builds
  `const options = { name: id }` (`lib/client.js:353-357`) and the module system replaces `EntryTree.import`, so the row's
  plugin object passes through `loader.unwrapExports` (`cordis-plugin-loader/src/index.ts:200-208`:
  `exports = exports.default ?? exports; if (!exports.__esModule) return exports; return exports.default ?? exports`)
  and must satisfy `isApplicable` — an object with `apply`, or a function (`cordis/lib/index.js`, `isApplicable`).
* `dsh.client.inject` = **arrival ordering between packages**, not service injection
  (`lib/client.js:643-661`): before a row arrives, the graph rows named by `inject` are arrived first
  ("Register each injected package and unresolved dynamic request before its consumer").
  Cordis **service** injection is the plugin's own `export const inject = ['slots', …]` (dsh-im
  `plugin-src/client/index.js:88-89`; host `plugin-src/host/index.mjs:27-32`).
* UI registration uses the slot service, e.g. official template
  (`templates/decoration/client.js:14-19`):
```js
return { inject: ['slots'], apply(ctx) {
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock', id: 'my-decoration', order: 5,
  }, Decoration));
} };
```
  and dsh-im (`plugin-src/client/index.js:595-601`, tail): `ctx.slots.inject('settings.section', () => ctx.slots.register({ name:'settings.section', id:'xmanrui-dsh-im', order:21, label: () => t('IM机器人'), locale: IM_LOCALE_NAMESPACE, inject: () => panelDependencies }, buildPanelElement))`.
  Authoring rules that are enforced by review, not by code: register every resource in `apply` with
  `ctx.effect`/`ctx.on` and return the cleanup; keep factories side-effect free; route visible text through the locale
  service; never replace the app root (`SKILL.md:25`, `references/ui-plugin.md:9-12`).
  Live slot trees and props are queryable read-only with `cordis_inspect_query` on the Client provider
  (`SKILL.md:23,30` — `Slots.listSubTree`, `Theme`).

---

## 6. Local development workflow

### 6.1 The sanctioned path

`SKILL.md:8,10` (official, shipped in DSH):

> For implementation, use ordinary workspace files to author a bundle, then `plugin_manager` with `action: install_bundle`
> and the absolute package directory as `target` to install it in the current profile. …
> Do not write the profile's `package.json` or `cordis.patch.yml`, create packages under `$DSH_HOME`, or run pnpm in the
> profile directory: `install_bundle` performs those steps.

What `install_bundle` does underneath (`/tmp/asarx/…/dsh-plugin-manager/README.md`):

| Step | Evidence |
|---|---|
| reads the spec; **an absolute path has its own `package.json` read** | `:46` |
| pre-checks DSH peers **before pnpm runs** — "A local path is read from its own `package.json` … An incompatible DSH peer rejects the operation before pnpm runs, so nothing is downloaded" | `:63` |
| runs `pnpm add <spec>` **in the profile directory**, then selects the bundle (`dsh.profile.bundles`) | `:54`, `:148` |
| rolls `package.json`/`pnpm-lock.yaml` back on failure/cancel; reports `pendingBuilds`; `approvedBuilds` grants script permission after explicit user approval | `:54`, `:58` |
| writes each run to `.plugin-manager/run.json`, logs under `.plugin-manager/logs` | `:92`, `:133` |

CLI equivalent exists (`dsh plugin --profile <name> add <package>`, `install`, `remove`, `version-exemptions`,
`allow-version`, `revoke-version`): `dsh-app-boot/lib/index.js:974`; `dsh-plugin-manager/README.md:63,69,131`.
For the **Desktop** profile prefer the tool: "Application-owned npm projects, such as Electron's reserved Desktop profile,
use `loadProfileDirectory` to load an already initialized directory without exposing it through CLI profile lookup"
(`dsh-app-boot/README.md` §Profiles). The Desktop host calls
`loadProfileDirectory("dsh", projectDir, installAnchor)` + `runProfile({profile:"desktop", args:["--no-open","--port","19387"]})`
(`/tmp/asarx/…/dsh-desktop-host/lib/index.js:216-235`).

### 6.2 Restart vs live reload

| Event | Live? | Evidence |
|---|---|---|
| Profile `cordis.patch.yml` edit (row added/removed/config changed) | **live**, ~seconds | `@deepseek-ai/dsh-base/cordis.patch.yml:27-32` inserts `@deepseek-ai/dsh-hmr` with `config: { root: [] }` and `disabled: !!js "!ctx.get('profileContext')"`; `dsh-hmr/README.md:57`: "Profile and home patch changes also trigger recomposition"; third-party confirmation `dshmarket/lib/patch.js:10-12`: "The profile's config-file watcher (HMR) re-composes within ~1s of the save — no restart" |
| Host **JS module** re-edited on disk | **not live with the shipped config** — watching source modules is opt-in: `config: { root: ["."] }` on the `hmr` row (`dsh-hmr/README.md:27-34`; `root: []` "retains only explicit configuration watches", `:43`) |
| Newly **installed** bundle becoming active | live when the ordered `dsh.profile.bundles` list changes: "manifest notifications reload only when the ordered `dsh.profile.bundles` list changes" (`dsh-hmr/README.md:57`) |
| Replacing an already-installed package's code | **restart required**: "replacing an installed package requires restart to load a fresh JavaScript module generation" (`…/SKILL.md` → `references/host-plugin.md:58`) |
| Web client bundle (`lib/client.js`) changed on disk | **no web-frontend rebuild, no page refresh**: the page fetches `/plugins/<id>/client.js`; `@deepseek-ai/dsh-client-hmr` stat-polls each stamped artifact (`pollIntervalMs` default 500) and swaps the plugin in the open page (`dsh-client-hmr/README.md:12,32,36,40-48`). React state inside the swapped plugin is lost; session/workspace/connection state survives |
| Client bootstrap / platform table changed | "Removing or replacing the bootstrap requires a page reload" (`dsh-client-modules/README.md:132`) |

### 6.3 Caveats

* Retry after a failed client bundle: `client-modules: could not load "<id>": <url>: loaded without registering "<id>" via __ModuleLoader__.load`
  / `require("<spec>") missed the module table … (a build-time externals drift…)` (`lib/client.js:625,705,640`).
  The usual cause is a missing `dsh.client.external` entry or a factory that never runs `__ModuleLoader__.load` with the
  exact package name as `id`.
* Duplicate `insert` ids across layers are a **hard boot failure** — third-party installer comment:
  "inserting an id the bundle layer also inserts is a hard boot failure" (`dshmarket/lib/hot.js:9-10`).
  Never hand-add a row in `cordis.patch.yml` for a bundle that its own `cordis.patch.yml` already inserts.
* Manual fallback (⚠️ 未验证 end-to-end, and explicitly discouraged by `SKILL.md:10`): add the dependency to
  `~/.dsh/profiles/desktop/package.json`, add the name to `dsh.profile.bundles`, then `pnpm install` in the profile dir.
  A row inserted **directly** in the profile's `cordis.patch.yml` also works for an existing installed package, because
  that file's `insert[].name` is resolved like any other row (bare names via runtime resolution,
  `./relative` names via `anchorInsertedPluginNames`, `dsh-app-boot/lib/index.js:3536-3545`).
* There is no client-side build step in the shell: `dsh-web-frontend` is prebuilt inside `app.asar`; a third-party plugin
  never touches `pnpm run dev:web`.

---

## 7. Compatibility gate

### 7.1 The enforced rule: `peerDependencies` on `@deepseek-ai/dsh*`

`evaluatePluginCompatibility` (`/tmp/asarx/…/dsh-app-boot/lib/index.js:286-313`):

```js
if (!Object.hasOwn(fields, "peerDependencies")) return void 0;
for (const [name, range] of Object.entries(dependencies)) {
  if (typeof range !== "string") throw new Error(`Plugin manifest peerDependencies[…] must be a string`);
  if (name !== "@deepseek-ai/dsh" && !name.startsWith("@deepseek-ai/dsh-")) continue;
  const requirement = ["workspace:^","workspace:~","workspace:*"].includes(range) ? runtimeVersion : range;
  if (requirement.trim() === "" || !semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })) peers[name] = range;
}
```

* It is **not** an exact-match rule: it is `semver.satisfies` with `includePrerelease`. An exact pin such as
  `"@deepseek-ai/dsh": "0.2.0-rc.2"` is simply the most conservative range an author can write. A caret range works.
* Only `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` peers are examined; other peers are ignored.
* The runtime version comes from the dsh installation (`getDshRuntimeVersion()`, `:271-275`, reading app-boot's own
  `package.json`; `dsh-app-boot/README.md`: "missing or invalid versions fail rather than bypassing compatibility checks").
* Where it fires: bundle layers at profile load (`:925-945`) and every plugin-manager install/enable path
  (`dsh-plugin-manager/lib/index.js:1490-1491,1787-1788,1986-1987`).

### 7.2 Messages

Exact user-facing text (`pluginCompatibilityWarning`, `dsh-app-boot/lib/index.js:320-323`):

> `Plugin <name>@<version> is incompatible with dsh <runtimeVersion>: peerDependencies {"<peer>":"<range>"}. Running it may cause crashes or data loss. Update the plugin or install a plugin version compatible with this dsh runtime. To accept this risk explicitly, grant the exact-version exemption for <name>@<version> on dsh <runtimeVersion> with \`dsh plugin allow-version\` or the plugin manager, then retry the installation or restart dsh. Exact-version exemption: active|not active.`

* Bundle-level refusal never kills boot: the bundle is skipped and listed, printed once per start as
  `dsh: skipping profile bundle "<name>": <reason>` (`reportSkippedBundles`, `:515-517`).
* Tool/CLI refusal carries the machine code `incompatible-version` with
  `name`, `version`, `runtimeVersion`, `peers` (`dsh-plugin-manager/lib/index.js:1491,1788,1987`;
  `dsh-plugin-manager/README.md:69`). CLI exits 1.

### 7.3 What is **not** a gate (verified absent)

A full-text scan of every `.js/.mjs/.cjs/.json/.md/.ts/.yaml` file inside `app.asar` (≤3 MB each) found **zero**
occurrences of `dshReleases` or `dsh.compatibility`. `@xmanrui/dsh-im` is the only package on this machine that declares them;
its bundle inlines its own `package.json` (the literal `compatibility:{dsh:"0.2.0-rc.2",dshReleases:{…}}` appears inside
minified `lib/index.js`) and carries a few of its own locale strings mentioning "compatibility". **No DSH-core reader exists.** Likewise `dsh.manifestVersion` and `engines.dsh` are unenforced
(`dsh-package-manifest/README.md:93`). Third-party tooling may still *display* them: `dshmarket` reads
`engines.dsh` / `dsh.engines.dsh` / `peerDependencies` as advisory discovery metadata
(`~/.dsh/profiles/desktop/node_modules/dshmarket/lib/discovery-compatibility.js:38-57`).

**Practical consequence:** to be admitted by 0.2.0-rc.2, a plugin needs a satisfying
`peerDependencies` entry — `dsh.compatibility: { dsh: "0.2.0-rc.2" }` buys nothing. And because *every* `@deepseek-ai/dsh*`
peer is checked, only declare peers for packages you actually import.

### 7.4 Exemptions

* Stored in `<profile>/compatibility.json` — a JSON object mapping the **exact** `package-name@version` key to a list of
  **exact** DSH runtime versions (`PROFILE_COMPATIBILITY_FILENAME`, `dsh-app-boot/lib/index.js:328,359-403`).
  "A missing file authorizes nothing." A malformed file authorizes nothing, warns, and becomes read-only so a grant
  refuses instead of overwriting (`:352-358,411-431`).
* Grant requires explicit risk acknowledgement: `acceptRisk` / `--accept-risk`, and the named DSH version must be the
  running one (`:421-425`).
* Surfaces: `plugin_manager` `list_version_exemptions` / `set_version_exemption`
  (`target`, `runtimeVersion`, `enabled`, `acceptRisk: true` after a user warning) and the CLI
  `dsh plugin --profile <p> allow-version <pkg@version> --dsh-version <runtime> --accept-risk` /
  `revoke-version` / `version-exemptions` (`dsh-plugin-manager/README.md:65,69`).
* An exemption changes no dependency, no bundle selection and no patch layer; it is not inherited by an upgrade of either side.
* On a *bundle* skip the profile keeps booting; on an install the operation is refused before pnpm runs (§6.1).

---

## 8. Minimal skeleton for 0.2.0-rc.2

Four files. The host entry, patch and manifest are the official template
(`/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/`), extended with
everything this research verified. Legend: **[V]** verified in 0.2.0-rc.2 sources, **[I]** inferred/adapted.

```
my-plugin/
├── package.json      # §8.1
├── cordis.patch.yml  # §8.2
├── index.js          # host half
└── client.js         # client half (already-built artifact; no bundler needed at this size)
```

**`package.json`** — **[V]** for every field (template `templates/decoration/package.json:1-15`; `./package.json`/`locale`
exports from `references/host-plugin.md:40`):

```json
{
  "name": "@local/my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "peerDependencies": { "@deepseek-ai/dsh": "0.2.0-rc.2" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": [],
      "external": []
    }
  }
}
```
**[V]** `platform` must be exactly `"web"` (`client-modules/lib/index.js:714`). **[V]** `peerDependencies` is the only
enforced field (§7.1) — *omit it entirely* and the gate passes vacuously; include it when you want to declare support.
**[I]** `immediately: true` is copied from the template; it only prefetches the bundle at boot, and a decoration may
prefer to drop it.
Publishing to npm additionally needs `files: ["cordis.patch.yml","index.js","client.js","locale/*.json"]` **[V]** pattern
from `dsh-im`/`dsh-pocket`.

**`cordis.patch.yml`** — **[V]** verbatim template (`templates/decoration/cordis.patch.yml:1-3`):

```yaml
- insert:
    - id: my-plugin
      name: '@local/my-plugin'
```
**[V]** `id` is the addressable row id (keep it unique across all layers, §6.3); `name` is the module specifier the Loader
imports. Add `config: {}` only if the host half declares `export const Config` (`references/host-plugin.md:20-27,51-54`).

**`index.js`** (host half) — **[V]** template is literally
`export function apply() {}` (`templates/decoration/index.js:1-2`).
**[V]** The accepted export forms (`references/host-plugin.md:47-54`) are *either*
`export function apply(ctx, config) {}` with optional `export const inject = ['tools']` and `export const Config`,
*or* a service class as the default export — do not mix.
**[V]** It may be empty: a host half exists only so the package has a Loader entry, which is what makes the client half
discoverable (§5.1.5). A host-only bundle needs no `dsh.client` at all.

**`client.js`** (client half) — **[V]** verbatim template (`templates/decoration/client.js:1-22`):

```js
window.__ModuleLoader__.load({
  id: '@local/my-plugin',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    function Decoration() {
      return h('svg', { viewBox: '0 0 64 64', width: 48, height: 48,
        'aria-hidden': true, style: { display: 'block', pointerEvents: 'none' } },
        h('circle', { cx: 32, cy: 32, r: 24, fill: '#247bbf' }));
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'my-plugin', order: 5,
        }, Decoration));
      },
    };
  },
});
```
**[V]** `id` **must equal the package name** — it is the module id the boot graph registers and the Loader imports
(`client-modules/lib/client.js:353-357`; `README.md:38` "`<id>/client` and the bare id resolve to the same exports").
**[V]** The factory's return value is the plugin object; an object with `apply` or a function both work
(`unwrapExports` + `isApplicable`, §5.2). **[V]** `inject: ['slots']` here is the *Cordis service* list, not
`dsh.client.inject`. **[V]** Slot id `conversation.composer.dock` and the `{name, id, order}` options are the template's;
confirm against the live tree with `cordis_inspect_query` → Client `Slots.listSubTree` before shipping (`SKILL.md:23`).
For a compiled `.jsx` source use §4.1's esbuild config instead of hand-writing this file.

**Install (from your workspace, using the sanctioned tool):**

```
1. write the four files in a workspace directory, e.g. /Users/me/proj/my-plugin/
2. plugin_manager { action: "install_bundle", target: "/Users/me/proj/my-plugin" }
   → pnpm add in ~/.dsh/profiles/desktop + selection in dsh.profile.bundles
3. if it reports pendingBuilds, get explicit user approval, then retry with approvedBuilds:[…]
4. read the returned `application` field: "applied" = live; otherwise the failure/restart code
```
**[V]** steps 2-4 are the documented contract (`SKILL.md:8,25`; `dsh-plugin-manager/README.md:46,54,58`).
**[I]** If install_bundle is unavailable, the fallback of §6.3 applies; restart DSH afterwards because a *new* bundle
selection is only guaranteed live when the bundles list change is observed by HMR.

**Verified vs inferred, condensed**

| Part | Status |
|---|---|
| manifest fields, `dsh.client.*` parser rules, `./client` requirement | **[V]** client-modules `lib/index.js:61-75,170-181,701-731` |
| patch syntax/semantics, layer order, hot reload of the profile patch | **[V]** app-boot `lib/index.js:61-110,487,920-955,3559-3571`; dsh-hmr `README.md:27-34,57` |
| `window.__ModuleLoader__.load({id, factory})` wrapper + basename id | **[V]** official template + shipped bundles |
| 9-entry static module baseline | **[V]** `dsh-web-frontend/dist/assets/index-5SrrfWpU.js:126` |
| host needs a Loader entry for the client half to be served | **[V]** `dsh-client-modules/README.md:12`; `dshmarket/lib/hot.js:562-570` |
| `peerDependencies` gate + exact warning text + exemptions | **[V]** app-boot `lib/index.js:286-323,328-438` |
| `dsh.compatibility`/`dshReleases` are inert | **[V]** zero hits in `app.asar` |
| "works end-to-end after install_bundle in this Desktop profile" | ⚠️ 未验证 — not executed (read-only task) |
| slot name/props for a real destination | ⚠️ 未验证 for this build — query `Slots.listSubTree` live |
| `dsh.client.external` needs beyond the static table | ⚠️ 未验证 — no installed third-party plugin uses it |

---

## 9. Blocking unknowns for authoring a new host+client plugin

1. ⚠️ 未验证 — nothing here was executed: no install, no restart, no page load. The skeleton is assembled from the shipped
   template plus verified readers; only an actual `install_bundle` run can confirm the end-to-end path in this profile.
2. ⚠️ 未验证 — whether `plugin_manager.install_bundle` accepts a *file:*/link spec for a folder that stays outside the
   profile (the tool lists "absolute path" as a target; `dsh-plugin-manager/README.md:46,63` confirms absolute paths are
   read and pre-checked, but the resulting lockfile form — `file:` vs copied — is not shown anywhere I could read).
3. ⚠️ 未验证 — whether the Desktop (Electron-owned) profile can also be managed by `dsh plugin --profile desktop …`;
   `loadProfileDirectory` is documented as *not* exposed to CLI profile lookup (`dsh-app-boot/README.md` §Profiles).
   Use `plugin_manager`.
4. ⚠️ 未验证 — exact HMR latency/behaviour for a *newly installed* bundle in this Desktop build; the docs say selection
   changes reload when the ordered bundles list changes (`dsh-hmr/README.md:57`), and third-party code says ~1 s for
   patch-file saves (`dshmarket/lib/patch.js:10-12`).
5. ⚠️ 未验证 — no shipped third-party plugin declares `dsh.client.external`, so the failure mode of a missing/incorrect
   external is known only from the runtime error strings (`client-modules/lib/client.js:625,705`).
