import { BlockList, isIP } from "node:net";

export type AccessMode = "accounts" | "open-owner";

/** Never implicit: only the exact value `open-owner` turns it on. */
export function resolveAccessMode(value: string | undefined): AccessMode {
  const mode = value?.trim();
  if (!mode || mode === "accounts") return "accounts";
  if (mode === "open-owner") return "open-owner";
  throw new Error('RAKAZO_ACCESS_MODE must be "accounts" or "open-owner"');
}

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

export function assertOpenOwnerHost(apiHost: string): void {
  if (!isOwnerNetworkHost(apiHost)) {
    throw new Error(
      "RAKAZO_ACCESS_MODE=open-owner needs API_HOST to be a loopback or Tailscale address " +
        "so no one outside the owner's network can reach it",
    );
  }
}

/** The mobile app's fixed origin; a web page cannot send it. */
const APP_ORIGIN = "rakazo://";

/** Browsers always send the real Origin on a POST, so this stops cross-site and rebound pages. */
export function openOwnerOriginAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (!origin) return false;
  return origin === APP_ORIGIN || allowed.includes(origin);
}
