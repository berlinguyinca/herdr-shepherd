import { MAX_FONT_SCALE } from "@rakazo/ui-tokens";
import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  clampFontSize,
  createLoadGate,
  createOutputBatcher,
  decodeFromWeb,
  encodeToWeb,
  exceedsClipboardCap,
  MAX_CLIPBOARD_BYTES,
  MAX_FONT_PX,
  MIN_FONT_PX,
  type NativeMsg,
  OUT_CHUNK_BYTES,
  type PageState,
  pageReducer,
  pasteMessage,
  TERMINAL_FONT_SIZE,
  terminalFontSize,
} from "./terminal-bridge";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (msg: NativeMsg | undefined) =>
  msg?.t === "out" ? new TextDecoder().decode(base64ToBytes(msg.b64)) : msg;

describe("terminal bridge codec", () => {
  it("round-trips every web message", () => {
    for (const msg of [
      { t: "in", b64: "aGk=" },
      { t: "fit", rows: 24, cols: 80, pct: 62 },
      { t: "ready" },
      { t: "copy", text: "echo hi\nsecond line" },
    ] as const) {
      expect(decodeFromWeb(JSON.stringify(msg))).toEqual(msg);
    }
  });

  it("encodes native messages as JSON the page can parse", () => {
    const msgs: NativeMsg[] = [
      { t: "out", b64: "aGk=" },
      { t: "out", b64: "aGk=", rows: 120, cols: 97 },
      { t: "clear" },
      { t: "theme", dark: true },
      { t: "focus" },
      { t: "blur" },
      { t: "font", size: 15 },
    ];
    for (const msg of msgs) expect(JSON.parse(encodeToWeb(msg))).toEqual(msg);
  });

  it("ignores malformed or unknown input without throwing", () => {
    for (const raw of [
      "",
      "not json",
      "null",
      "42",
      '"in"',
      "[]",
      "{}",
      '{"t":"nope"}',
      '{"t":"in"}',
      '{"t":"in","b64":7}',
      '{"t":"fit","rows":"24","cols":80,"pct":50}',
      '{"t":"fit","rows":0,"cols":80,"pct":50}',
      '{"t":"fit","rows":24.5,"cols":80,"pct":50}',
      '{"t":"fit","rows":24,"cols":80}',
      '{"t":"fit","rows":24,"cols":80,"pct":-1}',
      '{"t":"copy"}',
      '{"t":"out","b64":"aGk="}',
    ]) {
      expect(decodeFromWeb(raw), raw).toBeNull();
    }
    expect(decodeFromWeb(undefined as unknown as string)).toBeNull();
  });

  it("rejects a fit outside 1..500 rows and 1..1000 cols", () => {
    const fitMsg = (rows: unknown, cols: unknown) =>
      decodeFromWeb(JSON.stringify({ t: "fit", rows, cols, pct: 100 }));
    expect(fitMsg(500, 1000)).toEqual({ t: "fit", rows: 500, cols: 1000, pct: 100 });
    expect(fitMsg(1, 1)).toEqual({ t: "fit", rows: 1, cols: 1, pct: 100 });
    for (const [rows, cols] of [
      [0, 80],
      [24, 0],
      [501, 80],
      [24, 1001],
      [1e9, 80],
      [-1, 80],
      [24, null],
    ]) {
      expect(fitMsg(rows, cols), `${rows}x${cols}`).toBeNull();
    }
  });

  it("no longer knows a size message: the page does not resize the pane", () => {
    expect(decodeFromWeb('{"t":"size","rows":24,"cols":80}')).toBeNull();
  });

  it("carries arbitrary bytes through base64", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(base64ToBytes(bytesToBase64(all))).toEqual(all);
    expect(bytesToBase64(new Uint8Array())).toBe("");
    expect(base64ToBytes("")).toEqual(new Uint8Array());
  });

  it("carries a 1 MB message", () => {
    const big = Uint8Array.from({ length: 1024 * 1024 }, (_, i) => (i * 31) % 256);
    const raw = encodeToWeb({ t: "out", b64: bytesToBase64(big) });
    const back = JSON.parse(raw) as { b64: string };
    expect(base64ToBytes(back.b64)).toEqual(big);
    const msg = decodeFromWeb(JSON.stringify({ t: "in", b64: back.b64 }));
    expect(msg?.t === "in" && base64ToBytes(msg.b64)).toEqual(big);
  });
});

