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
