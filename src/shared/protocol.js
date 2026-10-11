/**
 * dsh-chat 线上协议词汇表（Host 与 Client 共享的纯 JS 常量与校验）。
 *
 * 这份文件是产品规划文档第 14 节「核心数据模型」与第 10 节「P2P 网络与数据流」
 * 的可执行版本：凡是两个节点之间、或 Host 与 Client 之间要交换的东西，
 * 其字段名与取值都在这里定义一次，避免两边各写一份而漂移。
 *
 * 设计约束（来自规划文档）：
 *   - 1.3 不把所有内容上链：这里没有任何链上字段，签名 + 内容哈希是基础，
 *         区块链只作为「可选验证层」，不在这条主链路上。
 *   - 2.4 隐私优先：所有可能外发的内容对象都必须带 `policy`（谁能看）与
 *         `authorization`（用户是否显式授权过），没有这两项的东西不允许出网。
 *   - 10.4 不能假设一次发送必然到达：信封必须带 `id`（去重）与 `seq`（补洞）。
 */

/** 协议版本。改变信封或数据对象语义时必须递增，接收方据此拒绝不认识的版本。 */
export const PROTOCOL_VERSION = 1;

/** 网络信封类型（节点 ↔ 节点）。 */
export const MESSAGE_KIND = Object.freeze({
  /** 连接建立后的身份交换，带挑战 nonce 的签名，用来证明「我持有这个私钥」。 */
  HELLO: 'hello',
  HELLO_ACK: 'hello-ack',
  /** 心跳 / 在线状态，也用于刷新 lastSeen。 */
  PRESENCE: 'presence',
  /** 好友申请、接受、拒绝、删除、拉黑（规划 §5.2）。 */
  FRIEND_REQUEST: 'friend-request',
  FRIEND_RESPONSE: 'friend-response',
  /** 一对一私聊（规划 §5.3）。载荷在 MVP 中为明文的本地回环场景保留 crypto 字段位。 */
  DIRECT_MESSAGE: 'direct-message',
  /** 公开分享对象的目录公告：只含标识与摘要，不含正文（规划 §10.3）。 */
  SHARE_ANNOUNCE: 'share-announce',
  /** 按内容标识索取公开内容对象。 */
  SHARE_REQUEST: 'share-request',
  SHARE_PAYLOAD: 'share-payload',
  /** 直播事件与状态请求（规划 §7.4）。 */
  LIVE_EVENT: 'live-event',
  LIVE_STATE_REQUEST: 'live-state-request',
  LIVE_STATE: 'live-state',
  /** 插件清单与评分（规划 §4.4 / §4.3）。 */
  PLUGIN_MANIFEST: 'plugin-manifest',
  PLUGIN_RATING: 'plugin-rating',
  /** 逐条确认，缺它才重发。 */
  ACK: 'ack',

  // ── 中继（规划 §9.1 中继节点 / §9.4 NAT 可达性）──────────────────────
  // 两台都在 NAT 后面、又都不肯直连的节点，各自向一台公网节点建立**出站**连接，
  // 由那台公网节点在中间转发。出站永远能建立，所以这条路在对称 NAT 下也成立。
  /** 我在这里，请把我登记为可被转发的对象。 */
  RELAY_REGISTER: 'relay-register',
  /** 登记结果（含中继的容量与策略，便于客户端选择）。 */
  RELAY_REGISTERED: 'relay-registered',
  /** 转发一个信封给某个身份。 */
  RELAY_FORWARD: 'relay-forward',
  /** 目标不在线/未登记。 */
  RELAY_UNREACHABLE: 'relay-unreachable',
  /** 中继的负载公告（供选择时参考）。 */
  RELAY_LOAD: 'relay-load',
  /** 查询某个身份的自签名文档（中继只能转交，不能伪造）。 */
  RELAY_LOOKUP: 'relay-lookup',
  /** 查询结果。 */
  RELAY_DOCUMENT: 'relay-document',

  // ── 打洞（规划 §9.4）──────────────────────────────────────────────
  // 打洞不改变可达性，它只是**省钱**：打通了就用两台机器的直连带宽，
  // 不占中继带宽，也不让第三方看到元数据。
  /** STUN 那一步：问中继「你看到的我的公网端点是什么」。 */
  PUNCH_PROBE: 'punch-probe',
  /** 中继回答观察到的端点（这就是 NAT 给你的公网 ip:port）。 */
  PUNCH_ENDPOINT: 'punch-endpoint',
  /** 经中继交换候选端点（信令必须走一条双方都能到达的通道）。 */
  PUNCH_OFFER: 'punch-offer',
  /** 中继转交的对方候选。 */
  PUNCH_CANDIDATE: 'punch-candidate',
  /** 打洞结果回报，供双方与中继更新统计。 */
  PUNCH_RESULT: 'punch-result',

  // ── 观众间分发（规划 §5.4 直播）────────────────────────────────────
  // 直播时如果所有观众都从发布者拉，发布者的上行必然成为瓶颈。
  // 已经收到的观众帮助转发下去，是这条链路能不能撑住的关键。
  /** 我手上有到第几号事件（可用性广播）。 */
  LIVE_HAVE: 'live-have',
  /** 请求补数据。 */
  LIVE_FETCH: 'live-fetch',
  /** 补数据应答（或带原因的拒绝）。 */
  LIVE_FETCH_RESULT: 'live-fetch-result',

  /** 对某台中继的签名评价（他人证明只作参考，永远压不过本地实测）。 */
  RELAY_ATTESTATION: 'relay-attestation',

  // ── 可达性实证（规划 §9.1 中继节点）────────────────────────────────
  // 「我是不是公网可达」这个问题**只有一个可信的答案来源**：
  // 让第三方真的连回来一次。任何 IP 比对都替代不了它。
  /** 请中继主动连回某个地址，回报结果。 */
  REACH_PROBE: 'reach-probe',
  /** 中继的实证结果。 */
  REACH_RESULT: 'reach-result',
});

