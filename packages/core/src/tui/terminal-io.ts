import type { TerminalFrame } from "@rakazo/contracts";
import { oneLine } from "./render.js";

/** The bridge takes 64 KB per input call; stay well below it. */
export const INPUT_CHUNK_BYTES = 32 * 1024;
export const CTRL_RIGHT_BRACKET = 0x1d;
/** Leaves alt screen, mouse, bracketed paste, attributes; shows the cursor. */
export const TERMINAL_RESTORE =
  "\u001b[?1049l\u001b[?1000;1002;1003;1006l\u001b[?2004l\u001b[0m\u001b[?25h";
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
    const why = frame.reason ? ` (${oneLine(frame.reason, 60)})` : "";
    const exit = typeof frame.exit === "number" ? ` exit ${frame.exit}` : "";
    return { kind: "end", seq: frame.seq, message: `Terminal ended${exit}${why}.` };
  }
  if (!frame.data) return { kind: "skip" };
  const screen = filterTerminalOutput(fromBase64(frame.data));
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

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CSI_QUERY_FINALS = new Set(["n", "c"]);
const C1 = new RegExp(`[${String.fromCharCode(0x80)}-${String.fromCharCode(0x9f)}]`, "g");
const ENQ = String.fromCharCode(5);
/** 8-bit introducers are rewritten to their ESC forms so the same rules (and drops) apply. */
const C1_AS_ESC: Record<string, string> = {
  "\u0090": "P",
  "\u0098": "X",
  "\u009b": "[",
  "\u009d": "]",
  "\u009e": "^",
  "\u009f": "_",
};
const C1_INTRODUCER = new RegExp(`[${Object.keys(C1_AS_ESC).join("")}]`, "g");

/**
 * Index just past a string-type sequence (OSC, DCS, APC, PM, SOS) that starts at `from`, which
 * ends at BEL (OSC only) or ST. An unterminated one swallows the rest of the frame.
 */
function endOfString(text: string, from: number, osc: boolean): number {
  for (let at = from; at < text.length; at++) {
    if (osc && text[at] === BEL) return at + 1;
    if (text[at] === ESC && text[at + 1] === "\\") return at + 2;
  }
  return text.length;
}

/** True for a CSI sequence that makes the terminal answer into stdin (a query), which we drop. */
function isCsiQuery(prefix: string, params: string, intermediate: string, final: string): boolean {
  if (CSI_QUERY_FINALS.has(final)) return true; // DSR (n), device attributes (c)
  if (final === "p" && intermediate.includes("$")) return true; // DECRQM
  if (final === "q" && prefix === ">") return true; // XTVERSION
  if (final === "u" && prefix === "?") return true; // keyboard protocol query
  if (final === "t") return /^(1[1-9]|2[0-9])(;|$)/.test(params) && params !== ""; // window reports
  return false;
}

/**
 * Removes what remote output could use to reach beyond the screen: every OSC (clipboard 52,
 * 1337, 50, 7, titles and links), DCS/APC/PM/SOS (including DECRQSS), 8-bit C1 controls, ENQ, and
 * queries the terminal would answer into the keyboard stream. Colors, cursor movement, scroll
 * regions, alt screen, and mode changes pass through.
 */
export function filterTerminalOutput(bytes: Uint8Array): Uint8Array {
  const text = Buffer.from(bytes)
    .toString("utf8")
    .replace(C1_INTRODUCER, (c) => `${ESC}${C1_AS_ESC[c] ?? ""}`)
    .replaceAll(C1, "")
    .replaceAll(ENQ, "");
  let out = "";
  for (let at = 0; at < text.length; ) {
    if (text[at] !== ESC) {
      out += text[at++];
      continue;
    }
    const kind = text[at + 1];
    if (kind === "]") at = endOfString(text, at + 2, true);
    else if (kind === "P" || kind === "_" || kind === "^" || kind === "X") {
      at = endOfString(text, at + 2, false);
    } else if (kind === "[") {
      const match = /^([<=>?]?)([0-9;:]*)([ -/]*)([@-~])/.exec(text.slice(at + 2, at + 258));
      if (!match) {
        at += 2; // malformed: drop the introducer, keep the rest as plain text
        continue;
      }
      const [whole, prefix = "", params = "", intermediate = "", final = ""] = match;
      if (!isCsiQuery(prefix, params, intermediate, final))
        out += text.slice(at, at + 2 + whole.length);
      at += 2 + whole.length;
    } else {
      out += ESC;
      at += 1;
    }
  }
  return new Uint8Array(Buffer.from(out));
}

/**
 * Drops from the keyboard stream a terminal's replies rather than keys: terminated OSC and DCS
 * strings, and device-attribute or mode replies. An unterminated ESC P or ESC ] stays, since
 * Alt-keys send it. Typed keys pass through.
 */
export function filterTerminalInput(bytes: Uint8Array): Uint8Array {
  const text = Buffer.from(bytes).toString("latin1");
  const cleaned = text
    .replace(new RegExp(`${ESC}[\\]P][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g"), "")
    .replace(new RegExp(`${ESC}\\[[?>=][0-9;:]*c`, "g"), "")
    .replace(new RegExp(`${ESC}\\[[?]?[0-9;:]*\\$y`, "g"), "");
  return new Uint8Array(Buffer.from(cleaned, "latin1"));
}
