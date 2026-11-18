export type LinkOpener = (url: string) => Promise<unknown>;
export type StorePlatform = "ios" | "android";

export const TAILSCALE_URL = "tailscale://";
export const STORE_URL: Record<StorePlatform, string> = {
  ios: "https://apps.apple.com/app/tailscale/id1470499037",
  android: "https://play.google.com/store/apps/details?id=com.tailscale.ipn",
};

/** Opens the Tailscale app, or its store page when it is not installed. */
export async function openTailscale(open: LinkOpener, platform: StorePlatform): Promise<void> {
  try {
    await open(TAILSCALE_URL);
  } catch {
    await open(STORE_URL[platform]);
  }
}
