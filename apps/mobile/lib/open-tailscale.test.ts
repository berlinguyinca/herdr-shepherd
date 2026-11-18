import { describe, expect, it } from "vitest";
import { type LinkOpener, openTailscale, STORE_URL, TAILSCALE_URL } from "./open-tailscale";

function recorder(failFirst: boolean): { opener: LinkOpener; opened: string[] } {
  const opened: string[] = [];
  const opener: LinkOpener = async (url) => {
    opened.push(url);
    if (failFirst && opened.length === 1) throw new Error("no handler");
  };
  return { opener, opened };
}

describe("openTailscale", () => {
  it("opens the Tailscale app when it is installed", async () => {
    const { opener, opened } = recorder(false);
    await openTailscale(opener, "ios");
    expect(opened).toEqual([TAILSCALE_URL]);
  });
  it("falls back to the store page when the app is not installed", async () => {
    const { opener, opened } = recorder(true);
    await openTailscale(opener, "ios");
    expect(opened).toEqual([TAILSCALE_URL, STORE_URL.ios]);
    const android = recorder(true);
    await openTailscale(android.opener, "android");
    expect(android.opened).toEqual([TAILSCALE_URL, STORE_URL.android]);
  });
});
