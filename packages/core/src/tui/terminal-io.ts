import type { TerminalFrame } from "@rakazo/contracts";

/** The bridge takes 64 KB per input call; stay well below it. */
export const INPUT_CHUNK_BYTES = 32 * 1024;
export const CTRL_RIGHT_BRACKET = 0x1d;
const CLEAR_SCREEN = "\u001b[H\u001b[2J";

export const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
export const fromBase64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64"));

export function chunkBytes(bytes: Uint8Array, size = INPUT_CHUNK_BYTES): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += size) chunks.push(bytes.subarray(at, at + size));
  return chunks;
}

export type InputCall = { data: string; n: number };

/** Numbers input calls of one terminalId from 1, in order; the bridge types only the next one. */
export function createInputSequencer(): { next(bytes: Uint8Array): InputCall[] } {
  let n = 0;
  return {
    next: (bytes) => chunkBytes(bytes).map((chunk) => ({ data: toBase64(chunk), n: ++n })),
  };
}

export type DetachResult = { forward: Uint8Array; detach: boolean };

/**
 * Keystroke filter for an attached terminal. Ctrl-] is the escape: Ctrl-] then q detaches,
 * Ctrl-] twice sends one literal Ctrl-], Ctrl-] then anything else drops the Ctrl-] and sends
 * that key. The state survives chunk boundaries.
 */
export function createDetachFilter(): { feed(bytes: Uint8Array): DetachResult } {
  let armed = false;
  return {
    feed(bytes) {
      const out: number[] = [];
      for (const byte of bytes) {
        if (!armed) {
          if (byte === CTRL_RIGHT_BRACKET) armed = true;
          else out.push(byte);
          continue;
        }
        armed = false;
        if (byte === 0x71 || byte === 0x51) return { forward: Uint8Array.from(out), detach: true };
        out.push(byte);
      }
      return { forward: Uint8Array.from(out), detach: false };
    },
  };
}

export type FrameAction =
  | { kind: "skip" }
  | { kind: "paint"; seq: number; bytes: Uint8Array; rows?: number; cols?: number }
  | { kind: "end"; seq: number; message: string };

/**
 * One whole-screen frame to what the viewer does next. Frames at or below `lastSeq` were already
 * seen. Each painted frame clears first, because the bridge sends the complete screen.
 */
export function interpretFrame(frame: TerminalFrame, lastSeq: number): FrameAction {
  if (frame.seq <= lastSeq) return { kind: "skip" };
  if (frame.taken_over) {
    return { kind: "end", seq: frame.seq, message: "Another client opened this terminal." };
  }
  if (frame.ended) {
    const why = frame.reason ? ` (${frame.reason})` : "";
    const exit = typeof frame.exit === "number" ? ` exit ${frame.exit}` : "";
    return { kind: "end", seq: frame.seq, message: `Terminal ended${exit}${why}.` };
  }
  if (!frame.data) return { kind: "skip" };
  const screen = fromBase64(frame.data);
  const head = Buffer.from(CLEAR_SCREEN);
  const bytes = new Uint8Array(head.length + screen.length);
  bytes.set(head, 0);
  bytes.set(screen, head.length);
  return {
    kind: "paint",
    seq: frame.seq,
    bytes,
    ...(frame.rows !== undefined ? { rows: frame.rows } : {}),
    ...(frame.cols !== undefined ? { cols: frame.cols } : {}),
  };
}
