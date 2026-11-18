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

export type DiscoveryOptions = {
  signal?: AbortSignal;
  /** Tests only: a loopback test server speaks plain http. */
  allowLoopbackHttp?: boolean;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The address the server names for the app to use from now on: https (loopback http only when the
 * caller allows it), with its path kept and no credentials, query or fragment. Anything else is
 * not followed.
 */
export function acceptBridgeUrl(value: unknown, allowLoopbackHttp = false): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const secure =
      url.protocol === "https:" ||
      (allowLoopbackHttp && url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
    if (!secure || url.username || url.password || url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

function interpret(body: WellKnown, probed: string, allowLoopbackHttp: boolean): Discovery {
  if (body.api_version !== SUPPORTED_API_VERSION) return { kind: "update-app" };
  const modes = Array.isArray(body.auth_modes) ? body.auth_modes : [];
  // A server that never offers tailnet sign-in keeps the plain open; only one that does can send
  // the person to Tailscale.
  if (!modes.includes("tailnet")) return { kind: "password" };
  if (body.tailnet !== true) return { kind: "off-tailnet" };
  return {
    kind: "tailnet",
    bridgeUrl: acceptBridgeUrl(body.bridge_url, allowLoopbackHttp) ?? probed,
  };
}

/** Probes a bridge without credentials. Never throws: a network failure is `off-tailnet`. */
export async function probeShepherd(
  baseUrl: string,
  timeoutMs: number = DISCOVERY_TIMEOUT_MS,
  { signal, allowLoopbackHttp = false }: DiscoveryOptions = {},
): Promise<Discovery> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Request timed out")), timeoutMs);
  const forward = () => controller.abort(signal?.reason);
  if (signal?.aborted) forward();
  else signal?.addEventListener("abort", forward, { once: true });
  try {
    const response = await withAbort(
      fetch(`${baseUrl}${WELL_KNOWN_PATH}`, {
        method: "GET",
        credentials: "omit",
        // The probe answers for this address only; a redirect would hand the decision to another host.
        redirect: "error",
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
        ? interpret(body, baseUrl, allowLoopbackHttp)
        : { kind: "undiscoverable" };
    } catch {
      return controller.signal.aborted ? { kind: "off-tailnet" } : { kind: "undiscoverable" };
    }
  } catch {
    return { kind: "off-tailnet" };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forward);
  }
}
