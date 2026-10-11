/**
 * net-lab 的小工具：列出本机所有可用地址。
 * 单独一个文件，避免主脚本里混进 os/networkInterfaces 的细节。
 */
import { networkInterfaces } from 'node:os';
import { formatPeerAddress } from '../src/host/net/address.js';

/** 列出本机所有非内部地址（含 IPv6），带接口名，便于判断该用哪个地址拨号。 */
export function listAllAddresses() {
  const out = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (!address || address.internal) continue;
      const family = address.family === 'IPv6' ? 'v6' : 'v4';
      out.push(`${address.address}(${name}/${family})`);
    }
  }
  return out.length > 0 ? out : ['(没有非内部地址)'];
}

/** 列出可以直接拨号的候选地址（带端口）。 */
export function listDialable(port) {
  const out = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (!address || address.internal) continue;
      out.push(`${formatPeerAddress(address.address, port)}  (${name})`);
    }
  }
  return out;
}
