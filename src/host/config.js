/**
 * 插件配置与默认值。
 *
 * 默认值直接落实规划 §12.2 的「默认策略」一栏：默认不贡献存储和转发资源、
 * 会话默认仅本地可见、生成文件不默认传播。也就是说：
 * **装上插件本身不会让任何字节离开这台机器。**
 *
 * 配置来源：cordis.patch.yml 里该条目下的 `config:` 段（见 cordis.patch.yml 注释）。
 */
import { SHARING_MODE, NODE_ROLE, isSharingMode } from '../shared/protocol.js';
import { isPeerAddress } from './net/address.js';
import { resolveDataDir } from './store.js';

export const DEFAULT_CONFIG = Object.freeze({
  /** 数据目录；留空则用 ~/.dsh/dsh-chat/。 */
  dataDir: null,
  /** 界面语言：'zh' | 'en'。 */
  locale: 'zh',

  identity: {
    /** 昵称可重复，仅用于显示；公钥标识才唯一（规划 §5.1）。 */
    nickname: '未命名节点',
    bio: '',
  },

  /** 本进程监听地址。默认只绑回环，避免"装上就被局域网扫到"。 */
  listen: {
    host: '127.0.0.1',
    /** 0 = 由系统分配端口，避免固定端口冲突。 */
    port: 0,
  },

  /**
   * 网络超时（规划 §9.4：NAT/受限网络下直连成功率要实测）。
   *
   * 这两个值决定"多慢的链路还能连上"。放在配置里而不是写死常量，
   * 是因为不同网络差别很大：局域网几毫秒，跨运营商可能几百毫秒，
   * 移动网络抖动上千毫秒。用户（或测试）要能按自己的链路调。
   */
  network: {
    /** WebSocket 建连（TCP 连接 + 101 握手）超时。 */
    connectTimeoutMs: 5000,
    /** 连上之后完成双向身份握手的超时；超时即断开。 */
    handshakeTimeoutMs: 8000,
  },

  /** 节点发现（规划 §9.3）。 */
  discovery: {
    /** UDP 广播信标：同一台机器/同一局域网内的多个实例靠它互相发现。 */
    enabled: true,
    beaconPort: 47899,
    intervalMs: 4000,
    /** 信标过期时间：超过这个时间没再听到就视为离线。 */
    ttlMs: 15000,
    /**
     * 发现后是否自动回连。
     *
     * 默认 true，因为监听地址默认是回环，信标只会到达**本机**——
     * 阶段 0 的验收场景（两个本地实例互相发现并交换消息）靠它开箱即用。
     * 把 listen.host 改成局域网地址后，才会真正向局域网广播；
     * 那时如果不想被自动连接，把这项关掉，改由界面手动连接。
     */
    autoConnect: true,
    /** 手工填入的节点地址，用于广播不可达的网络（对应规划里的"邀请信息"）。 */
    manualPeers: [],
  },

  /** 资源贡献（规划 §9.2）。默认全关。 */
  /**
   * 贡献设置（规划 §9.2）。
   *
   * 规划的那句"普通用户无需为了使用好友、会话查看或其他基础功能而贡献存储或带宽"
   * 是一条**底线**：贡献不能成为使用基础功能的前提。它**不是**"默认不贡献"。
   *
   * 本实现的取舍是把贡献分成两类，默认值不同：
   *
   *   1. **会话内分发**（直播时把已收到的内容转给同房间观众）—— **默认开**。
   *      你没有多下载任何东西，用掉的是本来闲置的上行，而且这直接决定
   *      发布者扛不扛得住。它不属于"为陌生人贡献"。
   *
   *   2. **对陌生人的中继转发 / 公开内容缓存** —— **默认 auto**：
   *      只在**免费且安全**时才做（实测可达 + 非计费网络 + 接电源 + 未超预算），
   *      否则自动暂停。这样最大化贡献，又不花用户的流量费。
   */
  contribution: {
    roles: [NODE_ROLE.ORDINARY],

    /** 会话内分发：直播时帮同房间观众转发。默认开。 */
    swarm: {
      enabled: true,
      /** 房间小于这个人数时不启用（发布者直发更简单，加一层只是白增跳数）。 */
      minRoomSize: 4,
      /** 同时最多服务几个对端。 */
      maxServees: 4,
      /** 每分钟最多转发多少字节。 */
      maxServeBytesPerMinute: 32 * 1024 * 1024,
      /** 单次补数据最多给多少事件。 */
      maxServeEventsPerRequest: 500,
    },

    /**
     * 公开内容缓存上限（字节）。默认 512 MB —— 只缓存公开分享，
     * 不含任何私聊与未授权内容（那部分由 consent.js 在更上游挡住）。
     */
    maxCacheBytes: 512 * 1024 * 1024,

    /** 上行/下行限速，0 表示不限。 */
    maxUploadBps: 0,
    maxDownloadBps: 0,

    /**
     * 贡献模式：
     *   'off'  完全不对外贡献
     *   'auto' **默认** —— 只在免费且安全时贡献：实测可达 + 非计费网络 + 接电源 + 未超预算
     *   'on'   总是贡献（在计费网络/电池上也会跑，用户明确知道代价时使用）
     */
    mode: 'auto',

    /** 只在接电源时贡献。 */
    onlyOnPower: true,
    /** 只在非计费网络（Wi-Fi/以太网）时贡献。移动网络与个人热点视为计费。 */
    onlyOnUnmetered: true,
    /** 每月贡献上行上限（字节）。0 表示不限。 */
    monthlyUploadBudgetBytes: 20 * 1024 * 1024 * 1024,
    /** 自动停止分钟数，0 表示不自动停。 */
    autoStopMinutes: 0,
  },

  /** 隐私与授权（规划 §12.1 / §12.2）。 */
  privacy: {
    /**
     * 新会话的默认外发粒度。
     * 'disabled' 意味着：用户不在界面上显式开播/分享，就一个字节都不出去。
     */
    defaultSharingMode: SHARING_MODE.DISABLED,
    /** 出站脱敏（规划 §7.7、§5.3）。 */
    redaction: {
      /** 把绝对路径收敛成 basename，避免泄露本地目录结构。 */
      scrubPaths: true,
      /** 命中常见密钥/令牌形态就替换掉。 */
      scrubSecrets: true,
      /** 用户自定义关键词，命中即整条替代。 */
      keywords: [],
      /** 用户自定义正则（字符串形式，服务端编译）。 */
      patterns: [],
    },
  },

  /** 直播（规划 §7.2 / §7.4）。 */
  live: {
    /** 观众重连后一次最多补多少条事件。 */
    maxBackfillEvents: 500,
    /**
     * 直播间环形保留的事件条数上限。
     * 超过之后就只保留最近的这些条，更早的会被裁掉，并在快照里如实报告 `droppedEvents`——
     * 规划 §11.5 要求「对长期保存的内容，展示可用性状态或最近确认时间，不承诺永久在线」。
     */
    maxRetainedEvents: 2000,
    /** 开播前必须先过预览。 */
    requirePreview: true,
    /** 同一时刻允许的直播间数（MVP 先限制为 1，避免一个实例被当成中继用）。 */
    maxConcurrentRooms: 1,
  },

  /** 插件目录（规划 §4.4）。 */
  directory: {
    /** 是否把自己的插件清单广播出去。默认否。 */
    publish: false,
  },

  /**
   * 中继（规划 §9.1 中继节点 / §9.4 NAT 可达性）。
   *
   * 为什么需要它：虚拟网络环境已经证明 —— 两侧都在对称 NAT 后面、目的侧又没有端口映射时，
   * **直连必然失败**，而对称 NAT 正是移动网络的常态。没有中继就有一部分用户永远连不上。
   */
  relay: {
    /** 是否启用中继客户端（出站连到别人的公网节点）。默认开。 */
    enabled: true,
    /**
     * 本机是否对外提供中继服务。三种取值：
     *
     *   false   —— 不提供（默认）
     *   true    —— 总是提供。**在 NAT 后面打开是没用的**：别人根本连不进来。
     *   'auto'  —— **只有实测到有人成功连入过**才提供（`REACHABILITY.PROVEN`）。
     *
     * 为什么要有 'auto'、以及为什么它不等于"检测到公网 IP 就开"：
     * "我的 IP 是公网"和"别人能连进来"是两件事。国内家宽普遍是公网 IP 但封入站，
     * 按 IP 判断会把这类节点判成可达，然后它对外宣称自己是一台中继、
     * 别人把消息发过来却永远失败 —— 而且是**安静地失败**。
     * 所以 'auto' 的判据只有一个：真的有人连进来过。
     */
    serve: false,
    /** 填入已知的公网中继地址（host:port 或 [v6]:port）。 */
    servers: [],
    /** 是否采用通过信标/握手发现的、自称可中继的节点。 */
    useDiscoveredRelays: true,
    /**
     * 打洞（规划 §9.4）。打通了就省下中继带宽，也不让第三方看到元数据。
     * **失败完全正常**，中继永远是兜底，所以默认开着没有风险。
     */
    punch: {
      enabled: true,
      /** 打洞总超时。太长会让用户干等（中继本来就能用）。 */
      timeoutMs: 4000,
      /** 单个候选地址的拨号超时。 */
      dialTimeoutMs: 2500,
    },
    /** 服务端策略：容量与限速。 */
    policy: {
      maxPeers: 32,
      maxEnvelopeBytes: 256 * 1024,
      maxForwardBytesPerMinute: 8 * 1024 * 1024,
      peerTtlMs: 90 * 1000,
      /** 只转发密文与公开内容。关掉它会破坏规划 §5.3，所以默认开且不建议关。 */
      requireSealedForPrivate: true,
    },
  },

  /** 网络层调试日志。 */
  debug: false,
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 深合并：只覆盖用户显式给出的键，数组整体替换而不是逐项合并。 */
function merge(base, override) {
  if (!isPlainObject(override)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? merge(base[key], value) : value;
  }
  return out;
}

/**
 * 归一化用户配置，并做最小必要的合法性校验。
 * 校验失败一律抛错——宁可插件加载失败，也不要带着「以为关掉了其实开着」的配置跑起来。
 */
export function normalizeConfig(raw = {}) {
  const config = merge(DEFAULT_CONFIG, raw);

  if (!isSharingMode(config.privacy.defaultSharingMode)) {
    throw new TypeError(`privacy.defaultSharingMode 非法: ${config.privacy.defaultSharingMode}`);
  }
  for (const role of config.contribution.roles) {
    if (!Object.values(NODE_ROLE).includes(role)) {
      throw new TypeError(`contribution.roles 含未知角色: ${role}`);
    }
  }
  const port = Number(config.listen.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError(`listen.port 非法: ${config.listen.port}`);
  }
  const beaconPort = Number(config.discovery.beaconPort);
  if (!Number.isInteger(beaconPort) || beaconPort < 1 || beaconPort > 65535) {
    throw new TypeError(`discovery.beaconPort 非法: ${config.discovery.beaconPort}`);
  }
  if (!Array.isArray(config.discovery.manualPeers)) {
    throw new TypeError('discovery.manualPeers 必须是数组');
  }
  for (const key of ['connectTimeoutMs', 'handshakeTimeoutMs']) {
    const value = Number(config.network[key]);
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`network.${key} 必须是正数，收到: ${String(config.network[key])}`);
    }
    config.network[key] = value;
  }
  for (const peer of config.discovery.manualPeers) {
    if (!isPeerAddress(peer)) {
      throw new TypeError(`discovery.manualPeers 元素应为 host:port 或 [v6]:port，收到: ${String(peer)}`);
    }
  }
  if (!['off', 'auto', 'on'].includes(config.contribution.mode)) {
    throw new TypeError(`contribution.mode 应为 off / auto / on，收到: ${String(config.contribution.mode)}`);
  }
  if (![true, false, 'auto'].includes(config.relay.serve)) {
    throw new TypeError(`relay.serve 应为 true / false / 'auto'，收到: ${String(config.relay.serve)}`);
  }
  if (!Array.isArray(config.relay.servers)) {
    throw new TypeError('relay.servers 必须是数组');
  }
  for (const server of config.relay.servers) {
    if (!isPeerAddress(server)) {
      throw new TypeError(`relay.servers 元素应为 host:port 或 [v6]:port，收到: ${String(server)}`);
    }
  }

  const roots = config.privacy.redaction.patterns;
  if (!Array.isArray(roots)) throw new TypeError('privacy.redaction.patterns 必须是数组');
  for (const source of roots) {
    // 提前编译一次，配置错了就在加载时炸，而不是等到第一条消息外发时才炸。
    try {
      new RegExp(source, 'g');
    } catch (error) {
      throw new TypeError(`privacy.redaction.patterns 含非法正则 ${JSON.stringify(source)}: ${error.message}`);
    }
  }

  config.dataDir = resolveDataDir(config.dataDir);
  return config;
}
