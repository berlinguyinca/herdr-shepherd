import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Where the Tailscale CLI lives: on PATH, or inside the macOS app bundle. */
const TAILSCALE_BINARIES = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

export interface HerdrDiscoveryOptions {
  /** Addresses to probe; defaults to the online peers of this computer's tailnet. */
  peers?: () => Promise<string[]>;
  fetchImpl?: typeof fetch;
  /** Port the dashboard listens on. */
  port?: number;
  timeoutMs?: number;
}

/** The online peers' IPv4 addresses from `tailscale status --json`; empty without Tailscale. */
export function peerAddresses(statusJson: string): string[] {
  let status: unknown;
  try {
    status = JSON.parse(statusJson);
  } catch {
    return [];
  }
  const peers = (status as { Peer?: Record<string, { Online?: boolean; TailscaleIPs?: unknown }> })
    .Peer;
  if (!peers || typeof peers !== "object") return [];
  const addresses: string[] = [];
  for (const peer of Object.values(peers)) {
    if (peer?.Online !== true || !Array.isArray(peer.TailscaleIPs)) continue;
    const v4 = peer.TailscaleIPs.find(
      (ip) => typeof ip === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(ip),
    );
    if (typeof v4 === "string") addresses.push(v4);
  }
  return addresses;
}

async function tailscalePeers(): Promise<string[]> {
  for (const binary of TAILSCALE_BINARIES) {
    try {
      const { stdout } = await execFileAsync(binary, ["status", "--json"], {
        timeout: 5000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return peerAddresses(stdout);
    } catch {
      // try the next location
    }
  }
  return [];
}

/** herdr's sign-in capabilities reply has this shape; other web servers do not answer with it. */
function looksLikeHerdr(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const record = body as Record<string, unknown>;
  return typeof record.passwordAuth === "boolean" && typeof record.nativePasskeys === "object";
}

async function isHerdr(base: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetchImpl(`${base}/api/auth/capabilities`, {
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    return looksLikeHerdr(JSON.parse((await response.text()).slice(0, 4096)));
  } catch {
    return false;
  }
}

/**
 * Finds a herdr dashboard among this computer's Tailscale peers. Only a read-only GET of the
 * public sign-in capabilities goes to each peer, and only over Tailscale (already encrypted).
 * Returns the base URL of the first peer that answers like herdr, or undefined.
 */
export async function discoverHerdrUrl(
  options: HerdrDiscoveryOptions = {},
): Promise<string | undefined> {
  const { fetchImpl = fetch, port = 80, timeoutMs = 2000 } = options;
  const peers = await (options.peers ?? tailscalePeers)();
  const bases = peers.map((ip) => (port === 80 ? `http://${ip}` : `http://${ip}:${port}`));
  const checks = await Promise.all(bases.map((base) => isHerdr(base, fetchImpl, timeoutMs)));
  return bases.find((_, index) => checks[index]);
}
