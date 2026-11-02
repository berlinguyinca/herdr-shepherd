// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base64ToBytes, bytesToBase64, MAX_CLIPBOARD_BYTES } from "./terminal-bridge";
import { terminalHtml } from "./terminal-html.generated";
import { controlByte } from "./terminal-keys";

// Runs the generated page's own scripts (the control-byte helper and the page) against a fake
// xterm, so the page's message handling is tested as shipped.
const scripts = [...terminalHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
const [helperSource = "", pageSource = ""] = scripts.slice(-2);

type Posted = { t: string; [key: string]: unknown };
class FakeTerminal {
  textarea = document.createElement("textarea");
  rows = 24;
  cols = 80;
  options: Record<string, unknown>;
  modes = { applicationCursorKeysMode: false };
  selection = "";
  pasted: string[] = [];
  onDataCb: (data: string) => void = () => {};
  onSelectionCb: () => void = () => {};
  keyHandler: (event: Partial<KeyboardEvent>) => boolean = () => true;
  constructor(options: Record<string, unknown>) {
    this.options = options;
    fake.term = this;
  }
  loadAddon() {}
  open() {
    document.body.append(this.textarea);
  }
  onData(cb: (data: string) => void) {
    this.onDataCb = cb;
  }
  onBinary() {}
  onSelectionChange(cb: () => void) {
    this.onSelectionCb = cb;
  }
  attachCustomKeyEventHandler(cb: (event: Partial<KeyboardEvent>) => boolean) {
    this.keyHandler = cb;
  }
  hasSelection() {
    return this.selection.length > 0;
  }
  getSelection() {
    return this.selection;
  }
  focus() {
    this.textarea.focus();
  }
  paste(text: string) {
    this.pasted.push(text);
    this.onDataCb(text);
  }
  write(_data: Uint8Array, cb?: () => void) {
    cb?.();
  }
  reset() {}
}
const fake = { term: undefined as unknown as FakeTerminal };
let posted: Posted[];
let log: string[];
// Each test runs a fresh page; the earlier pages' window listeners must not answer this one.
let listeners: Array<[string, EventListener]>;

const message = (msg: unknown) =>
  window.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(msg) }));
const sentInputs = () =>
  posted.filter((m) => m.t === "in").map((m) => Array.from(base64ToBytes(m.b64 as string)));
const text = (value: string) => Array.from(new TextEncoder().encode(value));