/** 中继自身承载的信封类型（不参与内容转发判断）。 */
export const RELAY_CONTROL_KINDS = Object.freeze([
  'relay-register', 'relay-registered', 'relay-forward', 'relay-unreachable',
  'relay-load', 'relay-lookup', 'relay-document',
  'punch-probe', 'punch-endpoint', 'punch-offer', 'punch-candidate', 'punch-result',
  'relay-attestation', 'reach-probe', 'reach-result',
  'live-have', 'live-fetch', 'live-fetch-result',
]);

/**
 * 允许中继转发的「公开」信封类型。
 *
 * 除此之外的一切（尤其是私聊）**必须是密文**，否则中继拒绝转发。
 * 这不是策略建议，是中继里的硬判断 —— 见 relay.js 的 classifyForward。
 */
export const RELAY_PUBLIC_KINDS = Object.freeze([
  // 在线状态本身不含内容
  'presence',
  // 公开直播事件（其内容早已按授权与脱敏过滤过）
  'live-event',
  // 公开分享目录公告
  'share-announce',
  // 可验证的插件清单与评分（本来就设计成公开的）
  'plugin-manifest',
  'plugin-rating',
  // 中继自身的负载公告
  'relay-load',
]);

export const MESSAGE_KINDS = Object.freeze(Object.values(MESSAGE_KIND));

/** 分享访问范围（规划 §6.2）。顺序即「从最严到最松」，界面上直接照此展示。 */
export const ACCESS_SCOPE = Object.freeze({
  /** 仅自己：只在本机存在，不进任何网络路径。 */
  SELF: 'self',
  /** 指定好友：按明确身份列表授权，内容是加密后点对点送达。 */
  FRIENDS: 'friends',
  /** 指定群聊或成员。 */
  GROUP: 'group',
  /** 持有分享凭证的人：可访问，但默认不进公开发现目录。 */
  LINK: 'link',
  /** 公开发布：可被其它节点缓存，可出现在发现广场。 */
  PUBLIC: 'public',
});

export const ACCESS_SCOPES = Object.freeze(Object.values(ACCESS_SCOPE));

/** 需要加密、且绝不允许进入公开目录的范围。 */
export const PRIVATE_SCOPES = Object.freeze([ACCESS_SCOPE.SELF, ACCESS_SCOPE.FRIENDS, ACCESS_SCOPE.GROUP]);

/** 可逐项选择是否分享的内容类型（规划 §6.3）。 */
export const CONTENT_KIND = Object.freeze({
  /** 用户自己的提问与输入。 */
  PROMPT: 'prompt',
  /** AI 生成的回答文本。 */
  ANSWER: 'answer',
  /** AI 的思考过程——默认不分享，需用户单独勾选。 */
  REASONING: 'reasoning',
  /** 代码、图片、文档等生成内容。 */
  ARTIFACT: 'artifact',
  /** 选定的工具调用与执行结果——默认不分享。 */
  TOOL: 'tool',
  /** 选定的附件。 */
  ATTACHMENT: 'attachment',
});

export const CONTENT_KINDS = Object.freeze(Object.values(CONTENT_KIND));

/**
 * 默认分享内容集合。
 * 规划 §6.3 明令：「不得默认公开完整对话、整个本地工作区、密钥、私人附件或所有工具执行结果」，
 * 因此默认只勾选提问与回答，其余一律由用户显式打开。
 */
export const DEFAULT_CONTENT_SELECTION = Object.freeze({
  [CONTENT_KIND.PROMPT]: true,
  [CONTENT_KIND.ANSWER]: true,
  [CONTENT_KIND.REASONING]: false,
  [CONTENT_KIND.ARTIFACT]: true,
  [CONTENT_KIND.TOOL]: false,
  [CONTENT_KIND.ATTACHMENT]: false,
});

