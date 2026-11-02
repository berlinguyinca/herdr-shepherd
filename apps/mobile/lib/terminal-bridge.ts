import { MAX_FONT_SCALE } from "@rakazo/ui-tokens";
import type { TerminalOutput } from "./terminal";
import { validPane } from "./terminal-fit";

/**
 * Native to page. `out` is terminal output (`rows` and `cols` are the pane's size, taken before
 * the data is written); `clear` wipes the screen before a replay.
 */
export type NativeMsg =
  | { t: "out"; b64: string; rows?: number; cols?: number }
  | { t: "clear" }
  | { t: "theme"; dark: boolean }
  | { t: "focus" }
  // The terminal is no longer shown: drop the soft keyboard and the focus.
  | { t: "blur" }
  | { t: "font"; size: number }
  // A pending Ctrl for the next character typed on the soft keyboard.
  | { t: "ctrl"; on: boolean }
  // Show or hide the soft keyboard: the input mode of xterm's textarea, and its focus.
  | { t: "keyboard"; on: boolean }
  // Clipboard text for xterm's paste path, so bracketed paste applies.
  | { t: "paste"; b64: string }
  // The Copy button: answer with a `copy` of the selection.
  | { t: "copy" };

/**
 * Page to native: typed bytes, how the pane is shown (its size and the percent of the font it got:
 * a caption, never a pty size), load done, selected text to copy, a pending Ctrl
 * used up, whether xterm has a selection, the terminal's application cursor mode, and a Cmd-V.
 */
export type WebMsg =
  | { t: "in"; b64: string }
  | { t: "fit"; rows: number; cols: number; pct: number }
  | { t: "ready" }
  | { t: "copy"; text: string }
  | { t: "ctrlUsed" }
  | { t: "selection"; has: boolean }
  | { t: "appCursor"; on: boolean }
  | { t: "pasteRequest" }
  // The page refused a selection over the cap.
  | { t: "tooLarge" };

export const encodeToWeb = (msg: NativeMsg): string => JSON.stringify(msg);

/** Pasted or copied text is cut off here: it is held whole in memory and sent in one message. */
export const MAX_CLIPBOARD_BYTES = 1024 * 1024;

const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/** True for text over the cap; the length check first keeps a huge string from being encoded. */
export const exceedsClipboardCap = (text: string): boolean =>
  text.length > MAX_CLIPBOARD_BYTES || utf8Length(text) > MAX_CLIPBOARD_BYTES;

/** The `paste` message for clipboard text; null for nothing to paste or more than the cap. */
export function pasteMessage(text: string): NativeMsg | null {
  if (!text || exceedsClipboardCap(text)) return null;
  return { t: "paste", b64: bytesToBase64(new TextEncoder().encode(text)) };
}

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
    case "fit":
      return validPane(msg.rows, msg.cols) &&
        typeof msg.pct === "number" &&
        Number.isFinite(msg.pct) &&
        msg.pct >= 0
        ? { t: "fit", rows: msg.rows as number, cols: msg.cols as number, pct: msg.pct }
        : null;
    case "ready":
      return { t: "ready" };
    case "copy":
      return typeof msg.text === "string" && !exceedsClipboardCap(msg.text)
        ? { t: "copy", text: msg.text }
        : null;
    case "tooLarge":
      return { t: "tooLarge" };
    case "ctrlUsed":
      return { t: "ctrlUsed" };
    case "selection":
      return typeof msg.has === "boolean" ? { t: "selection", has: msg.has } : null;
    case "appCursor":
      return typeof msg.on === "boolean" ? { t: "appCursor", on: msg.on } : null;
    case "pasteRequest":
      return { t: "pasteRequest" };
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

/** One `out` message carries at most this many bytes. */
export const OUT_CHUNK_BYTES = 256 * 1024;
/** Output waiting for a page that is not ready yet is dropped beyond this. */
export const MAX_PENDING_BYTES = 2 * 1024 * 1024;

