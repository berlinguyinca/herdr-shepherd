import { MAX_FONT_SCALE } from "@rakazo/ui-tokens";
import type { TerminalOutput } from "./terminal";

/** Native to page. `out` is terminal output; `clear` wipes the screen before a replay. */
export type NativeMsg =
  | { t: "out"; b64: string }
  | { t: "clear" }
  | { t: "theme"; dark: boolean }
  | { t: "focus" };

/** Page to native: typed bytes, the fitted size, load done, and selected text to copy. */
export type WebMsg =
  | { t: "in"; b64: string }
  | { t: "size"; rows: number; cols: number }
  | { t: "ready" }
  | { t: "copy"; text: string };

export const encodeToWeb = (msg: NativeMsg): string => JSON.stringify(msg);

const isSize = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

/** Parses what the page posted; anything malformed or unknown is null, never an exception. */
export function decodeFromWeb(raw: string): WebMsg | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const msg = json as Record<string, unknown>;
  switch (msg.t) {
    case "in":
      return typeof msg.b64 === "string" ? { t: "in", b64: msg.b64 } : null;
    case "size":
      return isSize(msg.rows) && isSize(msg.cols)
        ? { t: "size", rows: msg.rows, cols: msg.cols }
        : null;
    case "ready":
      return { t: "ready" };
    case "copy":
      return typeof msg.text === "string" ? { t: "copy", text: msg.text } : null;
    default:
      return null;
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Turns terminal output into as few messages as possible: everything that arrives within one
 * frame goes out as one `out`, with a `clear` kept in order between the data around it. Nothing
 * is sent until the page is ready; what arrived before is held and sent together.
 * `schedule` runs a callback on the next frame and returns its canceller.
 */
export function createOutputBatcher(
  send: (msg: NativeMsg) => void,
  schedule: (run: () => void) => () => void,
) {
  let pending: TerminalOutput[] = [];
  let ready = false;
  let cancel: (() => void) | undefined;

  const flush = () => {
    cancel = undefined;
    const items = pending;
    pending = [];
    let run: Uint8Array[] = [];
    const sendRun = () => {
      if (run.length > 0) send({ t: "out", b64: bytesToBase64(concat(run)) });
      run = [];
    };
    for (const item of items) {
      if (item.kind === "data") run.push(item.data);
      else {
        sendRun();
        send({ t: "clear" });
      }
    }
    sendRun();
  };
  const arm = () => {
    if (ready && pending.length > 0) cancel ??= schedule(flush);
  };

  return {
    push(output: TerminalOutput) {
      pending.push(output);
      arm();
    },
    setReady(next: boolean) {
      ready = next;
      arm();
    },
    dispose() {
      cancel?.();
      cancel = undefined;
      pending = [];
      ready = false;
    },
  };
}

export const TERMINAL_FONT_SIZE = 13;

/** The terminal's font size in px: the base size scaled by the user's text size, capped like all app text. */
export function terminalFontSize(fontScale: number): number {
  const scale = Number.isFinite(fontScale) ? Math.min(fontScale, MAX_FONT_SCALE) : 1;
  return Math.round(TERMINAL_FONT_SIZE * scale);
}
