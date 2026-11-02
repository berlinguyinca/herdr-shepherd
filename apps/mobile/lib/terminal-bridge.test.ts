import { MAX_FONT_SCALE } from "@rakazo/ui-tokens";
import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  createOutputBatcher,
  decodeFromWeb,
  encodeToWeb,
  type NativeMsg,
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
    expect(terminalFontSize(0.5)).toBe(Math.round(TERMINAL_FONT_SIZE * 0.5));
    expect(terminalFontSize(5)).toBe(Math.round(TERMINAL_FONT_SIZE * MAX_FONT_SCALE));
    expect(terminalFontSize(Number.NaN)).toBe(TERMINAL_FONT_SIZE);
  });
});
