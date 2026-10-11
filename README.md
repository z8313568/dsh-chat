# dsh-chat

面向 DSH 的去中心化 AI 社交与创作网络。按 `dsh-chat_product_plan (1).md`（V2.0）实现，
范围是**规划的阶段 0 + 阶段 1 核心骨架**：一个真正能安装、能跑、能被外部验证的 DSH 插件。

> 一句话：让每一次 AI 对话，都可以被分享、讨论和复现。
>
> 本版本已经做到的：**装上之后，一个字节都不会离开这台机器**，直到你在界面上对某一条会话
> 显式开启分享或直播。

---

## 当前状态

| 项 | 状态 |
|---|---|
| 已安装到的 profile | `desktop`（`plugin_manager install_bundle`，`application: applied`） |
| 目标 DSH 版本 | `0.2.0-rc.2`（`peerDependencies` 声明 `>=0.2.0-rc.2 <0.3.0`） |
| 测试总数 | **314 项全部通过**（162 单元/集成/渲染/RPC + 125 网络 + 10 Host 加载冒烟 + 17 观众间分发） |
| 真实环境验证 | 已通过：外部独立进程在 **8ms** 内被发现、完成双向 Ed25519 握手并双向交换签名信封（见下） |
| 网络测试 | **101 项全通过**：链路质量 13 · 拓扑 8 · 虚拟互联网 23（NAT/打洞/防火墙/真实丢包）· 中继 21 · **打洞与信誉 36** |
| 中继与加密 | 公网节点可作中继；私聊**端到端加密**（X25519+AES-GCM），中继**在协议层解不开**，明文私聊被拒转 |
| 打洞 | 交换候选 + 双方同时拨号；**全锥/受限锥形可打通，对称 NAT 直接跳过**并如实标注 NAT 类型 |
| 中继选择与信誉 | 多中继按"手动指定 > 目标亲和 > 本地成功率 > 负载"打分；**他人证明压不过本地实测**（防女巫）；贡献账本不用代币 |
| 可达性自动识别 | 分层取证：本地地址分类 → 中继观察 → **入站实证（唯一判据）**。**不靠「比对公网 IP」** —— 那两件事经常不一致 |
| 观众间分发 | 直播时已收到的观众帮同房间转发。实测发布者上行 **-80%**（全员可达）／**-18%**（仅 20% 可达） |
| 未实现 | 群聊、离线消息托管、**UDP 传输层**（TCP 打洞受限于同时打开，UDP 才是稳妥解法）、IPFS/内容寻址分发、区块链存证 |

诚实边界写在 [`docs/plan-coverage.md`](docs/plan-coverage.md)：规划里的每一条要求都逐项标了
「已实现 / 部分实现 / 未实现」，没有含糊带过。

---

## 它做了什么

### 会话分享（规划 §6）
在会话页面点「分享会话」，依次选择访问范围、外发粒度、内容类型，**必须看过预览**才能发布。
发布的分享对象带：

- 唯一内容标识（`id` = 对「除 id 与 sig 之外全部字段」的内容哈希）
- Merkle 根（逐条内容哈希构成，任何一条被改动都会失配）
- 作者 Ed25519 签名
- 访问策略（范围 / 粒度 / 是否可复制 / 有效期）
- 一张 `disclosure` 说明表，明说自己包含什么、不包含什么

校验时**完整性与真实性是两个独立结论**，不合并成一个布尔值——规划 §6.4 特意写了
「内容哈希只能证明数据一致性，不能证明内容一定真实」。界面上也照这句话显示。

### 会话直播（规划 §7）
主播侧：开播 / 暂停 / 恢复 / 结束 / 发布回放。观众侧：按 `seq` 补拉、去重、检测空洞。
每条直播事件都带签名，事件类型与规划 §7.4 逐条对应
（`session_started` / `message_added` / `artifact_published` / `message_updated` /
`stream_paused` / `stream_resumed` / `session_ended`）。

两个容易被做错的地方，这里是这么处理的：

- **暂停 ≠ 结束**。暂停只停止序号推进，本地 DSH 会话继续跑；恢复不会产生第二个直播间。
- **事件序号只由主播推进**，观众的聊天走另一条通道，不污染事实序列。

### 节点与隐私（规划 §2.4、§9、§12）
- 首次启动生成 Ed25519 身份，私钥写在 `~/.dsh/dsh-chat/identity.json`（权限 `0600`），
  不上传、不记日志、不进入任何外发结构。
