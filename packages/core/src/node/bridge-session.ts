import { clientFilePath, readClientFile, writeClientFile } from "../tui/config.js";

/**
 * The bridge allows one passwordless session open per address every 30 seconds and each open
 * evicts the oldest session, so the terminal view and the assistant connector keep the session
 * they minted in the client file (owner-only) and reuse it until the bridge refuses it.
 */
export const BRIDGE_OPEN_WAIT_SECONDS = 30;

export { clientFilePath };

const sameServer = (a: string, b: string): boolean =>
  a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

/** The kept session token for this dashboard, if the client file holds one. */
export function readBridgeSession(file: string, url: string): string | undefined {
  try {
    const kept = readClientFile(file).bridgeSession;
    return kept && sameServer(kept.url, url) ? kept.token : undefined;
  } catch {
    return undefined;
  }
}

/** Keeps the token next to the other client settings; a file that cannot be written is not fatal. */
export function saveBridgeSession(file: string, url: string, token: string): void {
  try {
    writeClientFile(file, { ...readClientFile(file), bridgeSession: { url, token } });
  } catch {
    // The session still works for this run.
  }
}

/** Seconds to wait from a `Retry-After` header; 30 when it is missing or not a number. */
export function retryAfterSeconds(header: string | null): number {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : BRIDGE_OPEN_WAIT_SECONDS;
}
