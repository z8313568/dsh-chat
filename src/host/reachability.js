/**
 * 可达性判定（规划 §9.1 中继节点 / §9.2 贡献设置）。
 *
 * ## 先纠正一个常见的错误做法
 *
 * 最直觉的方案是"启动时从 ip.cn 之类取公网 IP，跟本机 IP 比，一样就认为是公网"。
 * **这个方案不能用**，因为它回答的不是真正要问的问题：
 *
 *   我们真正要知道的是「**别人能不能主动连进来**」，
 *   而不是「我的 IP 看起来是不是公网地址」。这两件事差得很远：
 *
 *   | 情形 | IP 比对会怎么说 | 实际能不能被连入 |
 *   |---|---|---|
 *   | 公网 IP，但运营商封了入站（国内家宽的常态） | "公网" ✗ | **不能** |
 *   | 公网 IP + DMZ / 端口映射 | "不是公网" ✗ | **能** |
 *   | CGNAT，多人共享一个公网 IP | 常常误判成"公网" ✗ | **不能** |
 *   | 主机直接在公网网段上 | "公网" ✓ | 能 |
 *
 * 最危险的组合是第一行：判定为公网 → 自动开启中继 → **对外宣称自己是一台中继，
 * 而实际上谁也连不上**。别人会把消息发过来，然后一直失败。
 *
 * 另外，每次启动都去请求一个第三方商业网站，对一个隐私工具来说是**反向**的：
 * 它泄露你的 IP、启动时间与使用规律，还引入了一个可以被篡改的答案
 * （把"不可达"说成"可达"），以及一个"对方挂了就启动变慢"的依赖。
 *
 * ## 本模块的做法：分层取证，从"能确定"到"能证明"
 *
 *   L1 **本地地址分类**（离线、瞬时、免费）
 *      可靠的是**否定结论**：只有私网/CGNAT 地址 → 一定不能直接被连入。
 *      肯定结论不可靠（可能被运营商封入站），只能作为"值得进一步确认"。
 *
 *   L2 **中继观察到的来源地址**（用已有的中继，零额外泄露）
 *      你在中继看来是什么地址？同一个地址出现在不同中继上 → 全锥形；
 *      地址不在你的本地网卡列表里 → 你在 NAT 后面。
 *      这正是打洞用的那次 STUN 探测，**不需要任何新的外部服务**。
 *
 *   L3 **入站实证**（唯一的真凭实据）
 *      让一台中继**真的连回来**。握手成功且对端身份正确 → 你是可达的。
 *      这是唯一能回答"别人能不能连进来"的测试，任何 IP 比对都替代不了它。
 *
 * L3 才是判据。L1/L2 只用来决定"值不值得做 L3"，以及给用户一个解释。
 */

import { networkInterfaces } from 'node:os';

/** 地址分类。 */
export const ADDRESS_CLASS = Object.freeze({
  LOOPBACK: 'loopback',
  LINK_LOCAL: 'link-local',
  /** RFC1918 / ULA 等私有地址。 */
  PRIVATE: 'private',
  /** RFC6598 运营商级 NAT（100.64.0.0/10）—— 共享公网 IP，**入站必然不通**。 */
  CGNAT: 'cgnat',
  /** 本机既不是公网也不是私网（比如 0.0.0.0）。 */
  UNSPECIFIED: 'unspecified',
  /** 全球可路由。 */
  PUBLIC: 'public',
});

/**
 * 判断单个地址属于哪一类。
 *
 * 只看地址本身，不联网、不看配置 —— 所以它永远不会"因为网络故障而猜错"。
 */