- **同意机制**：授权是「会话 × 内容类型 × 范围 × 有效期」四元组，默认拒绝，
  **不跨进程继承**（重启后回到未授权）。开播/分享前必须过预览，这是硬前置——
  Host 侧会拒绝没有 `previewed` 标记的请求，绕过界面直接调 RPC 也一样。
- **出站脱敏**：路径收敛、密钥形态识别、自定义关键词与正则。契约对齐官方
  `dsh-session-telemetry` 的 waterfall——**任一规则抛错就 fail-closed 扣下整条记录**，
  而不是"脱敏失败就原样发出去"。
- **一键暂停所有贡献**：撤销全部授权 + 结束所有直播间。

### 节点网络（规划 §9.3、§10）
- 传输层是**可替换的接口**（`NodeTransport`），当前实现 `LanTransport`：
  自研 RFC6455 WebSocket + UDP 信标发现 + 邀请码 + 双向 Ed25519 握手。
- 规划 §18.2 第 4 条要求「先实测再选型」，所以这里没有一上来引 libp2p/WebRTC；
  换实现时上层代码不需要改。
- 信封带版本、id（去重）、seq（补洞）、时间戳（时钟偏差窗口）与签名。

### 插件目录（规划 §4）
可验证清单 + 四维结构化评分（功能 / 易用 / 稳定 / 文档）。本地已安装插件进入目录时
一律标 `verified: false`——它们来自文件系统，**没有签名可验**。
聚合结果里明确带 `sybilResistance: 'none'`，不给用户"这个分数已经反过刷"的错觉。

---

## 安装到 DSH

已经装好了。重新安装或换 profile：

```
plugin_manager { action: "install_bundle", target: "/绝对路径/dsh-chat" }
```

不要手改 profile 的 `package.json` 或 `cordis.patch.yml`——`install_bundle` 会做这些，
手改需要额外审批。本插件的 `cordis.patch.yml` 只是它自己的加载补丁：

```yaml
- insert:
    - id: dsh-chat
      name: dsh-chat
```

### 改完代码之后要做什么

| 改了哪里 | 要做什么 |
|---|---|
| `src/client/**`（界面） | Client bundle 的 HMR 会按产物指纹自动换掉，**刷新页面**即可 |
| `src/host/**`（Host 半体） | **必须重启 DSH**。Host 插件是 Node ESM 模块，进程内只会加载一次，重新 `install_bundle` 也不会重载它 |
| `cordis.patch.yml` 里的 config | 补丁层是热重载的（约 1 秒） |

⚠️ 这条很实际：本次交付末尾修掉了一个「界面所有操作都报未知方法」的 RPC bug，
**它在重启 DSH 之前不会生效** —— 运行中的进程里还是旧代码。

### 配置

在 `cordis.patch.yml` 的条目下加 `config:` 段（默认值见 `src/host/config.js`）：

```yaml
- insert:
    - id: dsh-chat
      name: dsh-chat
      config:
        identity:
          nickname: 我的节点
        privacy:
          defaultSharingMode: disabled     # disabled | minimal | standard | full
          redaction:
            keywords: ["内部代号"]
            patterns: ["SECRET-\\d+"]
        discovery:
          enabled: true
          beaconPort: 47899
        listen:
          host: 127.0.0.1                  # 改成局域网地址才会向局域网广播
          port: 0
```

⚠️ 本版本**没有导出 `Config` schema**，所以设置页的 Plugins 面板里不会出现配置表单
（`Config.listConfigs` 显示 `status: absent`）。配置只能通过补丁下发，改完需要重启 DSH。

### 卸载

```
plugin_manager { action: "set_bundle", target: "dsh-chat", enabled: false }
```

数据目录 `~/.dsh/dsh-chat/` 不会被自动删除，需要手动清理（里面是你的身份私钥，
删之前请确认已备份）。

---

## 网络测试

"不同网络下能不能连上、数据对不对"有两层，分别有专门的测试环境：

```sh
npm run test:network    # 43 项：链路质量 13 + 拓扑 8 + 虚拟互联网 22
npm run test:virtual    # 只跑 NAT / 防火墙 / 真实丢包那 22 项
npm run lab -- serve --host 0.0.0.0 --port 47800     # 真实设备实验台（一台监听）
npm run lab -- dial 192.168.3.90:47800 --count 200    # 另一台拨号压测
npm run lab -- probe --seconds 20                     # 只做发现探测
```

- **链路质量**：两个真实节点之间夹一个 TCP 故障注入代理，测延迟、抖动、黑洞、RST、
  半关闭、带宽限制、逐字节分片、字节损坏、8 节点并发、8 轮断连重连。