describe("output batcher", () => {
  const setup = () => {
    const sent: NativeMsg[] = [];
    let frame: (() => void) | undefined;
    let frames = 0;
    const batcher = createOutputBatcher(
      (msg) => sent.push(msg),
      (run) => {
        frames += 1;
        frame = run;
        return () => {
          if (frame === run) frame = undefined;
        };
      },
    );
    return {
      sent,
      batcher,
      frames: () => frames,
      tick: () => {
        const run = frame;
        frame = undefined;
        run?.();
      },
    };
  };
  it("sends nothing until the page is ready, then everything in one message", () => {
    const { sent, batcher, tick } = setup();
    batcher.push({ kind: "data", data: bytes("ab") });
    batcher.push({ kind: "data", data: bytes("cd") });
    tick();
    expect(sent).toEqual([]);
    batcher.setReady(true);
    tick();
    expect(sent.map(text)).toEqual(["abcd"]);
  });

  it("coalesces the chunks of one frame and schedules one frame", () => {
    const { sent, batcher, tick, frames } = setup();
    batcher.setReady(true);
    for (const part of ["a", "b", "c", "d"]) batcher.push({ kind: "data", data: bytes(part) });
    expect(frames()).toBe(1);
    expect(sent).toEqual([]);
    tick();
    expect(sent.map(text)).toEqual(["abcd"]);
    tick();
    expect(sent).toHaveLength(1);
  });

  it("a clear drops what is pending before it, and keeps what follows", () => {
    const { sent, batcher, tick } = setup();
    batcher.setReady(true);
    batcher.push({ kind: "data", data: bytes("old") });
    batcher.push({ kind: "clear" });
    batcher.push({ kind: "data", data: bytes("new") });
    batcher.push({ kind: "data", data: bytes("er") });
    tick();
    expect(sent.map(text)).toEqual([{ t: "clear" }, "newer"]);
  });

  it("drops what is pending after dispose", () => {
    const { sent, batcher, tick } = setup();
    batcher.setReady(true);
    batcher.push({ kind: "data", data: bytes("x") });
    batcher.dispose();
    tick();
    expect(sent).toEqual([]);
  });
});

describe("terminal font size", () => {
  it("follows the text size setting up to the app's cap", () => {
    expect(terminalFontSize(1)).toBe(TERMINAL_FONT_SIZE);
    expect(terminalFontSize(1.3)).toBe(Math.round(TERMINAL_FONT_SIZE * 1.3));
    expect(terminalFontSize(0.5)).toBe(MIN_FONT_PX);
    expect(terminalFontSize(5)).toBe(Math.round(TERMINAL_FONT_SIZE * MAX_FONT_SCALE));
    expect(terminalFontSize(Number.NaN)).toBe(TERMINAL_FONT_SIZE);
  });
});

describe("page state", () => {
  const start: PageState = { generation: 0, ready: false, dropped: false, uncapped: false };

  it("treats the first ready as the page loading and any later one as a reload", () => {
    const first = pageReducer(start, "ready");
    expect(first).toEqual({ generation: 0, ready: true, dropped: false, uncapped: false });
    expect(pageReducer(first, "ready")).toEqual({
      generation: 1,
      ready: false,
      dropped: false,
      uncapped: false,
    });
  });

  it("starts over when the web process is gone", () => {
    const live = pageReducer(start, "ready");
    expect(pageReducer(live, "gone")).toEqual({
      generation: 1,
      ready: false,
      dropped: false,
      uncapped: false,
    });
    expect(pageReducer(start, "gone").generation).toBe(1);
  });

  it("asks for a replay when output was dropped before the page was ready", () => {
    const dropped = pageReducer(start, "overflow");
    expect(dropped).toEqual({ generation: 0, ready: false, dropped: true, uncapped: false });
    expect(pageReducer(dropped, "ready")).toEqual({
      generation: 1,
      ready: false,
      dropped: false,
      uncapped: true,
    });
  });

  it("does not remount twice for overflow: the next page buffers without a cap", () => {
    const remounted = pageReducer(pageReducer(start, "overflow"), "ready");
    expect(remounted.uncapped).toBe(true);
    // A second flood before this page is ready changes nothing.
    const again = pageReducer({ ...remounted, generation: 0 }, "overflow");
    expect(again.dropped).toBe(false);
    expect(pageReducer(again, "ready")).toEqual({
      generation: 0,
      ready: true,
      dropped: false,
      uncapped: true,
    });
  });

  it("still remounts for a later reload or a dead web process, and caps again after that", () => {
    const uncapped = { ...start, uncapped: true };
    const live = pageReducer(uncapped, "ready");
    expect(pageReducer(live, "ready")).toEqual({
      generation: 1,
      ready: false,
      dropped: false,
      uncapped: false,
    });
    expect(pageReducer(uncapped, "gone")).toEqual({
      generation: 1,
      ready: false,
      dropped: false,
      uncapped: false,
    });
  });
});