export function classifyAddress(input) {
  if (typeof input !== 'string' || input.length === 0) return ADDRESS_CLASS.UNSPECIFIED;
  const address = input.replace(/^\[|\]$/g, '').split('%')[0].trim();

  if (address === '::1' || address.startsWith('127.')) return ADDRESS_CLASS.LOOPBACK;

  const family = address.includes(':') ? 6 : 4;

  if (family === 4) {
    const parts = address.split('.');
    if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
      return ADDRESS_CLASS.UNSPECIFIED;
    }
    const [a, b] = parts.map(Number);
    if (a === 0) return ADDRESS_CLASS.UNSPECIFIED;
    if (a === 10) return ADDRESS_CLASS.PRIVATE;
    if (a === 172 && b >= 16 && b <= 31) return ADDRESS_CLASS.PRIVATE;
    if (a === 192 && b === 168) return ADDRESS_CLASS.PRIVATE;
    if (a === 169 && b === 254) return ADDRESS_CLASS.LINK_LOCAL;
    // RFC6598：运营商级 NAT。这一段**不是**私网，但外面还有一层 NAT。
    if (a === 100 && b >= 64 && b <= 127) return ADDRESS_CLASS.CGNAT;
    // 保留段：永远不可能被公网连入
    if (a >= 224) return ADDRESS_CLASS.UNSPECIFIED;
    if (a === 192 && b === 0) return ADDRESS_CLASS.UNSPECIFIED;
    if (a === 198 && (b === 18 || b === 19)) return ADDRESS_CLASS.UNSPECIFIED;
    return ADDRESS_CLASS.PUBLIC;
  }

  const lower = address.toLowerCase();
  if (lower.startsWith('fe80')) return ADDRESS_CLASS.LINK_LOCAL;
  // fc00::/7 唯一本地地址
  if (/^f[cd]/.test(lower)) return ADDRESS_CLASS.PRIVATE;
  // 2001:db8::/32 文档用、2001:0::/32 Teredo
  if (lower.startsWith('2001:db8')) return ADDRESS_CLASS.UNSPECIFIED;
  if (lower === '::') return ADDRESS_CLASS.UNSPECIFIED;
  return ADDRESS_CLASS.PUBLIC;
}

/**
 * 汇总本机所有网卡地址。
 *
 * 注意这里刻意**不联网**。它的作用是给出一批候选，以及一个可靠的否定结论：
 * 如果一块非回环网卡上都没有公网地址，那么在不做端口映射的前提下，
 * 别人一定连不进来 —— 这个结论不需要任何外部确认。
 */
export function classifyInterfaces(interfaces = networkInterfaces()) {
  const entries = [];
  for (const [name, addresses] of Object.entries(interfaces ?? {})) {
    for (const address of addresses ?? []) {
      if (!address || typeof address.address !== 'string') continue;
      entries.push({
        name,
        address: address.address,
        family: address.family === 'IPv6' || address.family === 6 ? 6 : 4,
        internal: address.internal === true,
        scope: address.scopeid ?? null,
        class: address.internal ? ADDRESS_CLASS.LOOPBACK : classifyAddress(address.address),
      });
    }
  }

  const publicV4 = entries.filter(
    (entry) => entry.class === ADDRESS_CLASS.PUBLIC && entry.family === 4,
  );
  const publicV6 = entries.filter(
    (entry) => entry.class === ADDRESS_CLASS.PUBLIC && entry.family === 6,
  );
  const hasCgnat = entries.some((entry) => entry.class === ADDRESS_CLASS.CGNAT);
  const hasPrivate = entries.some((entry) => entry.class === ADDRESS_CLASS.PRIVATE);

  /**
   * L1 结论。
   *
   * 用平铺的条件而不是嵌套三元 —— 这段判断有五种情况，
   * 嵌套写法可读性差、还容易改错（我第一版就把括号配错导致整个模块语法错误）。
   */
  let verdict;
  let reason;
  const hasAnyRoutable = entries.some(
    (entry) => entry.class !== ADDRESS_CLASS.LOOPBACK && entry.class !== ADDRESS_CLASS.UNSPECIFIED,
  );

  if (publicV4.length > 0 && publicV6.length > 0) {
    verdict = 'has-public-address';
    reason = '本机网卡上同时有公网 IPv4 与 IPv6 地址；但能否被连入仍需入站实证。';
  } else if (publicV4.length > 0) {
    verdict = 'has-public-address';
    reason = '本机网卡上直接有公网 IPv4 地址；但能否被连入仍需入站实证。';
  } else if (publicV6.length > 0) {
    verdict = 'has-public-address';
    // 如实说清是 v6：只有公网 IPv6 的机器在纯 IPv4 网络里依然连不进来。
    reason = '本机只有公网 IPv6 地址（没有公网 IPv4）。'
      + '在纯 IPv4 网络里的对端仍然连不进来，除非对方也支持 IPv6。';
  } else if (hasCgnat) {
    verdict = 'no-public-address';
    reason = '本机地址在 CGNAT 段（100.64/10）—— 这是运营商级 NAT，入站必然不通。';
  } else if (hasPrivate) {
    verdict = 'no-public-address';
    reason = '本机地址都是私网地址；除非路由器做了端口映射，否则别人连不进来。';
  } else if (hasAnyRoutable) {
    verdict = 'no-public-address';
    reason = '本机的非回环地址都不是全球可路由的地址。';
  } else {
    verdict = 'no-network-interface';
    reason = '没有找到可用的非回环地址。';
  }

  return {
    entries,
    /** 本机接口上的全部公网地址（v4 + v6）。 */
    publicAddresses: [...publicV4, ...publicV6].map((entry) => entry.address),
    publicV4: publicV4.map((entry) => entry.address),
    publicV6: publicV6.map((entry) => entry.address),
    hasPublicV4: publicV4.length > 0,
    hasPublicV6: publicV6.length > 0,
    hasCgnat,
    hasPrivate,
    verdict,
    reason,
  };
}

