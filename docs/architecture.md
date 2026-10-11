# 架构

本文把规划 §10.1 的六个逻辑层与 §13.1 的七个逻辑模块，逐层对应到实际文件与数据流。

---

## 1. 分层与文件对应

```
┌──────────────────────────────────────────────────────────────────────┐
│ ① DSH 插件 UI（规划 §10.1-1 / §13.1「前端插件 UI」）                  │
│   src/client/index.js     入口：main 面板、侧栏图标、会话页入口        │
│   src/client/app.js       外壳：左侧导航 + 内容区                      │
│   src/client/views/*      发现 / 好友 / 消息 / 收藏 / 节点 / 我的      │
│   src/client/share-dialog.js · live-room.js                            │
│   src/client/kit.js       自研控件（只用 --dsw-alias-* 主题变量）      │
│   src/client/styles.js                                                 │
├──────────────────────────────────────────────────────────────────────┤
│ ② DSH 适配层（规划 §10.1-2）                                          │
│   src/host/capture.js     订阅 session/event + agent/assistant-stream  │
│                           同步热路径只做 O(1) 入队；类型白名单；去重    │
│   src/host/index.js       读会话用 ctx.sessionQuery / ctx.sessions     │
├──────────────────────────────────────────────────────────────────────┤
│ ③ 身份与密码学层（规划 §10.1-3）                                      │
│   src/host/identity.js    Ed25519 密钥、指纹、签名、验签、内容哈希      │
│   src/shared/canonical.js 稳定序列化（签名的前提）                     │
│   src/host/consent.js     授权门（不是密码学，但属于"谁可以看"这一层）  │
│   src/host/redaction.js   出站脱敏 waterfall                          │
├──────────────────────────────────────────────────────────────────────┤
│ ④ P2P 网络层（规划 §10.1-4）                                          │
│   src/host/net/transport.js  NodeTransport 接口 + 内存传输（测试）      │
│   src/host/net/lan.js        局域网实现：信标发现、邀请码、双向握手     │
│   src/host/net/ws.js         自研 RFC6455（服务端 + 客户端）            │
│   src/host/net/envelope.js   签名信封、去重、重放与时钟偏差防护         │
│   src/host/peers.js          好友 / 关注 / 拉黑                        │
├──────────────────────────────────────────────────────────────────────┤
│ ⑤ 内容寻址与缓存层（规划 §10.1-5）                                    │
│   src/host/share.js      分享对象：内容 ID、Merkle 根、签名、策略       │
│   src/host/live.js       直播事件流（有序、可补拉、可裁剪）             │
│   src/host/directory.js  插件清单与评分                               │
│   src/host/store.js      本地原子写 + JSONL 追加日志                   │
├──────────────────────────────────────────────────────────────────────┤
│ ⑥ 可选验证层（规划 §10.1-6）                                          │
│   —— 未实现。规划 §2.3 / §11.4 明确说它是可选项，不属于 MVP。          │
└──────────────────────────────────────────────────────────────────────┘
```

Host 与 Client 之间的两条通道（`src/host/rpc.js` + `src/client/rpc.js`）横跨 ①②。

---

## 2. 数据流

### 2.1 好友消息（规划 §10.3）

```
发送者 UI
  └─ RPC messages.send
       ├─ PeerBook.isFriend? 不是好友 → 拒绝
       ├─ PeerBook.acceptsMessagesFrom? 已拉黑 → 拒绝
       ├─ EnvelopeCodec.seal(DIRECT_MESSAGE)  ← 签名
       ├─ LanTransport.send → WebSocket 文本帧
       └─ 本地 messages.jsonl 追加 + SSE 推给界面

接收者 LanTransport
  └─ EnvelopeCodec.open  ← 版本 / 时间偏差 / 去重 / 验签 / 收件人过滤
       └─ onEnvelope → 拉黑检查 → messages.jsonl → SSE 推给界面
```

