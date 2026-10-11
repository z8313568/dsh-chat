/**
 * 出站脱敏（规划 §7.7、§5.3、§12.1）。
 *
 * 契约刻意对齐官方 `dsh-session-telemetry` 的 `sessionTelemetry/record` waterfall：
 *   - 每条外发记录都过一遍规则链，规则返回新值才放行；
 *   - **任一规则抛错 ⇒ 该条记录 fail-closed 不上送**，而不是"脱敏失败就原样发出去"；
 *   - 只改外发副本，本机会话日志一个字节都不动。
 *
 * 这是全插件唯一允许决定"这条能不能出去"的地方；所有外发路径都必须经由它。
 * 如果某条外发路径绕过了 applyRedaction，那是一个 bug，不是优化。
 */

/** 常见凭据形态。宁可误伤（把普通字符串打码）也不能漏放。 */
const SECRET_PATTERNS = Object.freeze([
  // OpenAI / DeepSeek 风格的 sk- 密钥
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  // GitHub token
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  // AWS access key id
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Bearer / 通用 Authorization 头
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  // PEM 私钥块（含 OPENSSH）
  /-----BEGIN[^-]{0,40}PRIVATE KEY-----[\s\S]*?-----END[^-]{0,40}PRIVATE KEY-----/g,
  // key = value 形式的赋值，值至少 12 字符
  /\b(?:api[_-]?key|apikey|access[_-]?token|secret[_-]?key|client[_-]?secret|password|passwd|pwd)\b\s*[:=]\s*["']?([^\s"',;]{12,})["']?/gi,
]);

/** 把私钥材料字段整体打掉的兜底规则，按 key 名匹配。 */
const SECRET_KEY_RE = /^(privateJwk|privateKey|secret|mnemonic|seed|password|token|credential|authorization)$/i;

/**
 * POSIX 绝对路径：保留最后一段，前面收敛成 …/
 *
 * 起始边界显式排除 `:` 和 `/`，否则 `https://example.com/a/b` 会被改写成 `…/b`，
 * 把用户分享内容里的链接毁掉。排除之后 URL 不会被误伤（前一个字符是 `:` 或 `/`），
 * 而 `"/Users/twoants/x/y"`、`=/var/log/a.log` 这类仍然会被收敛。
 */
const POSIX_PATH_RE = /(?:^|(?<=[^\w.@+:/-]))\/(?:[\w.@+-]+\/)+[\w.@+-]+/g;
/** Windows 绝对路径 */
const WINDOWS_PATH_RE = /(?:^|(?<=[^\w.@+:/-]))[A-Za-z]:\\(?:[\w.@+-]+\\+)*[\w.@+-]+/g;

export const REDACTION_REASON = Object.freeze({
  PATH: 'path',
  SECRET: 'secret',
  KEYWORD: 'keyword',
  PATTERN: 'pattern',
  SECRET_FIELD: 'secret-field',
});

function mask(value) {
  return `[已脱敏:${value.length}字符]`;
}

function basenameOf(match) {
  return match.split(/[\\/]/).filter(Boolean).pop() ?? '';
}

/** 把一条字符串里的绝对路径收敛成「…/basename」。 */
export function scrubPathsIn(text, homeDir) {
  let out = text;
  const hits = [];

  if (homeDir) {
    // 先把用户主目录整体替换掉：这比通用路径正则更精确，也更容易解释给用户听。
    const escaped = homeDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const homeRe = new RegExp(`${escaped}[^\\s"'\`)\\]}]*`, 'g');
    out = out.replace(homeRe, (match) => {
      hits.push(match);
      const basename = basenameOf(match.slice(homeDir.length));
      return basename ? `~/…/${basename}` : '~';
    });
  }

  const replacePath = (match) => {
    const basename = basenameOf(match);
    if (!basename) return match;
    hits.push(match);
    return `…/${basename}`;
  };
  out = out.replace(POSIX_PATH_RE, replacePath);
  out = out.replace(WINDOWS_PATH_RE, replacePath);
  return { text: out, hits };
}

/** 把常见凭据形态替换掉。 */
export function scrubSecretsIn(text) {
  let out = text;
  const hits = [];
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) => {
      hits.push(match);
      return mask(match);
    });
  }
  return { text: out, hits };
}