/** 直播事件类型（规划 §7.4，逐条对应）。 */
export const LIVE_EVENT = Object.freeze({
  SESSION_STARTED: 'session_started',
  MESSAGE_ADDED: 'message_added',
  ARTIFACT_PUBLISHED: 'artifact_published',
  MESSAGE_UPDATED: 'message_updated',
  STREAM_PAUSED: 'stream_paused',
  /** 规划正文只列了暂停；恢复是暂停的必然配对，单列出来以免用 session_started 冒充。 */
  STREAM_RESUMED: 'stream_resumed',
  SESSION_ENDED: 'session_ended',
});

export const LIVE_EVENTS = Object.freeze(Object.values(LIVE_EVENT));

/** 直播间状态（规划 §14「直播间状态」：状态需要超时与过期处理）。 */
export const LIVE_STATUS = Object.freeze({
  PREPARING: 'preparing',
  LIVE: 'live',
  PAUSED: 'paused',
  ENDED: 'ended',
});

/** 外发披露模式。刻意与官方 sessionTelemetry 的 full / feedback-only / disabled 对齐。 */
export const SHARING_MODE = Object.freeze({
  /** 完整：按用户允许的粒度外发。 */
  FULL: 'full',
  /** 标准：只外发提问与回答，不含工具与思考。 */
  STANDARD: 'standard',
  /** 精简：只外发回答文本。 */
  MINIMAL: 'minimal',
  /** 关闭：什么都不外发。 */
  DISABLED: 'disabled',
});

export const SHARING_MODES = Object.freeze(Object.values(SHARING_MODE));

/** 官方 sharing 词 → dsh-chat 粒度的等价映射，便于和 sessionTelemetry 对齐语义。 */
export const OFFICIAL_SHARING_EQUIVALENT = Object.freeze({
  full: SHARING_MODE.FULL,
  'feedback-only': SHARING_MODE.STANDARD,
  disabled: SHARING_MODE.DISABLED,
});

/** 每种外发粒度允许出现的内容类型。 */
export const SHARING_MODE_CONTENT = Object.freeze({
  [SHARING_MODE.FULL]: Object.freeze([
    CONTENT_KIND.PROMPT,
    CONTENT_KIND.ANSWER,
    CONTENT_KIND.ARTIFACT,
    CONTENT_KIND.TOOL,
  ]),
  [SHARING_MODE.STANDARD]: Object.freeze([CONTENT_KIND.PROMPT, CONTENT_KIND.ANSWER]),
  [SHARING_MODE.MINIMAL]: Object.freeze([CONTENT_KIND.ANSWER]),
  [SHARING_MODE.DISABLED]: Object.freeze([]),
});

/** 插件评分的结构化维度（规划 §4.3：功能实用性、易用性、稳定性和文档质量）。 */
export const RATING_DIMENSIONS = Object.freeze(['usefulness', 'usability', 'stability', 'documentation']);

/** 节点角色（规划 §9.1）。默认只开普通节点，其余一律用户主动打开。 */
export const NODE_ROLE = Object.freeze({
  ORDINARY: 'ordinary',
  STORAGE: 'storage',
  FORWARDER: 'forwarder',
  RELAY: 'relay',
  BOOTSTRAP: 'bootstrap',
});

export const NODE_ROLES = Object.freeze(Object.values(NODE_ROLE));

/** 内容寻址标识前缀。b3 = 内容对象，sha256 十六进制。 */
export const CONTENT_ID_PREFIX = 'b3';
/** 身份标识前缀。 */
export const IDENTITY_PREFIX = 'ed25519';

const FINGERPRINT_RE = /^[0-9a-f]{8}(-[0-9a-f]{8}){3}$/;
const CONTENT_ID_RE = /^b3:[0-9a-f]{64}$/;
const PUBLIC_KEY_RE = /^ed25519:[A-Za-z0-9_-]{43}$/;

export function isFingerprint(value) {
  return typeof value === 'string' && FINGERPRINT_RE.test(value);
}

export function isContentId(value) {
  return typeof value === 'string' && CONTENT_ID_RE.test(value);
}

export function isPublicKeyId(value) {
  return typeof value === 'string' && PUBLIC_KEY_RE.test(value);
}

export function isAccessScope(value) {
  return ACCESS_SCOPES.includes(value);
}

export function isSharingMode(value) {
  return SHARING_MODES.includes(value);
}

export function isLiveEventType(value) {
  return LIVE_EVENTS.includes(value);
}

export function isPrivateScope(scope) {
  return PRIVATE_SCOPES.includes(scope);
}

/** 把 16 进制指纹切成 4 组 8 位，便于人眼比对（规划 §5.1：公钥标识应当唯一）。 */
export function formatFingerprint(hex) {
  const clean = String(hex ?? '').replace(/[^0-9a-f]/gi, '').toLowerCase();
  return (clean.match(/.{1,8}/g) ?? []).slice(0, 4).join('-');
}

/** 生成一个短的可读标识，用作事件 id / 请求 id。 */
export function shortId(bytes = 8) {
  const buf = new Uint8Array(bytes);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(buf);
  else for (let i = 0; i < bytes; i += 1) buf[i] = Math.floor(Math.random() * 256);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 生成带前缀的随机 id。 */
export function randomId(prefix) {
  return `${prefix}_${shortId(12)}`;
}
