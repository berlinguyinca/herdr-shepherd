import { isOwnerNetworkAddress, isOwnerNetworkHost } from "@rakazo/core/node/owner-network";

export type AccessMode = "accounts" | "open-owner";

/** Never implicit: only the exact value `open-owner` turns it on. */
export function resolveAccessMode(value: string | undefined): AccessMode {
  const mode = value?.trim();
  if (!mode || mode === "accounts") return "accounts";
  if (mode === "open-owner") return "open-owner";
  throw new Error('RAKAZO_ACCESS_MODE must be "accounts" or "open-owner"');
}

export { isOwnerNetworkAddress, isOwnerNetworkHost };

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

/**
 * Header names a proxy, CDN, tunnel or identity-aware front adds to carry the caller's address or
 * its own presence. A browser or the mobile app sends none of them. `x-forwarded-for` is the one
 * exception: the web server's own proxy always sends it, and its chain is checked hop by hop.
 */
const PROXY_HEADER_NAME = new RegExp(
  [
    "^forwarded(?:-.*)?$",
    "^x-forwarded(?:-(?!for$).*)?$",
    "^x-(?:real|client|cluster-client)-ip$",
    "^x-original-forwarded-for$",
    "^x-appengine-user-ip$",
    "^x-(?:azure|envoy)-",
    "^x-amzn-trace-id$",
    "^x-amz-cf-id$",
    "^via$",
    "^cf-",
    "^(?:true|fastly)-client-ip$",
    "^tailscale-",
  ].join("|"),
  "i",
);

const MAX_FORWARDED_HOPS = 8;
const MAX_HOP_LENGTH = 64;

function validPort(port: string | undefined): boolean {
  return port === undefined || Number(port) <= 65535;
}

/** A dotted quad with no leading zeros (those are octal to some parsers), or null. */
function strictIpv4(address: string): string | null {
  const octets = address.split(".");
  if (octets.length !== 4) return null;
  const valid = octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255);
  return valid ? address : null;
}

/**
 * Canonical IPv6 text, with an IPv4-mapped address (`::ffff:a.b.c.d` or `::ffff:xxxx:xxxx`, any
 * case or zero padding) turned into its IPv4 address. IPv4-compatible `::a.b.c.d` is deprecated
 * and no real stack sends it, so it stays IPv6 and is outside the owner network.
 */
function canonicalIpv6(address: string): string | null {
  let host: string;
  try {
    host = new URL(`http://[${address}]`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!mapped) return host;
  const [high, low] = [Number.parseInt(mapped[1]!, 16), Number.parseInt(mapped[2]!, 16)];
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/**
 * One X-Forwarded-For entry as an address, or null when it is not exactly one. Accepts an IPv4
 * address with an optional port, a bracketed IPv6 address with an optional port, and a bare IPv6
 * address. Zone IDs, names, bare IPv6 with a port, and oversized entries are refused.
 */
function forwardedAddress(entry: string): string | null {
  const hop = entry.trim();
  if (!hop || hop.length > MAX_HOP_LENGTH) return null;
  const v4 = /^([0-9.]+)(?::(\d{1,5}))?$/.exec(hop);
  if (v4) return validPort(v4[2]) ? strictIpv4(v4[1]!) : null;
  const bracketed = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/i.exec(hop);
  if (bracketed)
    return validPort(bracketed[2]) && bracketed[1]!.includes(":")
      ? canonicalIpv6(bracketed[1]!)
      : null;
  return /^[0-9a-f:.]+$/i.test(hop) && hop.includes(":") ? canonicalIpv6(hop) : null;
}

/** Every hop of an X-Forwarded-For chain is on this computer or the owner's network. */
function forwardedChainIsOwner(value: string): boolean {
  const entries = value.split(",");
  if (entries.length > MAX_FORWARDED_HOPS) return false;
  return entries.every((entry) => {
    const address = forwardedAddress(entry);
    return address !== null && isOwnerNetworkAddress(address);
  });
}

/**
 * A reverse proxy, tunnel or port forward on this computer reaches the API from loopback, so the
 * TCP peer says nothing about the real caller. The web server appends the peer it saw to
 * X-Forwarded-For, so a same-machine browser yields only owner-network hops, while a remote
 * caller (or a forged leading entry) always leaves its real address in the chain. Any other
 * proxy or client-address header, or a chain with an outside or unparsable hop, means the request
 * is not direct. This is defence in depth: a front that adds no header cannot be detected.
 */
export function isProxiedBeyondOwner(headers: Headers): boolean {
  for (const name of headers.keys()) {
    if (PROXY_HEADER_NAME.test(name)) return true;
  }
  const chain = headers.get("x-forwarded-for");
  return chain !== null && !forwardedChainIsOwner(chain);
}

/** At most `limit` opens per `windowMs`, counted for the whole process. */
export function createOpenLimiter(limit = 30, windowMs = 60_000, now: () => number = Date.now) {
  const hits: number[] = [];
  return () => {
    const cutoff = now() - windowMs;
    while (hits.length > 0 && hits[0]! <= cutoff) hits.shift();
    if (hits.length >= limit) return false;
    hits.push(now());
    return true;
  };
}