describe("load gate", () => {
  it("allows the initial load and refuses every later top-frame navigation", () => {
    const gate = createLoadGate();
    expect(gate({ url: "about:blank", isTopFrame: true })).toBe(true);
    expect(gate({ url: "about:blank", isTopFrame: true })).toBe(false);
    expect(gate({ url: "https://example.com/", isTopFrame: true })).toBe(false);
    expect(gate({ url: "javascript:alert(1)" })).toBe(false);
  });

  it("refuses a request that is not for the top frame, and does not let it use the initial load", () => {
    const gate = createLoadGate();
    expect(gate({ url: "about:blank", isTopFrame: false })).toBe(false);
    expect(gate({ url: "about:blank", isTopFrame: true })).toBe(true);
  });

  it("refuses an initial load that is not about:", () => {
    expect(createLoadGate()({ url: "https://example.com/", isTopFrame: true })).toBe(false);
  });
});

describe("output batcher limits", () => {
  const run = (options?: { maxPendingBytes?: number }) => {
    const sent: NativeMsg[] = [];
    let frame: (() => void) | undefined;
    let overflows = 0;
    const batcher = createOutputBatcher(
      (msg) => sent.push(msg),
      (fn) => {
        frame = fn;
        return () => {
          frame = undefined;
        };
      },
      { ...options, onOverflow: () => (overflows += 1) },
    );
    return {
      sent,
      batcher,
      overflows: () => overflows,
      tick: () => {
        const fn = frame;
        frame = undefined;
        fn?.();
      },
    };
  };

  it("splits one large output into messages of at most 256 KB", () => {
    const { sent, batcher, tick } = run();
    batcher.setReady(true);
    const big = new Uint8Array(OUT_CHUNK_BYTES * 2 + 10).fill(7);
    batcher.push({ kind: "data", data: big });
    tick();
    const sizes = sent.map((msg) => (msg.t === "out" ? base64ToBytes(msg.b64).length : -1));
    expect(OUT_CHUNK_BYTES).toBe(256 * 1024);
    expect(sizes).toEqual([OUT_CHUNK_BYTES, OUT_CHUNK_BYTES, 10]);
  });

  it("tells the page the pane's size with the first message of a frame only", () => {
    const { sent, batcher, tick } = run();
    batcher.setReady(true);
    batcher.push({ kind: "clear" });
    batcher.push({
      kind: "data",
      data: new Uint8Array(OUT_CHUNK_BYTES + 1).fill(7),
      rows: 120,
      cols: 97,
    });
    tick();
    expect(sent.map((msg) => msg.t)).toEqual(["clear", "out", "out"]);
    expect(sent[1]).toMatchObject({ rows: 120, cols: 97 });
    expect(sent[2]).not.toHaveProperty("rows");
    expect(sent[2]).not.toHaveProperty("cols");
  });

  it("keeps only the newest frame: a frame replaces the screen", () => {
    const { sent, batcher, tick } = run();
    batcher.setReady(true);
    batcher.push({ kind: "data", data: bytes("a"), rows: 10, cols: 20, reset: true });
    batcher.push({ kind: "data", data: bytes("b"), rows: 30, cols: 40, reset: true });
    batcher.push({ kind: "data", data: bytes("c"), reset: true });
    batcher.push({ kind: "data", data: bytes("d"), reset: true, rows: 50, cols: 60 });
    tick();
    expect(sent.map(text)).toEqual(["d"]);
    expect(sent).toMatchObject([{ t: "out", rows: 50, cols: 60 }]);
  });

  it("keeps the data that follows a frame, and a frame after a clear", () => {
    const { sent, batcher, tick } = run();
    batcher.setReady(true);
    batcher.push({ kind: "data", data: bytes("w"), rows: 1, cols: 2 });
    batcher.push({ kind: "data", data: bytes("x"), reset: true, rows: 1, cols: 2 });
    batcher.push({ kind: "data", data: bytes("y") });
    tick();
    expect(sent.map(text)).toEqual(["xy"]);
    batcher.push({ kind: "clear" });
    batcher.push({ kind: "data", data: bytes("z"), reset: true, rows: 3, cols: 4 });
    tick();
    expect(sent.slice(1).map((m) => m.t)).toEqual(["clear", "out"]);
  });

  it("a flood of frames before the page is ready never overflows: only the newest counts", () => {
    const { sent, batcher, tick, overflows } = run({ maxPendingBytes: 10 });
    for (let i = 0; i < 50; i += 1) {
      batcher.push({ kind: "data", data: new Uint8Array(6), rows: 5, cols: 5, reset: true });
    }
    expect(overflows()).toBe(0);
    batcher.setReady(true);
    tick();
    expect(sent).toHaveLength(1);
  });

  it("holds output while paused, keeps only the newest frame, and sends it on resume", () => {
    const { sent, batcher, tick } = run();
    batcher.setReady(true);
    batcher.setPaused(true);
    batcher.push({ kind: "data", data: bytes("a"), rows: 1, cols: 1, reset: true });
    batcher.push({ kind: "data", data: bytes("b"), rows: 2, cols: 2, reset: true });
    tick();
    expect(sent).toEqual([]);
    batcher.setPaused(false);
    tick();
    expect(sent.map(text)).toEqual(["b"]);
  });

  it("counts paused output against the limit like output for a page that is not ready", () => {
    const { batcher, overflows } = run({ maxPendingBytes: 10 });
    batcher.setReady(true);
    batcher.setPaused(true);
    batcher.push({ kind: "data", data: new Uint8Array(6) });
    batcher.push({ kind: "data", data: new Uint8Array(6) });
    expect(overflows()).toBe(1);
  });

  it("drops everything and reports it when too much waits for a page that is not ready", () => {
    const { sent, batcher, tick, overflows } = run({ maxPendingBytes: 10 });
    batcher.push({ kind: "data", data: new Uint8Array(6) });
    expect(overflows()).toBe(0);
    batcher.push({ kind: "data", data: new Uint8Array(6) });
    expect(overflows()).toBe(1);
    batcher.setReady(true);
    tick();
    expect(sent).toEqual([]);
  });

  it("does not count output against the limit once the page is ready", () => {
    const { sent, batcher, tick, overflows } = run({ maxPendingBytes: 10 });
    batcher.setReady(true);
    batcher.push({ kind: "data", data: new Uint8Array(50) });
    tick();
    expect(overflows()).toBe(0);
    expect(sent).toHaveLength(1);
  });
});

