import { BlockList, isIP } from "node:net";

/** The networks open-owner mode serves: this computer and the owner's own Tailscale network. */
const OWNER_NETWORK = new BlockList();
OWNER_NETWORK.addSubnet("127.0.0.0", 8, "ipv4");
OWNER_NETWORK.addAddress("::1", "ipv6");
OWNER_NETWORK.addSubnet("100.64.0.0", 10, "ipv4");
OWNER_NETWORK.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");

/** A TCP peer address on loopback or Tailscale. Anything unparsable is outside. */
export function isOwnerNetworkAddress(address: string | undefined): boolean {
  const version = address ? isIP(address) : 0;
  // BlockList reads an IPv4-mapped IPv6 address as its IPv4 address.
  return version !== 0 && OWNER_NETWORK.check(address!, version === 6 ? "ipv6" : "ipv4");
}

/** An `API_HOST` that listens only on this computer or the owner's Tailscale network. */
export function isOwnerNetworkHost(host: string): boolean {
  const bare = host.trim().replace(/^\[(.*)\]$/, "$1");
  return bare.toLowerCase() === "localhost" || isOwnerNetworkAddress(bare);
}