/**
 * Turns terminal output into as few messages as possible: everything that arrives within one
 * frame goes out as `out` messages of at most OUT_CHUNK_BYTES, with a `clear` kept in order
 * between the data around it. Nothing is sent until the page is ready; what arrived before is
 * held and sent together, unless it outgrows `maxPendingBytes`: then it is all dropped and
 * `onOverflow` runs, so the caller can have the screen replayed.
 * `schedule` runs a callback on the next frame and returns its canceller.
 */
export function createOutputBatcher(
  send: (msg: NativeMsg) => void,
  schedule: (run: () => void) => () => void,
  options: { maxPendingBytes?: number; onOverflow?: () => void } = {},
) {
  const { maxPendingBytes = MAX_PENDING_BYTES, onOverflow } = options;
  let pending: TerminalOutput[] = [];
  let pendingBytes = 0;
  let ready = false;
  let cancel: (() => void) | undefined;

  const flush = () => {
    cancel = undefined;
    const items = pending;
    pending = [];
    pendingBytes = 0;
    let run: Uint8Array[] = [];
    // The pane's size goes with the first message of a run only: the page resizes before writing.
    let size: { rows: number; cols: number } | undefined;
    const sendRun = () => {
      const bytes = concat(run);
      run = [];
      for (let at = 0; at < bytes.length; at += OUT_CHUNK_BYTES) {
        send({ t: "out", b64: bytesToBase64(bytes.subarray(at, at + OUT_CHUNK_BYTES)), ...size });
        size = undefined;
      }
      size = undefined;
    };
    for (const item of items) {
      if (item.kind === "data") {
        run.push(item.data);
        if (item.rows !== undefined && item.cols !== undefined) {
          size = { rows: item.rows, cols: item.cols };
        }
      } else {
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
      if (output.kind === "data") pendingBytes += output.data.length;
      pending.push(output);
      if (!ready && pendingBytes > maxPendingBytes) {
        pending = [];
        pendingBytes = 0;
        onOverflow?.();
        return;
      }
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
      pendingBytes = 0;
      ready = false;
    },
  };
}

/**
 * Where one page (one WebView mount) stands. A `ready` after the first means the page reloaded
 * and lost its screen; `gone` is the web process dying; `overflow` is output dropped while the
 * page was loading. All three end in a new generation: the view remounts, a new client opens
 * with seq 0 and the whole screen is replayed.
 */
export type PageState = {
  generation: number;
  ready: boolean;
  dropped: boolean;
  /** This mount follows an overflow remount: it buffers without a cap, so a flood cannot loop. */
  uncapped: boolean;
};
export type PageEvent = "ready" | "gone" | "overflow";

export function pageReducer(state: PageState, event: PageEvent): PageState {
  const next = { generation: state.generation + 1, ready: false, dropped: false, uncapped: false };
  if (event === "gone") return next;
  if (event === "overflow") return state.uncapped ? state : { ...state, dropped: true };
  if (state.dropped) return { ...next, uncapped: true };
  return state.ready ? next : { ...state, ready: true };
}

/**
 * For onShouldStartLoadWithRequest: the page's own load (top frame, about:) goes through once;
 * after that the WebView never navigates, whatever the remote output or the page asks for.
 */
export function createLoadGate() {
  let loaded = false;
  return (request: { url: string; isTopFrame?: boolean }): boolean => {
    if (loaded || request.isTopFrame === false || !request.url.startsWith("about:")) return false;
    loaded = true;
    return true;
  };
}

export const TERMINAL_FONT_SIZE = 13;

export const MIN_FONT_PX = 8;
export const MAX_FONT_PX = 32;

export function clampFontSize(size: number): number {
  if (!Number.isFinite(size)) return TERMINAL_FONT_SIZE;
  return Math.min(MAX_FONT_PX, Math.max(MIN_FONT_PX, Math.round(size)));
}

/** The terminal's font size in px: the base size scaled by the user's text size, capped like all app text. */
export function terminalFontSize(fontScale: number): number {
  const scale = Number.isFinite(fontScale) ? Math.min(fontScale, MAX_FONT_SCALE) : 1;
  return clampFontSize(TERMINAL_FONT_SIZE * scale);
}
