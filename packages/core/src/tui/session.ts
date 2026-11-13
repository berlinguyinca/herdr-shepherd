import { setTimeout as sleep } from "node:timers/promises";
import {
  BRIDGE_OPEN_WAIT_SECONDS,
  readBridgeSession,
  saveBridgeSession,
} from "../node/bridge-session.js";
import type { Connection } from "./config.js";
import { TuiError } from "./errors.js";
import type { FetchFn } from "./rpc.js";
import { BRIDGE_OPEN_ORIGIN, openOwnerSession, RateLimitedError } from "./rpc.js";

export type BridgeSessionContext = {
  file: string;
  fetchImpl: FetchFn;
  signal?: AbortSignal;
  /** One line for the person; omitted while a full-screen view owns the terminal. */
  notify?: (text: string) => void;
};

/**
 * herdr's bridge opens an owner session for the `shepherd://` origin when its operator allowlisted
 * it. A kept session is reused unless `fresh`; a new one is kept for the next run. When the bridge
 * says to wait (one open per address every 30 seconds), this waits once and tries again. Any other
 * refusal gives undefined so the token and password routes can be tried.
 */
export async function openBridgeSession(
  context: BridgeSessionContext,
  url: string,
  fresh = false,
): Promise<string | undefined> {
  const kept = fresh ? undefined : readBridgeSession(context.file, url);
  if (kept) return kept;
  for (let attempt = 0; ; attempt++) {
    try {
      const token = await openOwnerSession(url, context.fetchImpl, BRIDGE_OPEN_ORIGIN);
      saveBridgeSession(context.file, url, token);
      return token;
    } catch (error) {
      if (!(error instanceof RateLimitedError)) return undefined;
      if (attempt > 0 || error.seconds > BRIDGE_OPEN_WAIT_SECONDS) throw error;
      context.notify?.(`Waiting for the dashboard (about ${error.seconds} seconds)...`);
      await sleep(error.seconds * 1000, undefined, { signal: context.signal });
    }
  }
}

const bearerOf = (headers: Headers): string | null => headers.get("authorization");

/**
 * Wraps `fetchImpl` so a 401 on a kept bridge session opens one new session (shared by every call
 * that failed at once) and repeats the request with it. `connection.token` is updated in place,
 * and the client reads it again for each request.
 */
export function withSessionRetry(
  fetchImpl: FetchFn,
  connection: Connection,
  reopen: () => Promise<string | undefined>,
): FetchFn {
  let pending: Promise<string | undefined> | undefined;
  return async (input, init) => {
    // A Request body can be read once; keep a copy for the repeat.
    const again = input instanceof Request ? input.clone() : input;
    const response = await fetchImpl(input, init);
    if (response.status !== 401) return response;
    const headers = new Headers(
      init?.headers ?? (again instanceof Request ? again.headers : undefined),
    );
    const used = bearerOf(headers)?.replace(/^Bearer /, "");
    if (used === connection.token) {
      pending ??= reopen()
        .catch((error: unknown) => {
          if (error instanceof TuiError) return undefined;
          throw error;
        })
        .finally(() => {
          pending = undefined;
        });
      const token = await pending;
      if (!token) return response;
      connection.token = token;
    }
    headers.set("authorization", `Bearer ${connection.token}`);
    return fetchImpl(again, { ...init, headers });
  };
}