describe("font message", () => {
  it("clamps the size to 8..32", () => {
    expect([MIN_FONT_PX, MAX_FONT_PX]).toEqual([8, 32]);
    expect(clampFontSize(15)).toBe(15);
    expect(clampFontSize(2)).toBe(8);
    expect(clampFontSize(400)).toBe(32);
    expect(clampFontSize(12.6)).toBe(13);
    expect(clampFontSize(Number.NaN)).toBe(TERMINAL_FONT_SIZE);
  });
});

describe("key row messages", () => {
  it("round-trips the new web messages", () => {
    for (const msg of [
      { t: "ctrlUsed" },
      { t: "selection", has: true },
      { t: "selection", has: false },
      { t: "appCursor", on: true },
      { t: "pasteRequest" },
      { t: "tooLarge" },
    ] as const) {
      expect(decodeFromWeb(JSON.stringify(msg))).toEqual(msg);
    }
  });

  it("encodes the new native messages as JSON the page can parse", () => {
    const msgs: NativeMsg[] = [
      { t: "ctrl", on: true },
      { t: "keyboard", on: false },
      { t: "paste", b64: "aGk=" },
      { t: "copy" },
    ];
    for (const msg of msgs) expect(JSON.parse(encodeToWeb(msg))).toEqual(msg);
  });

  it("rejects malformed new web messages", () => {
    for (const raw of [
      '{"t":"selection"}',
      '{"t":"selection","has":"yes"}',
      '{"t":"appCursor","on":1}',
      '{"t":"appCursor"}',
    ]) {
      expect(decodeFromWeb(raw), raw).toBeNull();
    }
  });

  it("caps copied text at 1 MB of UTF-8", () => {
    expect(MAX_CLIPBOARD_BYTES).toBe(1024 * 1024);
    const copy = (text: string) => decodeFromWeb(JSON.stringify({ t: "copy", text }));
    const atCap = "a".repeat(MAX_CLIPBOARD_BYTES);
    expect(copy(atCap)).toEqual({ t: "copy", text: atCap });
    expect(copy(`${atCap}a`)).toBeNull();
    // 3 bytes per character: under the cap in characters, over it in bytes.
    expect(copy("€".repeat(Math.floor(MAX_CLIPBOARD_BYTES / 3) + 1))).toBeNull();
  });

  it("builds a paste message from clipboard text, or nothing when it is empty or over the cap", () => {
    expect(pasteMessage("hi")).toEqual({ t: "paste", b64: "aGk=" });
    expect(pasteMessage("é")).toEqual({ t: "paste", b64: bytesToBase64(bytes("é")) });
    expect(pasteMessage("")).toBeNull();
    const atCap = "a".repeat(MAX_CLIPBOARD_BYTES);
    expect(pasteMessage(atCap)).not.toBeNull();
    expect(pasteMessage(`${atCap}a`)).toBeNull();
  });
});

describe("clipboard cap", () => {
  it("measures UTF-8 bytes, not characters", () => {
    expect(exceedsClipboardCap("a".repeat(MAX_CLIPBOARD_BYTES))).toBe(false);
    expect(exceedsClipboardCap("a".repeat(MAX_CLIPBOARD_BYTES + 1))).toBe(true);
    expect(exceedsClipboardCap("€".repeat(Math.floor(MAX_CLIPBOARD_BYTES / 3) + 1))).toBe(true);
    expect(exceedsClipboardCap("")).toBe(false);
  });
});
