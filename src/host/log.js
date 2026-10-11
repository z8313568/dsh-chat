/**
 * 日志包装。
 *
 * 为什么单独一层：规划 §5.1 要求私钥、令牌绝不出现在日志里（§12.1）。
 * 集中到一处，才能保证「日志里不会有密钥材料」是一条可审计的规则，
 * 而不是散落在几十处 console.log 里的约定。
 */

const SECRET_KEY_RE = /(privateJwk|privateKey|secret|mnemonic|seed|password|token|authorization|cookie)/i;

/** 递归抹掉看起来像密钥材料的字段。 */
export function sanitizeForLog(value, depth = 0) {
  if (depth > 6) return '[深度截断]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeForLog(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = '[已隐藏]';
      continue;
    }
    out[key] = sanitizeForLog(item, depth + 1);
  }
  return out;
}

/**
 * 建一个 logger。
 * @param {object} ctx cordis Context，可能有 ctx.logger(name)
 * @param {string} name
 */
export function createLogger(ctx, name = 'dsh-chat') {
  const base = typeof ctx?.logger === 'function' ? ctx.logger(name) : ctx?.logger ?? console;
  const write = (level, message, detail) => {
    const sink = typeof base?.[level] === 'function' ? base[level].bind(base) : console[level]?.bind(console) ?? console.log;
    if (detail === undefined) sink(`[${name}] ${message}`);
    else sink(`[${name}] ${message}`, sanitizeForLog(detail));
  };
  return {
    debug: (message, detail) => write('debug', message, detail),
    info: (message, detail) => write('info', message, detail),
    warn: (message, detail) => write('warn', message, detail),
    error: (message, detail) => write('error', message, detail),
    /** 拿到原始 logger，供必须自己控制格式的场景使用。 */
    raw: base,
  };
}
