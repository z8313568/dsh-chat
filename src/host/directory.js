/**
 * 插件广场的数据层（规划 §4）：可验证清单 + 结构化评分。
 *
 * 规划 §4.4 的要求是「插件目录可以在多个节点上缓存，而不要求每个用户都连接同一个中心目录服务」，
 * 所以这里不做中心数据库，只做**可验证对象 + 本地聚合**：
 *   - 清单（manifest）与评价（rating）都是自带签名与内容哈希的独立对象；
 *   - 任何节点收到后都能独立验证「有没有被改过」和「是不是声明的那个人发的」；
 *   - 聚合（平均分、分布）是**本地计算**的，规划 §8.5 明确说不要把它包装成全网权威排名。
 *
 * 三件必须诚实说明的事（都写进了输出字段，而不是只写在注释里）：
 *   1. §4.3：签名只证明发布者身份，**不证明评价内容真实**；
 *   2. §4.3：签名**不能防止一个人建立多个身份**（女巫攻击），所以聚合结果里
 *      明确标注 `sybilResistance: 'none'`，不给用户「这个分数已经反过刷」的错觉；
 *   3. §4.4：本地已安装的插件来自本机文件系统，**没有发布者签名**，
 *      因此标记为 `verified: false`，界面必须把它和签名验证过的清单区分展示。
 */
import { PROTOCOL_VERSION, RATING_DIMENSIONS } from '../shared/protocol.js';
import { contentHashOf, verifyWithPublicKeyId } from './identity.js';

/** 已体验标识（规划 §4.3）：不侵害隐私的前提下区分真实体验者与浏览者。 */
export const EXPERIENCE = Object.freeze({
  /** 本机确实安装/使用过该插件。 */
  USED: 'used',
  /** 只是浏览过。 */
  BROWSED: 'browsed',
  UNKNOWN: 'unknown',
});

/**
 * 可变字段与不可变字段的分离——这是本模块最容易出错的地方。
 *
 * 「作者的主张」与「社区对它做的事」必须分开：
 *   不可变（参与内容哈希与签名）：pluginId / version / author / scores / text / experience / createdAt …
 *   可变（不参与，允许后到地变化）：sig / contentHash / helpful（有用票）/ report*（举报）/ replies（作者回复）
 *
 * 为什么不能把可变字段也算进去：一旦算进去，任何一次「标记有用」或「作者回复」都会立刻
 * 让这条评价的签名失效——于是「社区可以给它投票」和「签名可验证」变成二选一。
 * 第一版把 reply 直接改写进评价对象，importRating 就再也通不过校验了，测试当场抓到。
 *
 * 作者回复因此**不是**评价对象里的一个字符串，而是一条独立的、自己带签名的记录
 * （见 replyToRating / verifyReply），这样回复本身也能被独立验证，不会被冒名。
 */
const VOLATILE_FIELDS = Object.freeze([
  'sig', 'contentHash',
  'helpful', 'reportCount', 'reportedAt', 'reportReason',
  'replies',
]);

/** 去掉全部可变字段后的「作者主张」，它是哈希与签名的唯一对象。 */
function signedBody(record) {
  const copy = { ...record };
  for (const field of VOLATILE_FIELDS) delete copy[field];
  return copy;
}

const hashingBody = signedBody;

export class PluginDirectory {
  #identity;
  #logger;
  #manifests = new Map(); // pluginId → Map<version, manifest>
  #ratings = new Map(); // pluginId → rating[]
  #local = new Map(); // pluginId → 本机安装信息（未签名）
  #listeners = new Set();