/** 对值树里的每个字符串跑一次 transform，返回同构的新值。 */
function mapStrings(value, transform) {
  const walk = (node) => {
    if (typeof node === 'string') return transform(node);
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(walk);
    const out = {};
    for (const [key, item] of Object.entries(node)) out[key] = walk(item);
    return out;
  };
  return walk(value);
}

/** 删除形如 privateKey / token 的字段。 */
function stripSecretFields(value, onHit, depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => stripSecretFields(item, onHit, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = mask(String(item ?? ''));
      onHit();
      continue;
    }
    out[key] = stripSecretFields(item, onHit, depth + 1);
  }
  return out;
}

/**
 * 脱敏流水线。
 *
 * 规则是 `(value, context) => value`。任意规则抛出 ⇒ 这条记录被扣下（withheld），
 * 调用方必须把它当作"不能发送"处理。规则返回 `undefined` 表示显式扣下。
 */
export class RedactionPipeline {
  #rules = [];
  #homeDir;
  #logger;

  constructor({ homeDir = null, logger = null } = {}) {
    this.#homeDir = homeDir;
    this.#logger = logger;
  }

  /** 追加一条规则，返回移除函数。 */
  use(rule) {
    if (typeof rule !== 'function') throw new TypeError('脱敏规则必须是函数');
    this.#rules.push(rule);
    return () => {
      const index = this.#rules.indexOf(rule);
      if (index >= 0) this.#rules.splice(index, 1);
    };
  }

  get ruleCount() {
    return this.#rules.length;
  }

  /**
   * 跑完整条链。
   * @returns {{value: unknown, withheld: boolean, reasons: string[], changed: boolean}}
   */
  apply(value) {
    const reasons = [];
    let current = value;
    try {
      for (const rule of this.#rules) {
        const next = rule(current, { homeDir: this.#homeDir, reasons });
        if (next === undefined) {
          // 规则返回 undefined 表示「显式扣下这条」。
          return { value: null, withheld: true, reasons: [...reasons, 'withheld-by-rule'], changed: true };
        }
        current = next;
      }
      const unique = [...new Set(reasons)];
      return { value: current, withheld: false, reasons: unique, changed: unique.length > 0 };
    } catch (error) {
      // fail-closed：脱敏失败绝不能退化成"原样发出"。
      this.#logger?.warn?.('脱敏规则抛错，该条记录已被扣下（fail-closed）', { message: error?.message });
      return { value: null, withheld: true, reasons: [...new Set([...reasons, 'rule-error'])], changed: true };
    }
  }
}

/**
 * 按配置装配默认规则链。
 * @param {{config: object, logger?: object, homeDir?: string|null}} options
 */
export function createRedactionPipeline({ config, logger = null, homeDir = null }) {
  const policy = config.privacy.redaction;
  const pipeline = new RedactionPipeline({ homeDir, logger });

  if (policy.scrubPaths) {
    pipeline.use((value, context) => mapStrings(value, (text) => {
      const { text: next, hits } = scrubPathsIn(text, context.homeDir);
      if (hits.length > 0) context.reasons.push(REDACTION_REASON.PATH);
      return next;
    }));
  }

  if (policy.scrubSecrets) {
    pipeline.use((value, context) => mapStrings(value, (text) => {
      const { text: next, hits } = scrubSecretsIn(text);
      if (hits.length > 0) context.reasons.push(REDACTION_REASON.SECRET);
      return next;
    }));
    pipeline.use((value, context) => stripSecretFields(value, () => {
      context.reasons.push(REDACTION_REASON.SECRET_FIELD);
    }));
  }

  const keywords = Array.isArray(policy.keywords)
    ? policy.keywords.filter((k) => typeof k === 'string' && k.length > 0)
    : [];
  if (keywords.length > 0) {
    pipeline.use((value, context) => mapStrings(value, (text) => {
      let out = text;
      for (const keyword of keywords) {
        if (out.includes(keyword)) {
          context.reasons.push(REDACTION_REASON.KEYWORD);
          out = out.split(keyword).join(mask(keyword));
        }
      }
      return out;
    }));
  }

  const patterns = Array.isArray(policy.patterns) ? policy.patterns : [];
  for (const source of patterns) {
    const regex = new RegExp(source, 'g');
    pipeline.use((value, context) => mapStrings(value, (text) => text.replace(regex, (match) => {
      context.reasons.push(REDACTION_REASON.PATTERN);
      return mask(match);
    })));
  }

  return pipeline;
}
