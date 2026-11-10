import type { NativeMsg } from "./terminal-bridge";
import { base64ToBytes, decodeFromWeb, exceedsClipboardCap, pasteMessage } from "./terminal-bridge";
import type { KeyName } from "./terminal-keys";
import { pressRowKey } from "./terminal-keys";

export type TerminalHandlerDeps = {
  ready(): void;
  write(bytes: Uint8Array): void;
  /** Asks the relay to zoom the pane, or to stop. */
  setZoom(on: boolean): void;
  /** The zoom toggle changed: show it. */
  onZoom(on: boolean): void;
  /** The terminal is live: only then can the pane be zoomed. */
  isLive(): boolean;
  /** How the page fits the pane: its size and the percent of the font it got. */
  onFit(fit: { rows: number; cols: number; pct: number }): void;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): unknown;
  send(msg: NativeMsg): void;
  /** The sticky Ctrl toggle changed: show it. */
  onCtrl(on: boolean): void;
  onSelection(has: boolean): void;
  /** Something was too large to copy or paste. */
  onNotice(): void;
};

/**
 * What the terminal view does with the page's messages and the key row's taps. It holds the
 * state they share (the sticky Ctrl, the terminal's cursor mode); everything outside it
 * (clipboard, the bridge, the session) comes in through `deps`.
 */
export function createTerminalHandler(deps: TerminalHandlerDeps) {
  let ctrl = false;
  let applicationCursor = false;
  let zoom = false;

  const setCtrl = (on: boolean) => {
    ctrl = on;
    deps.onCtrl(on);
  };
  // The page is told too, for a Ctrl it has pending on the soft keyboard.
  const setCtrlAndPage = (on: boolean) => {
    setCtrl(on);
    deps.send({ t: "ctrl", on });
  };

  async function paste() {
    // Pasted text is never a control byte.
    if (ctrl) setCtrlAndPage(false);
    let text: string;
    try {
      text = await deps.readClipboard();
    } catch {
      return;
    }
    if (exceedsClipboardCap(text)) {
      deps.onNotice();
      return;
    }
    const message = pasteMessage(text);
    if (message) deps.send(message);
  }

  return {
    paste,
    copy: () => deps.send({ t: "copy" }),
    toggleCtrl: () => setCtrlAndPage(!ctrl),
    toggleZoom() {
      if (!deps.isLive()) return;
      zoom = !zoom;
      deps.setZoom(zoom);
      deps.onZoom(zoom);
    },
    pressKey(key: KeyName) {
      const pressed = pressRowKey(ctrl, key, { applicationCursor });
      if (pressed.bytes.length > 0) deps.write(pressed.bytes);
      if (ctrl) setCtrlAndPage(pressed.ctrl);
    },
    onMessage(raw: string) {
      const msg = decodeFromWeb(raw);
      if (!msg) return;
      switch (msg.t) {
        case "ready":
          deps.ready();
          break;
        case "in":
          try {
            deps.write(base64ToBytes(msg.b64));
          } catch {
            // Not base64: nothing to type.
          }
          break;
        case "fit":
          deps.onFit({ rows: msg.rows, cols: msg.cols, pct: msg.pct });
          break;
        case "copy":
          void deps.writeClipboard(msg.text);
          break;
        case "ctrlUsed":
          setCtrl(false);
          break;
        case "selection":
          deps.onSelection(msg.has);
          break;
        case "appCursor":
          applicationCursor = msg.on;
          break;
        case "pasteRequest":
          void paste();
          break;
        case "tooLarge":
          deps.onNotice();
          break;
      }
    },
  };
}