/** 可达性判定的最终状态。 */
export const REACHABILITY = Object.freeze({
  /** 有第三方真的连进来过并完成握手 —— 唯一可对外宣称的状态。 */
  PROVEN: 'proven',
  /** 中继观察到你的地址就是本机地址（没有经过 NAT），但还没有入站实证。 */
  LIKELY: 'likely',
  /** 在 NAT 后面，且没做端口映射 —— 大概率连不进来。 */
  BEHIND_NAT: 'behind-nat',
  /** 本机没有任何公网地址，也没做映射。 */
  PRIVATE_ONLY: 'private-only',
  /** 缺少观察数据，什么都判断不了。 */
  UNKNOWN: 'unknown',
});

/**
 * 综合 L1（本地地址）与 L2（中继观察）给出判定。
 *
 * 刻意**不包含 L3**：入站实证由调用方（可达性监控）维护，
 * 因为它依赖实时连接事件。这个函数只做"在没有实证的情况下能推断到什么"。
 */
export function assess({ local, observations = [] }) {
  const valid = (observations ?? []).filter(
    (item) => item && typeof item.host === 'string' && Number.isFinite(item.port),
  );

  if (valid.length === 0) {
    return {
      state: local?.verdict === 'no-public-address' ? REACHABILITY.PRIVATE_ONLY : REACHABILITY.UNKNOWN,
      reason: local?.reason ?? '还没有任何观察数据。',
      evidence: { localVerdict: local?.verdict ?? null, observationCount: 0 },
    };
  }

  const observedHosts = new Set(valid.map((item) => item.host));
  const localAddresses = new Set(
    (local?.entries ?? []).filter((entry) => entry.class === ADDRESS_CLASS.PUBLIC).map((entry) => entry.address),
  );

  /**
   * 关键判据：**中继看到的地址是不是就在本机网卡上**。
   *   是 → 数据包没有被翻译，本机直接挂在公网上（LIKELY）
   *   否 → 中间有 NAT 在改写地址（BEHIND_NAT）
   *
   * 注意 LIKELY 不等于"可达"：公网 IP 仍然可能被运营商封掉入站端口，
   * 所以它只用来决定"值不值得做入站实证"，不能拿来对外宣称。
   */
  const observedIsLocal = [...observedHosts].some((host) => localAddresses.has(host));
  if (observedIsLocal) {
    return {
      state: REACHABILITY.LIKELY,
      reason: '中继看到的来源地址与本机网卡地址一致，说明本机直接挂在公网上；'
        + '但仍需一次真实的入站连接才能确认（运营商可能封掉入站）。',
      evidence: { localVerdict: local?.verdict ?? null, observationCount: valid.length, observedIsLocal: true },
    };
  }

  const observedIsPrivate = [...observedHosts].every(
    (host) => classifyAddress(host) !== ADDRESS_CLASS.PUBLIC,
  );
  if (observedIsPrivate) {
    return {
      state: REACHABILITY.PRIVATE_ONLY,
      reason: '中继看到的也是一个非公网地址 —— 你和中继在同一个内网里。',
      evidence: { localVerdict: local?.verdict ?? null, observationCount: valid.length, observedIsLocal: false },
    };
  }

  return {
    state: REACHABILITY.BEHIND_NAT,
    reason: '中继看到的地址不在本机网卡上 —— 你在 NAT 后面。'
      + '如果路由器做了端口映射，仍可能被连入，那需要入站实证来确认。',
    evidence: {
      localVerdict: local?.verdict ?? null,
      observationCount: valid.length,
      observedIsLocal: false,
      /** 只报出数量与是否为公网，不把对端看到的地址原样写进日志。 */
      observedPublic: true,
    },
  };
}