**注意**：规划 §5.3 要求端到端加密，本版本没有实现。信封保证的是
**真实性与完整性**，不是机密性。协议里留了 `payload.crypto` 字段位。

### 2.2 公开会话分享（规划 §10.3）

```
UI 分享对话框
  └─ 用户选择范围 / 粒度 / 内容类型  →  sessions.preview（必须看过）
       └─ RPC share.create
            ├─ ConsentGate.authorize(previewed: true)   ← 没有预览标记直接拒绝
            ├─ sessionQuery.readSession → 逐条映射成 ledger record
            ├─ 按 grant.contentKinds 过滤
            ├─ 逐条 RedactionPipeline.apply   ← 任一条被扣下就跳过它
            ├─ merkleRoot(items.contentId)
            ├─ id = hash(除 id 与 sig 之外的全部字段)
            └─ sig = sign(除 sig 之外的全部字段)
```

校验时 `integrity` 与 `authenticity` **分开返回**，因为规划 §6.4 明确说
「内容哈希只能证明数据一致性，不能证明内容一定真实」。

### 2.3 实时直播（规划 §10.3）

```
DSH 主循环 append(event)
  └─ ctx.on('session/event', { global: true })   ← 同步派发，在 append 路径上
       └─ Capture handler（只做 Map 查表 + 数组 push，绝不 await）
            ├─ ConsentGate.isAuthorized? 否 → 直接丢弃（正文连深拷贝都不做）
            ├─ 类型白名单 + (session, seq) 去重
            └─ onRecord → LiveEngine.ingest
                 ├─ 房间暂停？→ 丢弃
                 ├─ ConsentGate.check(内容类型, 范围)
                 ├─ 构造 payload → RedactionPipeline.apply（fail-closed）
                 └─ LiveRoom.append → seq++ → 签名 → 广播

ctx.on('agent/assistant-stream', { global: true })  ← token 级、进程内、瞬时
  └─ LiveEngine.ingestChunk → 只做观感，不落盘、不签名、可丢
```

**两条通道的分工是刻意的**：`session/event` 是事实来源（有 `seq`，可补拉），
`assistant-stream` 只提供打字机观感（没接住就永久丢失）。这正是前置验证报告里
「双发 + 对账」的结论。

### 2.4 插件清单（规划 §10.3 / §4.4）

```
publishManifest → contentHash + sig → PLUGIN_MANIFEST 信封 → 各节点
接收方 → importManifest → 完整性与真实性都通过才入库
同一 pluginId+version 出现两份不同清单 → 判为冲突，保留先到的，不静默覆盖
```

---

## 3. 为什么这样分层

### 3.1 传输层是可替换的接口，不是 libp2p 的包装

规划 §18.2 第 4 条要求「再决定是否选择 libp2p、WebRTC、IPFS 或其他技术路线；
这些技术应该按实测结果选择，而不是全部同时引入」。

所以 `NodeTransport`（`net/transport.js`）只定义接口：`start` / `stop` / `connect` /
`send` / `broadcast` / `peers` + 五个事件。当前实现是 `LanTransport`，
上层的 peers / share / live **完全不 import 任何具体传输实现**。
换实现时上层代码不需要改。

### 3.2 未授权会话在采集层就丢弃

一个容易被忽略的隐私细节：`Capture` 在归一化之前先查授权表。未授权 →
直接 `return`，**事件连深拷贝都不会发生**。也就是说关着分享的会话，
它的正文根本不会在 dsh-chat 的内存里留下副本。

这不只是性能考虑，而是一条可验证的隐私属性。

### 3.3 同意机制在 Host 侧强制，不依赖界面

`ConsentGate` 有两条界面绕不过的前置条件：

1. `previewed: true` 是硬要求（当 `live.requirePreview` 为真）；
2. 粒度上限永远压在用户勾选之上。

