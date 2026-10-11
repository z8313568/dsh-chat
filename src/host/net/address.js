/**
 * 节点地址的格式化与解析。
 *
 * 单独拆出来，是因为"地址里可能有冒号"这件事在两个地方都以同样的方式出错：
 *
 *   1. `URL.hostname` 对 IPv6 **保留方括号**（`new URL('ws://[::1]:1/').hostname === '[::1]'`），
 *      直接把它交给 `net.connect` 会失败 —— 要先把方括号去掉。
 *   2. `^[^\s:]+:\d{1,5}$` 这种"用第一个冒号切分"的写法对 IPv6 必然失败，
 *      因为 `::1` 里就有冒号。
 *
 * 这两个问题都是实测发现的（本机 `::1` 可用，所以能真的跑出来）。
 * 一个 IPv6 目标必须在**所有**出入口都被一致地处理：写入配置、广播信标、
 * 生成邀请码、接受手工地址、以及最终 `net.connect`。
 */

/**
 * 把 host 与 port 拼成可传输的地址字符串。
 * IPv6 必须加方括号，否则 `::1:47800` 无法判断哪一段是端口。
 */
export function formatPeerAddress(host, port) {
  const needsBrackets = typeof host === 'string' && host.includes(':') && !host.startsWith('[');
  return `${needsBrackets ? `[${host}]` : host}:${port}`;
}

/**
 * 解析 `host:port` 或 `[v6]:port`。
 * @returns {{host: string, port: number} | null} 非法输入返回 null，不抛错——
 *   调用方（配置校验、信标、邀请码）需要能"试一下再回退"。
 */
export function parsePeerAddress(address) {
  if (typeof address !== 'string') return null;
  const trimmed = address.trim();

  // [v6]:port
  const bracketed = /^\[([^\]]+)\]:(\d{1,5})$/.exec(trimmed);
  if (bracketed) {
    const port = Number(bracketed[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host: bracketed[1], port };
  }

  // host:port（host 里不能有冒号，否则就是没加方括号的 IPv6 —— 那是歧义的，拒绝）
  const plain = /^([^\s:]+):(\d{1,5})$/.exec(trimmed);
  if (plain) {
    const port = Number(plain[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host: plain[1], port };
  }

  return null;
}

/** 是不是一个合法的节点地址。 */
export function isPeerAddress(address) {
  return parsePeerAddress(address) !== null;
}

/**
 * 去掉 IPv6 的方括号，得到可以直接交给 `net.connect` 的主机名。
 * 对 IPv4 与域名原样返回。
 */
export function unbracketHost(hostname) {
  if (typeof hostname !== 'string') return hostname;
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/** 地址是否指向本机回环。用于"仅本机"的接口门禁与信标范围判断。 */
export function isLoopbackHost(host) {
  if (typeof host !== 'string') return false;
  const bare = unbracketHost(host);
  return bare === '127.0.0.1' || bare === 'localhost' || bare === '::1';
}

/** 通配地址：监听它表示"所有网卡"，但它本身不是一个可拨号的目标。 */
export function isWildcardHost(host) {
  if (typeof host !== 'string') return false;
  const bare = unbracketHost(host);
  return bare === '' || bare === '0.0.0.0' || bare === '::' || bare === '*';
}

/**
 * 挑一个**可拨号**的本机地址。
 *
 * 为什么需要它：把 `listen.host` 设为 `0.0.0.0`（监听所有网卡）是很自然的配置，
 * 但如果直接把 `0.0.0.0` 广播出去或写进邀请码，对方拿到的是一个**不可路由的目标**——
 * 邀请码看起来正常，拨过去必然失败。所以对外通告时必须换成一个真实地址。
 *
 * 优先级：非内部 IPv4（局域网最通用）→ 非内部 IPv6 → 回环。
 */
export function pickAdvertisableHost(interfaces, port) {
  const ipv4 = [];
  const ipv6 = [];
  for (const addresses of Object.values(interfaces ?? {})) {
    for (const address of addresses ?? []) {
      if (!address || address.internal) continue;
      if (address.family === 'IPv4') ipv4.push(address.address);
      else if (address.family === 'IPv6') ipv6.push(address.address);
    }
  }
  const chosen = ipv4[0] ?? ipv6[0] ?? '127.0.0.1';
  return formatPeerAddress(chosen, port);
}
