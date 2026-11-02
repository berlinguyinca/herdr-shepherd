import { describe, expect, it, vi } from "vitest";
import { bytesToBase64, MAX_CLIPBOARD_BYTES, type NativeMsg } from "./terminal-bridge";
import { createTerminalHandler } from "./terminal-view-handler";

const text = (value: string) => new TextEncoder().encode(value);

function setup(clipboard = "") {
  const sent: NativeMsg[] = [];
  const deps = {
    ready: vi.fn(),
    write: vi.fn(),
    setZoom: vi.fn(),
    onZoom: vi.fn(),
    onFit: vi.fn(),
    isLive: vi.fn(() => true),
    readClipboard: vi.fn(async () => clipboard),
    writeClipboard: vi.fn(async () => {}),
    send: (msg: NativeMsg) => void sent.push(msg),
    onCtrl: vi.fn(),
    onSelection: vi.fn(),
    onNotice: vi.fn(),
  };
  return { deps, sent, handler: createTerminalHandler(deps) };
}
const post = (handler: { onMessage(raw: string): void }, msg: unknown) =>
  handler.onMessage(JSON.stringify(msg));

describe("terminal view handler", () => {
  it("forwards typed bytes and ready, and shows how the pane is fitted", () => {
    const { deps, handler } = setup();
    post(handler, { t: "in", b64: bytesToBase64(text("ls")) });
    post(handler, { t: "fit", rows: 120, cols: 97, pct: 62 });
    post(handler, { t: "ready" });
    expect(deps.write).toHaveBeenCalledWith(text("ls"));
    expect(deps.onFit).toHaveBeenCalledWith({ rows: 120, cols: 97, pct: 62 });
    expect(deps.ready).toHaveBeenCalledTimes(1);
  });

  it("never resizes the pane for a size message from the page", () => {
    const { deps, handler } = setup();
    post(handler, { t: "size", rows: 24, cols: 80 });
    expect(deps.setZoom).not.toHaveBeenCalled();
    expect(deps.onFit).not.toHaveBeenCalled();
  });

  it("toggles the zoom: asks the client and shows the state", () => {
    const { deps, handler } = setup();
    handler.toggleZoom();
    expect(deps.setZoom).toHaveBeenLastCalledWith(true);
    expect(deps.onZoom).toHaveBeenLastCalledWith(true);
    handler.toggleZoom();
    expect(deps.setZoom).toHaveBeenLastCalledWith(false);
    expect(deps.onZoom).toHaveBeenLastCalledWith(false);
  });

  it("does nothing to the zoom unless the terminal is live", () => {
    const { deps, handler } = setup();
    deps.isLive.mockReturnValue(false);
    handler.toggleZoom();
    expect(deps.setZoom).not.toHaveBeenCalled();
    expect(deps.onZoom).not.toHaveBeenCalled();
    deps.isLive.mockReturnValue(true);
    handler.toggleZoom();
    expect(deps.setZoom).toHaveBeenLastCalledWith(true);
  });

  it("ignores malformed messages and undecodable input", () => {
    const { deps, handler } = setup();
    handler.onMessage("nope");
    post(handler, { t: "in", b64: "!!!not base64!!!" });
    post(handler, { t: "fit", rows: 0, cols: 80, pct: 50 });
    expect(deps.write).not.toHaveBeenCalled();
    expect(deps.onFit).not.toHaveBeenCalled();
  });

  it("resets the Ctrl toggle when the page used it", () => {
    const { deps, handler } = setup();
    handler.toggleCtrl();
    expect(deps.onCtrl).toHaveBeenLastCalledWith(true);
    post(handler, { t: "ctrlUsed" });
    expect(deps.onCtrl).toHaveBeenLastCalledWith(false);
    handler.pressKey("c");
    expect(deps.write).toHaveBeenCalledWith(text("c"));
  });

  it("sends ctrl:false to the page after a row key spends Ctrl", () => {
    const { deps, sent, handler } = setup();
    handler.toggleCtrl();
    expect(sent).toEqual([{ t: "ctrl", on: true }]);
    handler.pressKey("c");
    expect(deps.write).toHaveBeenCalledWith(Uint8Array.of(0x03));
    expect(sent.at(-1)).toEqual({ t: "ctrl", on: false });
    expect(deps.onCtrl).toHaveBeenLastCalledWith(false);
    handler.pressKey("c");
    expect(deps.write).toHaveBeenLastCalledWith(text("c"));
    expect(sent).toHaveLength(2);
  });

  it("switches the arrows to SS3 when the page reports application cursor mode", () => {
    const { deps, handler } = setup();
    handler.pressKey("Up");
    expect(deps.write).toHaveBeenLastCalledWith(text("\x1b[A"));
    post(handler, { t: "appCursor", on: true });
    handler.pressKey("Up");
    expect(deps.write).toHaveBeenLastCalledWith(text("\x1bOA"));
    post(handler, { t: "appCursor", on: false });
    handler.pressKey("Up");
    expect(deps.write).toHaveBeenLastCalledWith(text("\x1b[A"));
  });

  it("answers a paste request by reading the clipboard and sending a paste message", async () => {
    const { deps, sent, handler } = setup("héllo");
    post(handler, { t: "pasteRequest" });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(deps.readClipboard).toHaveBeenCalledTimes(1);
    expect(sent[0]).toEqual({ t: "paste", b64: bytesToBase64(text("héllo")) });
  });

  it("clears a pending Ctrl before pasting, so pasted text is never a control byte", async () => {
    const { deps, sent, handler } = setup("c");
    handler.toggleCtrl();
    sent.length = 0;
    await handler.paste();
    expect(sent).toEqual([
      { t: "ctrl", on: false },
      { t: "paste", b64: bytesToBase64(text("c")) },
    ]);
    expect(deps.onCtrl).toHaveBeenLastCalledWith(false);
  });

  it("sends nothing for an empty clipboard or a failing read", async () => {
    const empty = setup("");
    await empty.handler.paste();
    expect(empty.sent).toEqual([]);
    const failing = setup();
    failing.deps.readClipboard.mockRejectedValueOnce(new Error("denied"));
    await failing.handler.paste();
    expect(failing.sent).toEqual([]);
  });

  it("shows a notice instead of pasting more than the cap", async () => {
    const { deps, sent, handler } = setup("a".repeat(MAX_CLIPBOARD_BYTES + 1));
    await handler.paste();
    expect(sent).toEqual([]);
    expect(deps.onNotice).toHaveBeenCalledTimes(1);
  });

  it("writes copied text to the clipboard, and has the page copy on the Copy button", () => {
    const { deps, sent, handler } = setup();
    post(handler, { t: "copy", text: "echo hi" });
    expect(deps.writeClipboard).toHaveBeenCalledWith("echo hi");
    handler.copy();
    expect(sent).toEqual([{ t: "copy" }]);
  });

  it("drops copied text over the cap and shows the notice for a page's own refusal", () => {
    const { deps, handler } = setup();
    post(handler, { t: "copy", text: "a".repeat(MAX_CLIPBOARD_BYTES + 1) });
    expect(deps.writeClipboard).not.toHaveBeenCalled();
    post(handler, { t: "tooLarge" });
    expect(deps.onNotice).toHaveBeenCalledTimes(1);
  });

  it("reports the selection so Copy shows only while there is one", () => {
    const { deps, handler } = setup();
    post(handler, { t: "selection", has: true });
    expect(deps.onSelection).toHaveBeenLastCalledWith(true);
    post(handler, { t: "selection", has: false });
    expect(deps.onSelection).toHaveBeenLastCalledWith(false);
  });
});