- **网络拓扑**：换地址而不是换质量 —— 回环 IPv4、回环 IPv6、真实局域网网卡、
  双栈跨地址族、局域网 UDP 信标发现。
- **虚拟互联网**：用户态搭出多子网 + NAT + 防火墙，测"**谁能连谁**"——
  无映射被拒、端口映射可行、**打洞（全锥形）可行、对称 NAT 不可行**；
  外加一条自实现的可靠 UDP 链路，让**真实丢包**（20%/50%/100%）对上层可见。

完整的矩阵、实测数据、以及**仍然测不了、必须用真实设备**的场景清单，见
[`docs/network-testing.md`](docs/network-testing.md)。

中继与端到端加密的设计、隐私边界、以及"公网节点怎么知道自己真的可达"，见
[`docs/relay.md`](docs/relay.md)。

打洞、多中继选择、信誉与不使用代币的贡献记账，见
[`docs/punch-and-incentives.md`](docs/punch-and-incentives.md)。

"我怎么知道自己是公网节点"——为什么不能用比对公网 IP 的办法、以及分层取证方案，见
[`docs/reachability-detection.md`](docs/reachability-detection.md)。

> 那一节比"通过"更重要：NAT 穿透、跨运营商时延、移动网络抖动、企业防火墙、
> 纯 IPv4↔纯 IPv6 —— 这些**本次都没有验证**，并给出了各自的测试方法。

## 贡献默认值

规划 §9.2 的那句「普通用户无需为了使用好友、会话查看等基础功能而贡献存储或带宽」
是一条**底线**（贡献不能成为使用基础功能的前提），**不是"默认不贡献"**。

本项目把贡献分成两类，默认值不同：

| | 会话内分发（直播 swarm） | 对陌生人的中继 |
|---|---|---|
| 你和它的关系 | 你**已经**在看这场直播、已经收到数据 | 陌生人需要连到你 |
| 额外下载 | **零** | 零，但占上行 |
| 默认 | **开** | **auto**（实测可达 + 非计费网络 + 接电源 + 未超预算） |

```yaml
contribution:
  mode: auto                      # off | auto | on
  swarm:
    enabled: true                 # 会话内分发，默认开
    minRoomSize: 4                # 人少时发布者直发更简单
    maxServees: 4
    maxServeBytesPerMinute: 33554432
  maxCacheBytes: 536870912        # 公开内容缓存 512 MB
  onlyOnPower: true
  onlyOnUnmetered: true
  monthlyUploadBudgetBytes: 21474836480
```

**为什么不能"所有节点都贡献"**：三个理由，一个比一个硬 ——
① **技术上也做不到**：NAT 后面且无端口映射时入站必然失败，强制贡献等于让节点对外宣称一个不存在的能力，
别人的消息发进去石沉大海，**比不贡献更糟**；
② **代价落在用户身上**：默认开 = 用陌生人的移动流量和电池做好事；
③ **规划自己就反对**：§9.2 要求"一键暂停"、"仅在非计费网络时运行"、缓存档位含 0。

完整论证与实测数据见 [`docs/contribution-defaults.md`](docs/contribution-defaults.md)。

## 排查插件加载问题

插件加载失败可能是**完全静默**的：Cordis 的 `inject` 是硬依赖，只要有一个服务没就绪，
`apply()` 就永远不会被调用，不报错也不写日志。界面上只显示"无法访问 Host 半体"。

所以 `apply()` 会把启动结论写到数据目录的 `boot.json`：

```sh
cat ~/.dsh/dsh-chat/boot.json
```

| phase | 含义 |
|---|---|
| `apply-called` | `apply` 已进入。**只有这一条** → 后续步骤中途失败 |
| `rpc-mounted` | RPC 路由挂上了（客户端能通信的前提） |
| `apply-completed` | 全部执行完毕 |
| `rpc-mount-failed` | 路由挂载失败，附原因 |

排查顺序：直接跑 `npm run doctor`，它会逐段检查并给出结论。

**注意**：Host 半体的代码改动**必须重启 DSH** 才能生效 ——
DSH 用同一个 URL 导入 `lib/index.js`，Node 会缓存该模块，所以"禁用再启用插件"
只会重新执行**旧代码**。改完 Host 代码后请重启，否则你验证的仍是上一版。

`boot.json` 的最后一条 phase 就是结论：

| phase | 含义 |
|---|---|
| `apply-called` | 进入了但没走完 —— 后续步骤失败（早先的事故就停在这一步） |
| `config-ok` | 配置校验通过 |
| `modules-ready` | 数据层与网络层构造完成 |
| `rpc-mounted` | 路由已挂上（客户端能通信） |
| `apply-completed` | 全部完成 |
| `apply-failed` | 失败，并附 message 与堆栈 |

