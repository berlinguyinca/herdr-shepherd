import { MAX_FONT_SCALE } from "@rakazo/ui-tokens";
import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  clampFontSize,
  clampSize,
  createLoadGate,
  createOutputBatcher,
  decodeFromWeb,
  encodeToWeb,
  MAX_FONT_PX,
  MIN_FONT_PX,
  type NativeMsg,
  OUT_CHUNK_BYTES,
  type PageState,
  pageReducer,
  TERMINAL_FONT_SIZE,
  terminalFontSize,
} from "./terminal-bridge";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("terminal bridge codec", () => {
  it("round-trips every web message", () => {
    for (const msg of [
      { t: "in", b64: "aGk=" },
      { t: "size", rows: 24, cols: 80 },
      { t: "ready" },
      { t: "copy", text: "echo hi\nsecond line" },
    ] as const) {
      expect(decodeFromWeb(JSON.stringify(msg))).toEqual(msg);
    }
  });

  it("encodes native messages as JSON the page can parse", () => {
    const msgs: NativeMsg[] = [
      { t: "out", b64: "aGk=" },
      { t: "clear" },
      { t: "theme", dark: true },
      { t: "focus" },
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
      '{"t":"size","rows":"24","cols":80}',
      '{"t":"size","rows":0,"cols":80}',
      '{"t":"size","rows":24.5,"cols":80}',
      '{"t":"copy"}',
      '{"t":"out","b64":"aGk="}',
    ]) {
      expect(decodeFromWeb(raw), raw).toBeNull();
    }
    expect(decodeFromWeb(undefined as unknown as string)).toBeNull();
  });

  it("rejects a size outside 1..500 rows and 1..1000 cols", () => {
    const size = (rows: unknown, cols: unknown) =>
      decodeFromWeb(JSON.stringify({ t: "size", rows, cols }));
    expect(size(500, 1000)).toEqual({ t: "size", rows: 500, cols: 1000 });
    expect(size(1, 1)).toEqual({ t: "size", rows: 1, cols: 1 });
    for (const [rows, cols] of [
      [0, 80],
      [24, 0],
      [501, 80],
      [24, 1001],
      [1e9, 80],
      [24, 1e9],
      [-1, 80],
      [24, -5],
      [24.5, 80],
      [24, null],
    ]) {
      expect(size(rows, cols), `${rows}x${cols}`).toBeNull();
    }
    expect(decodeFromWeb('{"t":"size","rows":NaN,"cols":80}')).toBeNull();
  });

  it("clamps a size for the client", () => {
    expect(clampSize(24, 80)).toEqual({ rows: 24, cols: 80 });
    expect(clampSize(0, 0)).toEqual({ rows: 1, cols: 1 });
    expect(clampSize(501, 1001)).toEqual({ rows: 500, cols: 1000 });
    expect(clampSize(1e9, 1e9)).toEqual({ rows: 500, cols: 1000 });
    expect(clampSize(-3, -3)).toEqual({ rows: 1, cols: 1 });
    expect(clampSize(24.6, 80.2)).toEqual({ rows: 25, cols: 80 });
    expect(clampSize(Number.NaN, 80)).toBeNull();
    expect(clampSize(24, Number.POSITIVE_INFINITY)).toBeNull();
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
  const text = (msg: NativeMsg | undefined) =>
    msg?.t === "out" ? new TextDecoder().decode(base64ToBytes(msg.b64)) : msg;

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

  it("keeps a clear in order between the data around it", () => {
    const { sent, batcher, tick } = setup();
    batcher.setReady(true);
    batcher.push({ kind: "data", data: bytes("old") });
    batcher.push({ kind: "clear" });
    batcher.push({ kind: "data", data: bytes("new") });
    batcher.push({ kind: "data", data: bytes("er") });
    tick();
    expect(sent.map(text)).toEqual(["old", { t: "clear" }, "newer"]);
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
  const start: PageState = { generation: 0, ready: false, dropped: false };

  it("treats the first ready as the page loading and any later one as a reload", () => {
    const first = pageReducer(start, "ready");
    expect(first).toEqual({ generation: 0, ready: true, dropped: false });
    expect(pageReducer(first, "ready")).toEqual({ generation: 1, ready: false, dropped: false });
  });

  it("starts over when the web process is gone", () => {
    const live = pageReducer(start, "ready");
    expect(pageReducer(live, "gone")).toEqual({ generation: 1, ready: false, dropped: false });
    expect(pageReducer(start, "gone").generation).toBe(1);
  });

  it("asks for a replay when output was dropped before the page was ready", () => {
    const dropped = pageReducer(start, "overflow");
    expect(dropped).toEqual({ generation: 0, ready: false, dropped: true });
    expect(pageReducer(dropped, "ready")).toEqual({ generation: 1, ready: false, dropped: false });
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
