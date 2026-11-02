import { describe, expect, it } from "vitest";
// @ts-expect-error the build script is plain JS
import { buildTerminalHtml } from "../scripts/build-terminal-html.mjs";
import { terminalHtml } from "./terminal-html.generated";

describe("terminal page", () => {
  it("is up to date: run `pnpm build:terminal` after changing xterm or the page script", () => {
    expect(terminalHtml === buildTerminalHtml()).toBe(true);
  });

  it("is one self-contained document that loads nothing", () => {
    expect(terminalHtml).toContain("<!doctype html>");
    expect(terminalHtml).not.toMatch(/<script[^>]*\ssrc=/i);
    expect(terminalHtml).not.toMatch(/<link[^>]*href=/i);
    expect(terminalHtml).not.toMatch(/@import|url\(\s*["']?https?:/i);
    expect(terminalHtml).toContain("ReactNativeWebView");
  });
});
