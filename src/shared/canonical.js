/**
 * 稳定（canonical）JSON 序列化。
 *
 * 为什么需要它：dsh-chat 的内容标识与数字签名都必须「同一份语义 ⇒ 同一串字节」。
 * `JSON.stringify` 保留对象属性的插入顺序，两个进程构造出语义相同但键序不同的对象时
 * 会得到不同字节，进而得到不同哈希与验签失败。所以所有签名/哈希路径都必须先过这里。
 *
 * 规则（与常见 canonical JSON 约定一致，够用且可自证）：
 *   - 对象按键名的 UTF-16 码元升序排列；
 *   - 数组保持原顺序；
 *   - `undefined`、函数、Symbol 的对象属性被丢弃（与 JSON.stringify 一致）；
 *   - `undefined` 的数组元素写成 null（与 JSON.stringify 一致）；
 *   - 数字必须是有限值；NaN/Infinity 抛错（不静默变成 null）；
 *   - 只接受 JSON 能表达的值，其它类型抛错。
 *
 * 这是纯 JS，没有 node: 依赖，Host 与 Client 两侧都能用。
 */

/** 判断是否是「普通对象」——只有它才需要按 key 排序。 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalize(value, path) {
  if (value === null) return null;

  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`canonicalJson: ${path} 不是有限数字（${String(value)}）`);
    }
    return value;
  }
  if (type === 'bigint') throw new TypeError(`canonicalJson: ${path} 是 bigint，无法表达为 JSON`);
  if (type === 'undefined') return undefined;
  if (type === 'function' || type === 'symbol') {
    throw new TypeError(`canonicalJson: ${path} 是 ${type}，无法表达为 JSON`);
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => {
      const normalized = normalize(item, `${path}[${index}]`);
      return normalized === undefined ? null : normalized;
    });
  }

  if (value instanceof Date) {
    throw new TypeError(`canonicalJson: ${path} 是 Date；请先转成 ISO 字符串`);
  }

  if (!isPlainObject(value)) {
    throw new TypeError(`canonicalJson: ${path} 是类实例（${value.constructor?.name ?? 'unknown'}），请先转成普通对象`);
  }

  const out = {};
  for (const key of Object.keys(value).sort()) {
    const normalized = normalize(value[key], `${path}.${key}`);
    if (normalized === undefined) continue;
    out[key] = normalized;
  }
  return out;
}

/** 返回按键名升序排列的深拷贝，可直接 JSON.stringify。 */
export function canonicalize(value) {
  return normalize(value, '$');
}

/** 稳定序列化：语义相同的值必然得到相同的字符串。 */
export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

/** 稳定序列化的 UTF-8 字节，交给哈希与签名使用。 */
export function canonicalBytes(value) {
  return new TextEncoder().encode(canonicalJson(value));
}
