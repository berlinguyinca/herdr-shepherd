import { readBoundedJsonResponse, withAbort } from "@rakazo/core";

export const WELL_KNOWN_PATH = "/.well-known/herdr-shepherd";
/** The probe is quick on purpose: an off-tailnet phone usually cannot reach the host at all. */
export const DISCOVERY_TIMEOUT_MS = 3_000;
const MAX_DISCOVERY_BYTES = 16 * 1024;
const SUPPORTED_API_VERSION = 1;

/** What `GET /.well-known/herdr-shepherd` tells the app to do next. */
export type Discovery =
  /** Over the tailnet, and the server opens a session for it: no typing. */
  | { kind: "tailnet"; bridgeUrl: string }
  /** Over the tailnet, but the server has not enabled tailnet sign-in. */
  | { kind: "password" }
  /** The request did not arrive over the tailnet, or could not arrive at all. */
  | { kind: "off-tailnet" }
  /** The server speaks an api_version this app does not. */
  | { kind: "update-app" }
  /** A server that predates discovery (HTTP error or no JSON): the app's existing sign-in applies. */
  | { kind: "undiscoverable" };

type WellKnown = {
  api_version?: unknown;
  auth_modes?: unknown;
  tailnet?: unknown;
  bridge_url?: unknown;
};

function httpOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

function interpret(body: WellKnown, probed: string): Discovery {
  if (body.api_version !== SUPPORTED_API_VERSION) return { kind: "update-app" };
  const modes = Array.isArray(body.auth_modes) ? body.auth_modes : [];
  // A server that never offers tailnet sign-in keeps the plain open; only one that does can send
  // the person to Tailscale.
  if (!modes.includes("tailnet")) return { kind: "password" };
  if (body.tailnet !== true) return { kind: "off-tailnet" };
  return { kind: "tailnet", bridgeUrl: httpOrigin(body.bridge_url) ?? probed };
}

/** Probes a bridge without credentials. Never throws: a network failure is `off-tailnet`. */
export async function probeShepherd(
  baseUrl: string,
  timeoutMs: number = DISCOVERY_TIMEOUT_MS,
): Promise<Discovery> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Request timed out")), timeoutMs);
  try {
    const response = await withAbort(
      fetch(`${baseUrl}${WELL_KNOWN_PATH}`, {
        method: "GET",
        credentials: "omit",
        headers: { accept: "application/json" },
        signal: controller.signal,
      }),
      controller.signal,
    );
    if (!response.ok) return { kind: "undiscoverable" };
    try {
      const body = await readBoundedJsonResponse<WellKnown | null>(
        response,
        MAX_DISCOVERY_BYTES,
        controller.signal,
      );
      return body && typeof body === "object"
        ? interpret(body, baseUrl)
        : { kind: "undiscoverable" };
    } catch {
      return controller.signal.aborted ? { kind: "off-tailnet" } : { kind: "undiscoverable" };
    }
  } catch {
    return { kind: "off-tailnet" };
  } finally {
    clearTimeout(timer);
  }
}