beforeEach(() => {
  document.body.innerHTML = '<div id="t"></div>';
  posted = [];
  log = [];
  listeners = [];
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation((type, fn, opts) => {
    listeners.push([type, fn as EventListener]);
    add(type, fn as EventListener, opts);
  });
  vi.spyOn(document, "addEventListener").mockImplementation(() => {});
  // A laid-out page; the zero-size tests change it.
  for (const side of ["clientWidth", "clientHeight"]) {
    Object.defineProperty(document.body, side, { configurable: true, value: 300 });
  }
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => {
    run();
    return 0;
  });
  Object.assign(globalThis, {
    Terminal: FakeTerminal,
    FitAddon: {
      // Ten points a cell, so a collapsed page fits to nothing, as the real addon would.
      FitAddon: class {
        fit() {
          fake.term.rows = Math.floor(document.body.clientHeight / 10);
          fake.term.cols = Math.floor(document.body.clientWidth / 10);
        }
      },
    },
    ResizeObserver: class {
      observe() {}
    },
  });
  (window as unknown as { ReactNativeWebView: unknown }).ReactNativeWebView = {
    postMessage: (raw: string) => posted.push(JSON.parse(raw)),
  };
  new Function(`${helperSource}\n${pageSource}`)();
  posted.length = 0;
  const area = fake.term.textarea;
  for (const name of ["blur", "focus"] as const) {
    const original = area[name].bind(area);
    area[name] = () => {
      log.push(name);
      original();
    };
  }
  const setAttribute = area.setAttribute.bind(area);
  area.setAttribute = (key: string, value: string) => {
    if (key === "inputmode") log.push(`inputmode:${value}`);
    setAttribute(key, value);
  };
});
afterEach(() => {
  for (const [type, fn] of listeners) window.removeEventListener(type, fn);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("terminal page: soft keyboard Ctrl", () => {
  it("maps with the same table as keyBytes, and everything else passes through", () => {
    message({ t: "ctrl", on: true });
    const cases = ["c", "C", "[", "\\", "]", "^", "_", " ", "@", "?", "é", "😀", "7"];
    for (const char of cases) {
      message({ t: "ctrl", on: true });
      fake.term.onDataCb(char);
    }
    const expected = cases.map((char) => {
      const byte = controlByte(char);
      return byte === undefined ? text(char) : [byte];
    });
    expect(sentInputs()).toEqual(expected);
    expect(sentInputs()[0]).toEqual([0x03]);
  });

  it("spends Ctrl on the next input and tells native, then types plain", () => {
    message({ t: "ctrl", on: true });
    fake.term.onDataCb("c");
    fake.term.onDataCb("c");
    expect(posted.map((m) => m.t)).toEqual(["ctrlUsed", "in", "in"]);
    expect(sentInputs()).toEqual([[0x03], text("c")]);
  });

  it("does not turn pasted text into a control byte", () => {
    message({ t: "ctrl", on: true });
    message({ t: "paste", b64: bytesToBase64(new TextEncoder().encode("c")) });
    expect(posted.map((m) => m.t)).toEqual(["ctrlUsed", "in"]);
    expect(sentInputs()).toEqual([text("c")]);
    expect(fake.term.pasted).toEqual(["c"]);
  });
});

describe("terminal page: size", () => {
  const resize = () => window.dispatchEvent(new Event("resize"));
  const setBody = (width: number, height: number) => {
    Object.defineProperty(document.body, "clientWidth", { configurable: true, value: width });
    Object.defineProperty(document.body, "clientHeight", { configurable: true, value: height });
  };

  it("ignores a fit while the page has no width or no height, and reports once it has both", () => {
    setBody(0, 400);
    resize();
    setBody(300, 0);
    resize();
    expect(posted.filter((m) => m.t === "size")).toEqual([]);
    setBody(200, 100);
    resize();
    expect(posted.filter((m) => m.t === "size")).toEqual([{ t: "size", rows: 10, cols: 20 }]);
  });
});

describe("terminal page: blur", () => {
  it("drops the input mode to none and blurs the textarea", () => {
    message({ t: "keyboard", on: true });
    log.length = 0;
    message({ t: "blur" });
    expect(fake.term.textarea.getAttribute("inputmode")).toBe("none");
    expect(log).toContain("blur");
    expect(document.activeElement).not.toBe(fake.term.textarea);
  });
});

describe("terminal page: soft keyboard toggle", () => {
  it("turning on blurs, sets the input mode, then focuses", () => {
    fake.term.focus();
    log.length = 0;
    message({ t: "keyboard", on: true });
    const blur = log.indexOf("blur");
    const text = log.lastIndexOf("inputmode:text");
    const focus = log.lastIndexOf("focus");
    expect(blur).toBeGreaterThanOrEqual(0);
    expect(text).toBeGreaterThan(blur);
    expect(focus).toBeGreaterThan(text);
    expect(fake.term.textarea.getAttribute("inputmode")).toBe("text");
    expect(document.activeElement).toBe(fake.term.textarea);
  });

  it("turning off hides the keyboard but leaves xterm focused for a hardware keyboard", () => {
    message({ t: "keyboard", on: true });
    log.length = 0;
    message({ t: "keyboard", on: false });
    expect(fake.term.textarea.getAttribute("inputmode")).toBe("none");
    expect(log.indexOf("inputmode:none")).toBeLessThan(log.lastIndexOf("focus"));
    expect(document.activeElement).toBe(fake.term.textarea);
  });

  it("a system dismissal resets the input mode, so a later focus cannot raise the keyboard", () => {
    message({ t: "keyboard", on: true });
    fake.term.textarea.blur();
    expect(fake.term.textarea.getAttribute("inputmode")).toBe("none");
    message({ t: "focus" });
    expect(fake.term.textarea.getAttribute("inputmode")).toBe("none");
  });
});

describe("terminal page: clipboard", () => {
  const keydown = (key: string) => {
    const preventDefault = vi.fn();
    const handled = fake.term.keyHandler({ type: "keydown", metaKey: true, key, preventDefault });
    return { handled, preventDefault };
  };

  it("copies a selection on Cmd-C and on a copy message", () => {
    fake.term.selection = "echo hi";
    expect(keydown("c").handled).toBe(false);
    message({ t: "copy" });
    expect(posted).toEqual([
      { t: "copy", text: "echo hi" },
      { t: "copy", text: "echo hi" },
    ]);
  });

  it("never posts a selection over the cap, in characters or in bytes", () => {
    fake.term.selection = "a".repeat(MAX_CLIPBOARD_BYTES + 1);
    keydown("c");
    fake.term.selection = "€".repeat(Math.floor(MAX_CLIPBOARD_BYTES / 3) + 1);
    message({ t: "copy" });
    expect(posted).toEqual([{ t: "tooLarge" }, { t: "tooLarge" }]);
  });

  it("asks native for the clipboard on Cmd-V and stops the browser's own paste", () => {
    const { handled, preventDefault } = keydown("v");
    expect(handled).toBe(false);
    expect(preventDefault).toHaveBeenCalled();
    expect(posted).toEqual([{ t: "pasteRequest" }]);
  });

  it("ignores a paste message over the cap and says so", () => {
    message({ t: "paste", b64: "A".repeat(Math.ceil((MAX_CLIPBOARD_BYTES * 4) / 3) + 8) });
    expect(fake.term.pasted).toEqual([]);
    expect(posted).toEqual([{ t: "tooLarge" }]);
  });

  it("reports the selection once per change and the application cursor mode", () => {
    fake.term.selection = "x";
    fake.term.onSelectionCb();
    fake.term.onSelectionCb();
    fake.term.selection = "";
    fake.term.onSelectionCb();
    expect(posted.filter((m) => m.t === "selection")).toEqual([
      { t: "selection", has: true },
      { t: "selection", has: false },
    ]);
    fake.term.modes.applicationCursorKeysMode = true;
    message({ t: "out", b64: "" });
    expect(posted.at(-1)).toEqual({ t: "appCursor", on: true });
  });
});
