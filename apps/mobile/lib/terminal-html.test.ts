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

  it("never lets remote output open a link, and starts in the app's theme", () => {
    expect(terminalHtml).toMatch(/linkHandler:\s*\{\s*activate\(\)\s*\{\s*\}/);
    expect(terminalHtml).toContain("window.__dark");
    expect(terminalHtml).toMatch(/msg\.t === "font"/);
    expect(terminalHtml).toMatch(/Number\.isFinite\(msg\.size\)/);
    expect(terminalHtml).toMatch(/typeof msg\.b64 === "string"/);
  });
});
