import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';

/**
 * Outbound address safety (SSRF). An admin types the ERP's address, and Veyrafy's server then
 * calls it, so an address inside Veyrafy's own network (localhost, the private ranges, the cloud
 * metadata endpoint) must never be reachable that way. The check runs in the socket's own DNS
 * lookup, so the address that is checked is the address that is connected to (no gap for DNS
 * rebinding), and it runs again on every redirect hop.
 */

const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  BLOCKED.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  // IPv4-compatible (deprecated), NAT64 (well-known and local-use), 6to4 and site-local: each can
  // carry or reach an internal IPv4 address.
  ['::', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['2002::', 16],
  ['fec0::', 10],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  BLOCKED.addSubnet(net, prefix, 'ipv6');

/** True for an address on the public internet; false for anything private, local or reserved. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped?.[1]) return isPublicAddress(mapped[1]);
    return !BLOCKED.check(address, 'ipv6');
  }
  return !BLOCKED.check(address, 'ipv4');
}

export class BlockedAddressError extends Error {
  constructor() {
    super('The ERP address points inside a private network, which Veyrafy does not call.');
    this.name = 'BlockedAddressError';
  }
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * Which private addresses may still be called. Production allows none (`false`); tests and local
 * development allow a server on this machine. A function allows exactly the addresses it accepts.
 */
export type PrivateAllowance = boolean | ((address: string) => boolean);

export function addressAllowed(address: string, allowPrivate: PrivateAllowance): boolean {
  if (isPublicAddress(address)) return true;
  return typeof allowPrivate === 'function' ? allowPrivate(address) : allowPrivate;
}

/** A `lookup` for http(s).request that refuses private addresses (unless allowed, see above). */
export function guardedLookup(allowPrivate: PrivateAllowance) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback): void => {
    dnsLookup(hostname, { all: true }, (err, addresses) => {
      if (err) {
        callback(err, '');
        return;
      }
      const usable = addresses.filter((a) => addressAllowed(a.address, allowPrivate));
      if (usable.length === 0) {
        callback(Object.assign(new BlockedAddressError(), { code: 'EBLOCKED' }), '');
        return;
      }
      if (options.all) callback(null, usable);
      else {
        const first = usable[0] as LookupAddress;
        callback(null, first.address, first.family);
      }
    });
  };
}
