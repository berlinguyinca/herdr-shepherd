import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { AppContract } from "@rakazo/contracts";
import type { Connection } from "./config.js";
import { TuiError } from "./errors.js";

export type TuiClient = ContractRouterClient<AppContract>;
export type FetchFn = typeof fetch;

const STREAM_PROCEDURES = new Set(["subscribe", "subscribeList"]);

/**
 * The oRPC client, over plain RPCLink JSON, for a Shepherd server or herdr's bridge (same
 * contract). Streams ask for `text/event-stream`. The token only ever travels in the header.
 */
export function createTuiClient(connection: Connection, fetchImpl: FetchFn = fetch): TuiClient {
  const link = new RPCLink({
    url: `${connection.url}/rpc`,
    fetch: (input, init) => fetchImpl(input, init),
    headers: (_options, path) => ({
      ...(connection.token ? { authorization: `Bearer ${connection.token}` } : {}),
      ...(connection.space ? { "x-rakazo-space-id": connection.space } : {}),
      ...(STREAM_PROCEDURES.has(path[path.length - 1] ?? "")
        ? { accept: "text/event-stream" }
        : {}),
    }),
  });
  return createORPCClient<TuiClient>(link);
}

const errorField = (error: unknown, key: "status" | "code"): unknown =>
  typeof error === "object" && error !== null && key in error
    ? (error as Record<string, unknown>)[key]
    : undefined;

/** True when the server answered "no such procedure" (a Shepherd API has no agents/terminal). */
export function isProcedureMissing(error: unknown): boolean {
  return errorField(error, "status") === 404 || errorField(error, "code") === "NOT_FOUND";
}

/** An actionable message for a failed call. Never includes request headers or the token. */
export function explainRpcError(error: unknown, procedure: string): TuiError {
  if (error instanceof TuiError) return error;
  if (isProcedureMissing(error)) {
    return new TuiError(
      `${procedure} is not served by this server. Shepherd's own API does not serve agents or terminal; point --url at herdr's bridge.`,
    );
  }
  const status = errorField(error, "status");
  if (status === 401 || status === 403) {
    return new TuiError(
      `${procedure}: not signed in or not allowed. Run \`pnpm tui login\` or set SHEPHERD_TOKEN.`,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new TuiError(`${procedure} failed: ${message}`);
}

export type AuthCapabilities = { openOwner: boolean; passwordAuth: boolean } | null;

/** `GET /api/auth/capabilities`; null when the server has no such route (herdr's bridge). */
export async function fetchCapabilities(
  url: string,
  fetchImpl: FetchFn = fetch,
): Promise<AuthCapabilities> {
  try {
    const response = await fetchImpl(`${url}/api/auth/capabilities`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { openOwner?: unknown; passwordAuth?: unknown };
    return { openOwner: body.openOwner === true, passwordAuth: body.passwordAuth !== false };
  } catch {
    return null;
  }
}

async function tokenFrom(response: Response): Promise<string | undefined> {
  const header = response.headers.get("set-auth-token");
  if (header) return header;
  try {
    const body = (await response.json()) as { token?: unknown };
    return typeof body.token === "string" && body.token ? body.token : undefined;
  } catch {
    return undefined;
  }
}

/** Email and password sign-in; returns a bearer token. The password is never echoed back. */
export async function signInWithPassword(
  url: string,
  email: string,
  password: string,
  fetchImpl: FetchFn = fetch,
): Promise<string> {
  const response = await fetchImpl(`${url}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    throw new TuiError(
      response.status === 401 || response.status === 400
        ? "Sign-in refused: check the email and password."
        : `Sign-in failed (HTTP ${response.status}).`,
    );
  }
  const token = await tokenFrom(response);
  if (!token) throw new TuiError("The server accepted the sign-in but returned no token.");
  return token;
}

/**
 * Open-owner servers sign in the owner with no credentials, but only for a request on loopback or
 * Tailscale that carries an allowed web origin. We send the server's own origin and never fake
 * the mobile app's.
 */
export async function openOwnerSession(url: string, fetchImpl: FetchFn = fetch): Promise<string> {
  const response = await fetchImpl(`${url}/api/auth/open`, {
    method: "POST",
    headers: { origin: new URL(url).origin, accept: "application/json" },
  });
  if (response.status === 403) {
    throw new TuiError(
      "The open-owner server refused this client (network or origin not allowed). Pass --token or sign in with --email.",
    );
  }
  if (!response.ok) throw new TuiError(`Open-owner sign-in failed (HTTP ${response.status}).`);
  const token = await tokenFrom(response);
  if (!token) throw new TuiError("The server opened a session but returned no token.");
  return token;
}

/** `GET /rpc/health` (no auth); false when unreachable. A server without the route counts as up. */
export async function checkHealth(url: string, fetchImpl: FetchFn = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${url}/rpc/health`);
    return response.status < 500;
  } catch {
    return false;
  }
}
