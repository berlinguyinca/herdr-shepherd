import { currentApiBase, openOwnerSession, saveApiBase } from "./api";
import { t } from "./i18n";
import { personalServerOnly } from "./server-config";
import { DISCOVERY_TIMEOUT_MS, probeShepherd } from "./shepherd-discovery";

export type ConnectOptions = {
  /** Cancels the probe and any open still in flight. */
  signal?: AbortSignal;
  /** Tests only: see `DiscoveryOptions`. */
  allowLoopbackHttp?: boolean;
};

export type ConnectResult =
  | { kind: "connected" }
  | { kind: "connect-tailscale" }
  | { kind: "update-app" };

/**
 * Zero-typing onboarding for the single-chat build: probe the baked-in bridge, then open the owner
 * session. A server that is off the tailnet or too new for this app gets its own screen; a server
 * without discovery, or without tailnet sign-in, still gets the existing open (one-person servers).
 * Any other open failure throws, as before.
 */
export async function connectShepherd(options: ConnectOptions = {}): Promise<ConnectResult> {
  const { signal, allowLoopbackHttp = false } = options;
  const found = await probeShepherd(currentApiBase(), DISCOVERY_TIMEOUT_MS, {
    signal,
    allowLoopbackHttp,
  });
  signal?.throwIfAborted();
  if (found.kind === "off-tailnet") return { kind: "connect-tailscale" };
  if (found.kind === "update-app") return { kind: "update-app" };
  // The server may name another address for everything after the probe. A build pinned to one
  // server ignores it. Otherwise the app must really switch: opening against the old address
  // while the server asked for a new one would hide a broken setup.
  if (found.kind === "tailnet" && !personalServerOnly() && found.bridgeUrl !== currentApiBase()) {
    // The app addresses a server by origin only, so a path would be dropped without a word.
    if (new URL(found.bridgeUrl).pathname !== "/")
      throw new Error(t("The server asked for an address this app cannot use"));
    const saved = await saveApiBase(found.bridgeUrl);
    if (!saved.ok) throw new Error(saved.error);
  }
  try {
    await openOwnerSession(undefined, signal);
  } catch (error) {
    // The server could not tell who this caller is: it is not on the tailnet.
    if (found.kind === "tailnet" && (error as { status?: number }).status === 403)
      return { kind: "connect-tailscale" };
    throw error;
  }
  return { kind: "connected" };
}
