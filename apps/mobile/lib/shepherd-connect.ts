import { currentApiBase, openOwnerSession, saveApiBase } from "./api";
import { probeShepherd } from "./shepherd-discovery";

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
export async function connectShepherd(): Promise<ConnectResult> {
  const found = await probeShepherd(currentApiBase());
  if (found.kind === "off-tailnet") return { kind: "connect-tailscale" };
  if (found.kind === "update-app") return { kind: "update-app" };
  // The server may name a different address for everything after the probe. A build pinned to one
  // server refuses the switch and keeps using the address it probed.
  if (found.kind === "tailnet" && found.bridgeUrl !== currentApiBase())
    await saveApiBase(found.bridgeUrl);
  try {
    await openOwnerSession();
  } catch (error) {
    // The server could not tell who this caller is: it is not on the tailnet.
    if (found.kind === "tailnet" && (error as { status?: number }).status === 403)
      return { kind: "connect-tailscale" };
    throw error;
  }
  return { kind: "connected" };
}
