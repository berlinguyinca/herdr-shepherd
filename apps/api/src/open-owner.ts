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

const FORWARDING_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "tailscale-user-login",
];

/**
 * A reverse proxy, tunnel or port forward on this computer reaches the API from loopback, so the
 * TCP peer says nothing about the real caller. Any sign of one means the request is not direct.
 */
export function hasForwardingHeaders(headers: Headers): boolean {
  return FORWARDING_HEADERS.some((name) => headers.has(name));
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