/**
 * 判断一个地址是否允许被"入站实证"探测。
 *
 * **这是一道安全闸门，必须有。**
 *
 * 入站实证的做法是"请一台中继主动连回某个地址"。如果不加限制，
 * 它就变成了一个**端口扫描器 / SSRF 原语**：任何人都能让中继去连内网的
 * 192.168.x.x、云元数据地址 169.254.169.254、或者本机 127.0.0.1，
 * 从而探测内网拓扑。
 *
 * 所以只允许探测**全球可路由**的地址。内网、回环、链路本地、CGNAT 一律拒绝 ——
 * 即使请求方声称那是它自己的地址。
 */
export function isProbeableAddress(input) {
  const host = String(input ?? '').replace(/^\[|\]$/g, '').split(':')[0];
  return classifyAddress(host) === ADDRESS_CLASS.PUBLIC;
}

/** 可达性监控：维护 L2 观察与 L3 实证。 */
export class ReachabilityMonitor {
  #observations = new Map(); // observer → { host, port }
  #inbound = { count: 0, lastAt: null, fromAddresses: [] };
  #outbound = { count: 0, lastAt: null };
  #outboundProbes = { attempts: 0, confirmations: 0 };
  #logger;

  constructor({ logger = null } = {}) {
    this.#logger = logger;
  }

  noteObservation(observer, host, port) {
    if (typeof observer !== 'string' || typeof host !== 'string' || !Number.isFinite(port)) return;
    this.#observations.set(observer, { host, port });
  }

  noteInbound({ address = null, at = Date.now() } = {}) {
    this.#inbound.count += 1;
    this.#inbound.lastAt = at;
    if (address && this.#inbound.fromAddresses.length < 16) this.#inbound.fromAddresses.push(address);
  }

  noteOutbound({ at = Date.now() } = {}) {
    this.#outbound.count += 1;
    this.#outbound.lastAt = at;
  }

  noteProbeConfirmation(ok) {
    this.#outboundProbes.attempts += 1;
    if (ok) this.#outboundProbes.confirmations += 1;
  }

  observations() {
    return [...this.#observations.entries()].map(([observer, endpoint]) => ({ observer, ...endpoint }));
  }

  /**
   * 最终判定。**L3 压倒一切**：
   * 只要有过一次真实入站握手，就是可达的 —— 不管 L1/L2 怎么推断。
   */
  report({ interfaces = networkInterfaces() } = {}) {
    const local = classifyInterfaces(interfaces);
    const assessed = assess({ local, observations: this.observations() });

    if (this.#inbound.count > 0) {
      return {
        state: REACHABILITY.PROVEN,
        reason: `实测有节点主动连入过 ${this.#inbound.count} 次（最近一次 `
          + `${new Date(this.#inbound.lastAt).toLocaleString('zh-CN')}），本机确实可以被连入。`,
        local,
        observations: this.observations(),
        inbound: { ...this.#inbound },
        outbound: { ...this.#outbound },
        probes: { ...this.#outboundProbes },
        evidence: { ...assessed.evidence, inboundCount: this.#inbound.count },
      };
    }

    return {
      state: assessed.state,
      reason: assessed.reason,
      local,
      observations: this.observations(),
      inbound: { ...this.#inbound },
      outbound: { ...this.#outbound },
      probes: { ...this.#outboundProbes },
      evidence: assessed.evidence,
    };
  }

  /**
   * 是否应该建议用户开启中继服务。
   *
   * **只有实证过才建议。** 仅凭"看起来挂在公网上"就建议开启，
   * 后果是用户开了一台中继、对外宣称可达、而别人一个也连不进来 ——
   * 消息发过来全部失败，而且失败得很安静。
   *
   * `interfaces` 可注入，便于测试（否则只能拿真实网卡跑，写不出确定性的用例）。
   */
  shouldSuggestServing({ alreadyServing = false, interfaces } = {}) {
    if (alreadyServing) return { suggest: false, reason: 'already-serving' };
    const report = this.report(interfaces ? { interfaces } : {});
    if (report.state === REACHABILITY.PROVEN) {
      return { suggest: true, reason: 'proven-reachable', state: report.state };
    }
    if (report.state === REACHABILITY.LIKELY) {
      return {
        suggest: false,
        reason: 'needs-inbound-proof',
        state: report.state,
        note: '看起来直接挂在公网上，但还没有任何节点成功连入过。'
          + '先做一次入站实证再建议开启，否则可能对外宣称一台连不上的中继。',
      };
    }
    return { suggest: false, reason: report.state, state: report.state };
  }
}