  constructor({ identity, logger = null }) {
    this.#identity = identity;
    this.#logger = logger;
  }

  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify() {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // 订阅者异常不影响目录。
      }
    }
  }

  // ===== 清单 =====

  /**
   * 构造并签名一个插件清单。发布者身份就是本机身份——
   * 也就是说，用这个插件的人同时也能发布自己的插件清单，不需要中心服务器。
   */
  publishManifest({
    pluginId, name, version, description = '', tags = [], dshCompatibility = null,
    downloadUrl = null, packageHash = null,
  }) {
    if (typeof pluginId !== 'string' || pluginId.length === 0) throw new TypeError('pluginId 必填');
    if (typeof version !== 'string' || version.length === 0) throw new TypeError('version 必填');

    const manifest = {
      protocol: PROTOCOL_VERSION,
      kind: 'plugin-manifest',
      pluginId,
      name: typeof name === 'string' && name ? name : pluginId,
      version,
      description: String(description).slice(0, 2000),
      tags: Array.isArray(tags) ? tags.filter((t) => typeof t === 'string').slice(0, 12) : [],
      publisher: {
        publicKeyId: this.#identity.publicKeyId,
        fingerprint: this.#identity.fingerprint,
      },
      /** 规划 §4.1「版本和 DSH 兼容性」。null 表示发布者没有声明，而不是"兼容"。 */
      dshCompatibility,
      downloadUrl,
      /** 插件包的内容哈希（规划 §4.4「下载地址或内容标识」）。 */
      packageHash,
      publishedAt: Date.now(),
    };
    manifest.contentHash = contentHashOf(hashingBody(manifest));
    manifest.sig = this.#identity.sign(signedBody(manifest));

    const versions = this.#manifests.get(pluginId) ?? new Map();
    versions.set(version, manifest);
    this.#manifests.set(pluginId, versions);
    this.#notify();
    return manifest;
  }

  /**
   * 校验清单。与分享对象一样，完整性与真实性是两个独立结论。
   * 规划 §4.4 特别提醒「发生冲突时，不能只相信传播速度最快的版本」——
   * 所以冲突处理放在 `resolveVersion`，而不是按到达时间覆盖。
   */
  verifyManifest(manifest) {
    const problems = [];
    if (!manifest || typeof manifest !== 'object') return { integrity: false, authenticity: false, problems: ['not-an-object'] };
    if (manifest.protocol !== PROTOCOL_VERSION) problems.push(`protocol-mismatch:${String(manifest.protocol)}`);

    const integrity = typeof manifest.contentHash === 'string'
      && manifest.contentHash === contentHashOf(hashingBody(manifest));
    if (!integrity) problems.push('content-hash-mismatch');

    const key = manifest.publisher?.publicKeyId;
    const authenticity = typeof manifest.sig === 'string' && typeof key === 'string'
      ? verifyWithPublicKeyId(key, signedBody(manifest), manifest.sig)
      : false;
    if (!authenticity) problems.push('signature-invalid');

    return { integrity, authenticity, problems };
  }

  /** 导入一个来自网络的清单。只有完整且真实的对象才会进入本地目录。 */
  importManifest(manifest) {
    const verdict = this.verifyManifest(manifest);
    if (!verdict.integrity || !verdict.authenticity) {
      this.#logger?.warn?.('拒绝导入未通过校验的插件清单', { pluginId: manifest?.pluginId, problems: verdict.problems });
      return { accepted: false, verdict };
    }
    const versions = this.#manifests.get(manifest.pluginId) ?? new Map();
    const existing = versions.get(manifest.version);
    // 同一 pluginId + version 出现两份不同的清单：这是必须让用户看见的冲突，
    // 不能静默地"后到者覆盖"（规划 §4.4）。
    if (existing && existing.contentHash !== manifest.contentHash) {
      this.#logger?.warn?.('插件清单冲突：同一版本存在两份不同内容', {
        pluginId: manifest.pluginId, version: manifest.version,
        kept: existing.publisher?.publicKeyId, rejected: manifest.publisher?.publicKeyId,
      });
      return { accepted: false, verdict, conflict: true };
    }
    versions.set(manifest.version, manifest);
    this.#manifests.set(manifest.pluginId, versions);
    this.#notify();
    return { accepted: true, verdict };
  }

  /**
   * 记录本机已安装的插件。
   *
   * 这些条目**没有发布者签名**，所以一律 `verified: false`、`source: 'local'`。
   * 界面必须把它们显示成"本机已安装（未验证来源）"，而不是混进签名目录里充数。
   */
  ingestLocal(plugins) {
    for (const plugin of plugins) {
      if (!plugin?.name) continue;
      this.#local.set(plugin.name, {
        pluginId: plugin.name,
        name: plugin.name,
        version: plugin.version ?? '0.0.0',
        description: plugin.description ?? '',
        source: 'local',
        verified: false,
        installed: true,
      });
    }
    this.#notify();
  }

  /** 合并视图：签名清单 + 本机已安装（未验证）。 */
  list() {
    const out = new Map();
    for (const [pluginId, versions] of this.#manifests) {
      const latest = this.resolveVersion(pluginId);
      out.set(pluginId, {
        pluginId,
        name: latest.name,
        version: latest.version,
        description: latest.description,
        tags: latest.tags,
        publisher: latest.publisher,
        dshCompatibility: latest.dshCompatibility,
        publishedAt: latest.publishedAt,
        source: 'signed',
        verified: true,
        installed: this.#local.has(pluginId),
        versions: [...versions.keys()],
        rating: this.aggregate(pluginId),
      });
    }
    for (const [pluginId, local] of this.#local) {
      if (out.has(pluginId)) continue;
      out.set(pluginId, {
        ...local,
        tags: [],
        publisher: null,
        dshCompatibility: null,
        publishedAt: null,
        versions: [local.version],
        rating: this.aggregate(pluginId),
      });
    }
    return [...out.values()].sort((a, b) => {
      // 已验证的排前面；同组内按评分数量、再按名称。
      if (a.verified !== b.verified) return a.verified ? -1 : 1;
      const countDiff = (b.rating?.count ?? 0) - (a.rating?.count ?? 0);
      if (countDiff !== 0) return countDiff;
      return a.name.localeCompare(b.name);
    });
  }

  /**
   * 选出一个 pluginId 的"当前版本"。
   * 不做语义化版本比较（那需要依赖 semver），而是按 `publishedAt` 取最新，
   * 并在返回值里保留全部版本，让用户自己看清时间线——比自作聪明地排序更不容易骗人。
   */
  resolveVersion(pluginId) {
    const versions = this.#manifests.get(pluginId);
    if (!versions || versions.size === 0) return null;
    return [...versions.values()].sort((a, b) => b.publishedAt - a.publishedAt)[0];
  }

  // ===== 评价 =====

  /** 提交一条结构化评价（规划 §4.3：功能实用性、易用性、稳定性和文档质量）。 */
  rate(pluginId, {
    version = null,
    scores = {},
    text = '',
    experience = EXPERIENCE.UNKNOWN,
  } = {}) {
    if (typeof pluginId !== 'string' || pluginId.length === 0) throw new TypeError('pluginId 必填');
    const normalized = {};
    for (const dimension of RATING_DIMENSIONS) {
      const value = scores[dimension];
      if (value === undefined || value === null) continue;
      const number = Number(value);
      if (!Number.isFinite(number) || number < 1 || number > 5) {
        throw new TypeError(`${dimension} 评分必须在 1~5 之间，收到: ${String(value)}`);
      }
      normalized[dimension] = Math.round(number * 10) / 10;
    }
    if (Object.keys(normalized).length === 0) throw new TypeError('至少需要一个维度的评分');

    const rating = {
      protocol: PROTOCOL_VERSION,
      kind: 'plugin-rating',
      pluginId,
      version,
      author: { publicKeyId: this.#identity.publicKeyId, fingerprint: this.#identity.fingerprint },
      scores: normalized,
      text: String(text).slice(0, 4000),
      experience,
      createdAt: Date.now(),
      /** 作者回复（规划 §4.3）：自己带签名的独立记录，见 replyToRating。 */
      replies: [],
      /** 「有用评价」计数（规划 §4.3）。 */
      helpful: [],
      reportCount: 0,
    };
    rating.contentHash = contentHashOf(hashingBody(rating));
    rating.sig = this.#identity.sign(signedBody(rating));

    const list = this.#ratings.get(pluginId) ?? [];
    list.push(rating);
    this.#ratings.set(pluginId, list);
    this.#notify();
    return rating;
  }

  verifyRating(rating) {
    const problems = [];
    if (!rating || typeof rating !== 'object') return { integrity: false, authenticity: false, problems: ['not-an-object'] };
    const integrity = typeof rating.contentHash === 'string'
      && rating.contentHash === contentHashOf(hashingBody(rating));
    if (!integrity) problems.push('content-hash-mismatch');
    const key = rating.author?.publicKeyId;
    const authenticity = typeof rating.sig === 'string' && typeof key === 'string'
      ? verifyWithPublicKeyId(key, signedBody(rating), rating.sig)
      : false;
    if (!authenticity) problems.push('signature-invalid');
    return { integrity, authenticity, problems };
  }

  importRating(rating) {
    const verdict = this.verifyRating(rating);
    if (!verdict.integrity || !verdict.authenticity) return { accepted: false, verdict };
    const list = this.#ratings.get(rating.pluginId) ?? [];
    if (list.some((existing) => existing.contentHash === rating.contentHash)) {
      return { accepted: false, verdict, duplicate: true };
    }
    list.push(rating);
    this.#ratings.set(rating.pluginId, list);
    this.#notify();
    return { accepted: true, verdict };
  }

  /**
   * 作者公开回应反馈（规划 §4.3）。
   *
   * 回复是一条**独立签名**的记录，不是评价对象里的一段可变文字：
   * 把它写进评价会让评价自己的签名失效，而且别人可以篡改回复而评价签名依然有效。
   * 独立记录之后，`verifyReply` 能独立验证回复的完整性、真实性与作者身份。
   */
  replyToRating(pluginId, ratingContentHash, text) {
    const list = this.#ratings.get(pluginId) ?? [];
    const rating = list.find((item) => item.contentHash === ratingContentHash);
    if (!rating) throw new Error('评价不存在');
    if (rating.author.publicKeyId !== this.#identity.publicKeyId) {
      // 只有评价作者本人的密钥能发出被认可的回复。
      throw new Error('只能由评价作者本人回复');
    }
    const reply = {
      protocol: PROTOCOL_VERSION,
      kind: 'plugin-rating-reply',
      pluginId,
      /** 指向被回复的评价（按内容哈希，而不是数组下标）。 */
      target: rating.contentHash,
      author: { publicKeyId: this.#identity.publicKeyId, fingerprint: this.#identity.fingerprint },
      text: String(text).slice(0, 2000),
      createdAt: Date.now(),
    };
    reply.contentHash = contentHashOf(hashingBody(reply));
    reply.sig = this.#identity.sign(signedBody(reply));

    rating.replies = [...(rating.replies ?? []), reply];
    this.#notify();
    return reply;
  }

  /** 独立校验一条作者回复：完整性、真实性，以及它确实出自评价作者本人。 */
  verifyReply(reply, rating = null) {
    const problems = [];
    if (!reply || typeof reply !== 'object') return { integrity: false, authenticity: false, isAuthor: false, problems: ['not-an-object'] };
    const integrity = typeof reply.contentHash === 'string'
      && reply.contentHash === contentHashOf(hashingBody(reply));
    if (!integrity) problems.push('content-hash-mismatch');
    const key = reply.author?.publicKeyId;
    const authenticity = typeof reply.sig === 'string' && typeof key === 'string'
      ? verifyWithPublicKeyId(key, signedBody(reply), reply.sig)
      : false;
    if (!authenticity) problems.push('signature-invalid');
    const isAuthor = rating ? reply.author?.publicKeyId === rating.author?.publicKeyId : false;
    if (rating && !isAuthor) problems.push('not-the-rating-author');
    if (rating && reply.target !== rating.contentHash) problems.push('reply-target-mismatch');
    return { integrity, authenticity, isAuthor, problems };
  }

  /** 标记「有用」。同一身份只计一次。 */
  markHelpful(pluginId, ratingContentHash, voterKey = this.#identity.publicKeyId) {
    const list = this.#ratings.get(pluginId) ?? [];
    const rating = list.find((item) => item.contentHash === ratingContentHash);
    if (!rating) throw new Error('评价不存在');
    if (!rating.helpful.includes(voterKey)) rating.helpful.push(voterKey);
    this.#notify();
    return rating;
  }

  /** 举报虚假评价 / 恶意插件（规划 §4.3、§9.5）。本地计数，不做全网裁决。 */
  report(pluginId, ratingContentHash = null, reason = '') {
    const list = this.#ratings.get(pluginId) ?? [];
    if (ratingContentHash === null) {
      this.#logger?.info?.('举报插件', { pluginId, reason });
      return { pluginId, reason, at: Date.now() };
    }
    const rating = list.find((item) => item.contentHash === ratingContentHash);
    if (!rating) throw new Error('评价不存在');
    rating.reportCount += 1;
    rating.reportedAt = Date.now();
    rating.reportReason = String(reason).slice(0, 200);
    this.#notify();
    return rating;
  }

  /**
   * 本地聚合（规划 §4.3）。
   *
   * 刻意输出 `sybilResistance: 'none'` 与 `note`，把「这个分数是怎么来的、它不保证什么」
   * 直接放在数据里。规划 §8.5 说得很清楚：不要宣称本地计算的热门榜代表整个网络的绝对排名。
   */
  aggregate(pluginId, { currentVersion = null } = {}) {
    const all = this.#ratings.get(pluginId) ?? [];
    // 被举报到 3 次以上的评价不参与聚合，但也不删除——删除会让举报变成一种审查工具。
    const eligible = all.filter((rating) => rating.reportCount < 3);
    if (eligible.length === 0) {
      return {
        // count 的语义是「参与聚合的评价数」。全部被排除时它必须是 0，
        // 而不是回退成总数——否则界面会显示「1 条评价，平均分 null」这种自相矛盾的东西。
        count: 0,
        totalCount: all.length,
        excludedForReports: all.length,
        average: null,
        dimensions: {},
        distribution: {},
        sybilResistance: 'none',
        note: '评分由发布者密钥签名，只能证明发布者身份，不能证明评价真实，也不能防止一人多身份。',
      };
    }

    const dimensions = {};
    for (const dimension of RATING_DIMENSIONS) {
      const values = eligible.map((r) => r.scores[dimension]).filter((v) => typeof v === 'number');
      if (values.length === 0) continue;
      dimensions[dimension] = {
        average: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100,
        count: values.length,
      };
    }
    const perRatingAverage = eligible.map((r) => {
      const values = Object.values(r.scores);
      return values.reduce((a, b) => a + b, 0) / values.length;
    });
    const average = Math.round((perRatingAverage.reduce((a, b) => a + b, 0) / perRatingAverage.length) * 100) / 100;

    // 分布直方图（规划 §4.3「评分聚合：加权平均 + 分布直方图」）。
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const value of perRatingAverage) distribution[Math.min(5, Math.max(1, Math.round(value)))] += 1;

    return {
      count: eligible.length,
      totalCount: all.length,
      excludedForReports: all.length - eligible.length,
      average,
      dimensions,
      distribution,
      /** 标注有多少条是针对旧版本的（规划 §4.3「版本关联评价」）。 */
      staleCount: currentVersion ? eligible.filter((r) => r.version && r.version !== currentVersion).length : 0,
      helpfulTotal: eligible.reduce((sum, r) => sum + r.helpful.length, 0),
      /** 有多少条带"已体验"标识。 */
      experiencedCount: eligible.filter((r) => r.experience === EXPERIENCE.USED).length,
      sybilResistance: 'none',
      note: '评分由发布者密钥签名，只能证明发布者身份，不能证明评价真实，也不能防止一人多身份。',
    };
  }

  /** 某插件的全部评价，按「有用数 → 时间」排序。 */
  ratingsFor(pluginId) {
    return [...(this.#ratings.get(pluginId) ?? [])]
      .sort((a, b) => (b.helpful.length - a.helpful.length) || (b.createdAt - a.createdAt))
      // 返回 { rating, verdict } 而**不是**把 verdict 摊进 rating 里。
      // 早先写成 { ...rating, verified }，结果是返回值再也通不过自己的校验——
      // 多出来的 verified 字段会参与内容哈希，而它显然不在签名里。
      // 「包装一下就破坏了被包装对象」是很隐蔽的坑，所以这里不改动原对象。
      .map((rating) => ({ rating, verdict: this.verifyRating(rating) }));
  }

  get metrics() {
    let ratingCount = 0;
    for (const list of this.#ratings.values()) ratingCount += list.length;
    return {
      signedManifests: this.#manifests.size,
      localPlugins: this.#local.size,
      ratings: ratingCount,
    };
  }
}