所以就算有人绕过 UI 直接调 RPC，也拿不到授权。界面上那句"必须先看过预览"
是事实描述，不是提醒。

### 3.4 可变注解与被签名对象分离

分享对象、插件清单、评分都有一个共同陷阱：**签名/哈希一旦覆盖可变字段，
任何后续修改都会破坏它**。所以约定是：

- `id` / `contentHash` 覆盖「不可变主张」；
- 可变注解（有用票、举报、作者回复）**不参与**，其中作者回复是**独立的签名记录**；
- 包装返回值时**不改动原对象**（`ratingsFor` 返回 `{rating, verdict}` 而不是 `{...rating, verified}`）。

这三条都是被测试逼出来的（见 `docs/verification.md` §4.1 的缺陷 3–6）。

---

## 4. 与 DSH 的集成点

| 集成点 | 用法 | 为什么这么用 |
|---|---|---|
| 会话事件 | `ctx.on('session/event', h, { global: true })` | `global` 必需，否则收不到其它 session 的事件；handler 必须非阻塞 |
| token 流 | `ctx.on('agent/assistant-stream', h, { global: true })` | 进程内、瞬时，只用于观感 |
| 读会话 | `ctx.sessionQuery.readSession` / `listSessions` / `readTitle` | 官方读写分离的安全侧 |
| 复制为新会话 | `ctx.sessions.fork(source, boundary, childId)` | 官方现成的按 `seq` 分叉能力 |
| 主面板 | `ctx.slots.register({ name: 'main', key: 'dsh-chat' })` | keyed 槽位，不占用别人的 key |
| 侧栏入口 | `ctx.slots.inject('sidebar.panellist', …)` | 官方声明的全局面板图标位 |
| 会话页入口 | `ctx.slots.inject('conversation.session.header.actions', …)` | slot 的 `standardProps` 里就有 `sessionId`，不需要自己找会话 |
| 直播状态条 | `ctx.slots.inject('conversation.input.dock', …)` | 输入框上方的全宽条目位 |
| RPC | `ctx.connection.fetch.register({ path: '/api/dsh-chat/rpc', … })` | **继承浏览器认证与 Host/Origin 信任** |
| SSE | `ctx.webServer.register({ kind: 'exact', path: '/dsh-chat/events', … })` | 原始 `node:http` 对象，可长时间流式；但**没有认证**，所以自建进程内 token 门禁 |
| 资源清理 | `ctx.effect(...)` 包住所有注册 | 插件卸载时监听器、路由、定时器一并清理 |

**没有做**的事：不 `require` 任何 `@deepseek-ai/dsh-client-*` 包（官方 UI 规范明令禁止）；
不替换 app root；不往 `document.body` 追加东西；不读其它插件的 DOM。

---

## 5. 数据落盘

| 路径 | 内容 | 权限 |
|---|---|---|
| `~/.dsh/dsh-chat/identity.json` | Ed25519 私钥（**绝不外发**） | `0600` |
| `~/.dsh/dsh-chat/profile.json` | 昵称、简介 | `0600` |
| `~/.dsh/dsh-chat/peers.json` | 好友 / 关注 / 拉黑关系 | `0600` |
| `~/.dsh/dsh-chat/shares.json` | 本机创建的分享对象 | `0600` |
| `~/.dsh/dsh-chat/share-sources.json` | 分享 id → 源会话 id（**仅本机**，不进分享对象） | `0600` |
| `~/.dsh/dsh-chat/messages.jsonl` | 私聊消息（追加日志） | `0600` |
| `~/.dsh/dsh-chat/audit.jsonl` | 授权/撤销/拒绝审计（**不含正文**） | `0600` |

所有写入都是「先写同目录临时文件再 rename」的原子写。
JSONL 读取时跳过坏行而不是丢掉整个文件。

目录可以用 `DSH_CHAT_DATA_DIR` 覆盖 —— 测试就是靠它把多个节点隔离到不同临时目录的。