> 教训写在 `inject` 的注释里：**不要为惰性使用的东西声明硬依赖。**
> 早期把 `sessionQuery` / `sessions` 也列进了 `inject`，而它们只在少数 RPC 处理函数里用到 ——
> 一旦取不到，整个插件就静静地不加载。

## 开发

```sh
npm install
npm run build     # esbuild → lib/index.js（Host，ESM）+ lib/client.js（Client，CJS 包进 __ModuleLoader__）
npm test          # 314 项测试
npm run check     # 构建 + 测试
```

### 真实环境连通性验证

装好并重启 DSH 后：

```sh
node scripts/verify-live-node.mjs
```

它会以一个**完全独立的进程**扮演另一个用户节点，在 9ms 内被运行中的插件发现、
完成双向 Ed25519 握手，并双向交换签名信封。实测输出见
[`docs/verification.md`](docs/verification.md)。

测试里还有一组**渲染冒烟测试**（`test/client-render.test.js`）：在没有浏览器的环境下，
用 react-test-renderer 把真实的客户端组件渲染出来，覆盖六个视图与三个对话框。
它抓到了两个"一到浏览器就白屏"的崩溃 bug（详见验证报告的缺陷清单）。

---

## 代码结构

```
src/shared/       Host 与 Client 共享的纯 JS：稳定序列化、协议词汇表
src/host/
  identity.js     Ed25519 身份、指纹、签名验签、内容哈希
  consent.js      授权门（fail-closed，不跨进程继承）
  redaction.js    出站脱敏 waterfall（对齐官方 sessionTelemetry/record）
  capture.js      DSH 适配层：session/event + agent/assistant-stream，非阻塞入队
  share.js        分享对象：Merkle 根、签名、校验、导入、撤销
  live.js         直播引擎：有序事件、去重、补洞、暂停/恢复、观众镜像
  peers.js        好友申请 / 关注 / 拉黑（三种未完成状态分开建模）
  directory.js    可验证插件清单 + 四维评分聚合
  rpc.js          RPC（继承 DSH 浏览器认证）+ SSE（进程内 token 门禁）
  net/
    ws.js         自研 RFC6455（含分片、ping/pong、Close 帧回执）
    envelope.js   签名信封、去重、重放与时钟偏差防护
    transport.js  NodeTransport 接口 + 内存传输（测试用）
    lan.js        局域网传输：UDP 信标发现、邀请码、双向握手
  index.js        装配与接线
src/client/
  index.js        Client 入口：main 面板、侧栏图标、会话页入口、直播状态条
  app.js          主面板外壳（左侧导航 + 内容区）
  views/          发现 / 好友 / 消息 / 收藏 / 节点 / 我的
  share-dialog.js 分享对话框（含硬前置的预览）
  live-room.js    直播间 + 开播对话框
  kit.js          自研控件（只用 --dsw-alias-* 主题变量）
  rpc.js          与 Host 的两条通道
test/             单元 / 集成 / 渲染 / RPC 测试
test/host-boot.test.js   插件的 apply() 冒烟测试（真的跑一遍加载与挂载）
test/network/     网络测试环境：故障注入代理 + 拓扑矩阵 + 虚拟互联网（NAT/防火墙/真实丢包）
docs/             架构、规划覆盖对照、验证报告、前期调研
```

## 已知限制（不要当成已经实现的）

- **打洞受限于 TCP**。交换候选与同时拨号已实现，但 TCP 打洞依赖"同时打开"，
  很多 NAT 和系统不支持。真正稳妥的解法是把传输层换成 UDP（WebRTC/QUIC），那是传输层改造。
- **中继能看到元数据**（谁和谁通信、大小、时间），也可以拒绝服务。
  正文是端到端加密的，它解不开 —— 但元数据这条限制没有被消除，也不应假装被消除。
- **贡献设置大多只是声明值**。`maxUploadBps` / `maxDownloadBps` / `onlyOnPower` / `autoStopMinutes`
  目前不生效，界面上把它们和真正生效的项分开列出来，不假装已实现。
- **没有中心目录**。发现页只显示本机已知节点广播过的内容；规划 §8.5 明确要求
  不要把本地计算结果包装成全网权威排名。
- **回放会被环形裁剪**，并在快照里如实报告裁掉了多少条。

## 许可

MIT。规划文档 §18.3 里提到的 `dsh-chat` 名称与包名冲突问题尚未核实，正式发布前需要确认。
