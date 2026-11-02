// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base64ToBytes, bytesToBase64, MAX_CLIPBOARD_BYTES } from "./terminal-bridge";
import { paneFit, pinchScale } from "./terminal-fit";
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
  write(data: Uint8Array | string, cb?: () => void) {
    log.push(typeof data === "string" ? `write:${data}` : "write:data");
    cb?.();
  }
  resize(cols: number, rows: number) {
    log.push(`resize:${cols}x${rows}`);
    this.cols = cols;
    this.rows = rows;
  }
  reset() {}
}
const fake = { term: undefined as unknown as FakeTerminal };
let posted: Posted[];
let log: string[];
// Each test runs a fresh page; the earlier pages' window listeners must not answer this one.
let listeners: Array<[string, EventListener]>;
let observed: () => void;
const box = () => document.getElementById("t") as HTMLElement;
const define = (el: HTMLElement, props: Record<string, number>) => {
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(el, key, { configurable: true, writable: true, value });
  }
};

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
    ResizeObserver: class {
      constructor(cb: () => void) {
        observed = cb;
      }
      observe() {}
    },
  });
  (window as unknown as { ReactNativeWebView: unknown }).ReactNativeWebView = {
    postMessage: (raw: string) => posted.push(JSON.parse(raw)),
  };
  define(box(), { clientWidth: 308, clientHeight: 300, scrollHeight: 1000, scrollTop: 0 });
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

const frame = (rows: number, cols: number, extra: Record<string, unknown> = {}) =>
  message({
    t: "out",
    b64: bytesToBase64(new TextEncoder().encode("screen")),
    rows,
    cols,
    ...extra,
  });
const fits = () => posted.filter((m) => m.t === "fit");
const touch = (type: string, points: Array<[number, number]>) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const list = points.map(([clientX, clientY]) => ({ clientX, clientY }));
  Object.assign(event, { touches: type === "touchend" ? [] : list, changedTouches: list });
  box().dispatchEvent(event);
  return event;
};

describe("terminal page: the pane's size", () => {
  it("takes the frame's size before writing the frame", () => {
    log.length = 0;
    frame(120, 97);
    expect(log.filter((l) => /^(resize|write)/.test(l))).toEqual([
      "resize:97x120",
      "write:\x1b[?25l",
      "write:data",
    ]);
    expect(fake.term.rows).toBe(120);
    expect(fake.term.cols).toBe(97);
  });

  it("does not resize when the frame has the size the terminal already has", () => {
    frame(120, 97);
    log.length = 0;
    frame(120, 97);
    expect(log.some((l) => l.startsWith("resize"))).toBe(false);
  });

  it("ignores a size outside 1..500 rows and 1..1000 cols, and a frame without one", () => {
    log.length = 0;
    frame(0, 80);
    frame(24, 1001);
    frame(24.5, 80);
    message({ t: "out", b64: "" });
    expect(log.some((l) => l.startsWith("resize"))).toBe(false);
    expect(fits()).toEqual([]);
    expect(log.filter((l) => l === "write:data").length).toBe(4);
  });

  it("never reports a size for the pty, however the page is laid out", () => {
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("orientationchange"));
    observed();
    frame(120, 97);
    expect(posted.some((m) => m.t === "size")).toBe(false);
  });
});

describe("terminal page: no cursor, no scrollback", () => {
  it("hides the cursor in the options and in what it writes, and keeps no scrollback", () => {
    expect(fake.term.options.cursorBlink).toBe(false);
    expect(fake.term.options.cursorInactiveStyle).toBe("none");
    expect(fake.term.options.scrollback).toBe(0);
    log.length = 0;
    message({ t: "out", b64: "" });
    expect(log.indexOf("write:\x1b[?25l")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("write:\x1b[?25l")).toBeLessThan(log.indexOf("write:data"));
  });
});

describe("terminal page: fit to the width", () => {
  it("keeps the user's font where the pane fits and says so", () => {
    frame(24, 30);
    expect(fake.term.options.fontSize).toBe(13);
    expect(fits().at(-1)).toEqual({ t: "fit", rows: 24, cols: 30, pct: 100 });
    expect(box().style.overflowX).toBe("hidden");
    expect(box().style.overflowY).toBe("auto");
  });

  it("scales the font to the container width, using the shared decision", () => {
    frame(120, 50);
    const expected = paneFit(300, 50, 13, 1);
    expect(fake.term.options.fontSize).toBe(expected.font);
    expect(expected.font).toBeLessThan(13);
    expect(fits().at(-1)).toEqual({ t: "fit", rows: 120, cols: 50, pct: expected.pct });
  });

  it("pans sideways only where the font would fall under 6", () => {
    frame(24, 200);
    expect(fake.term.options.fontSize).toBe(6);
    expect(box().style.overflowX).toBe("auto");
  });

  it("refits when the container changes width and when the user's font changes", () => {
    frame(120, 50);
    define(box(), { clientWidth: 208 });
    observed();
    expect(fake.term.options.fontSize).toBe(paneFit(200, 50, 13, 1).font);
    message({ t: "font", size: 10 });
    expect(fake.term.options.fontSize).toBe(paneFit(200, 50, 10, 1).font);
  });

  it("waits for a container with a width", () => {
    define(box(), { clientWidth: 0 });
    frame(120, 50);
    expect(fits()).toEqual([]);
    define(box(), { clientWidth: 308 });
    observed();
    expect(fits()).toHaveLength(1);
  });

  it("reports a fit once per change", () => {
    frame(120, 50);
    frame(120, 50);
    observed();
    expect(fits()).toHaveLength(1);
  });
});

describe("terminal page: pinch and double tap", () => {
  it("multiplies the scale by the fingers' spread, between 1x and 4x", () => {
    frame(24, 30);
    touch("touchstart", [
      [0, 0],
      [100, 0],
    ]);
    touch("touchmove", [
      [0, 0],
      [200, 0],
    ]);
    expect(fake.term.options.fontSize).toBe(paneFit(300, 30, 13, pinchScale(1, 100, 200)).font);
    touch("touchmove", [
      [0, 0],
      [5000, 0],
    ]);
    expect(fake.term.options.fontSize).toBe(13 * 4);
    expect(fits().at(-1)).toMatchObject({ pct: 400 });
    touch("touchmove", [
      [0, 0],
      [1, 0],
    ]);
    expect(fake.term.options.fontSize).toBe(13);
  });

  it("keeps the scale after the fingers lift, and a two-finger move is not a scroll", () => {
    frame(24, 30);
    touch("touchstart", [
      [0, 0],
      [100, 0],
    ]);
    const move = touch("touchmove", [
      [0, 0],
      [200, 0],
    ]);
    expect(move.defaultPrevented).toBe(true);
    touch("touchend", [[0, 0]]);
    expect(fake.term.options.fontSize).toBe(26);
  });

  it("a double tap resets the scale", () => {
    frame(24, 30);
    touch("touchstart", [
      [0, 0],
      [100, 0],
    ]);
    touch("touchmove", [
      [0, 0],
      [300, 0],
    ]);
    touch("touchend", [[0, 0]]);
    expect(fake.term.options.fontSize).toBe(39);
    touch("touchstart", [[10, 10]]);
    touch("touchend", [[10, 10]]);
    touch("touchstart", [[10, 10]]);
    touch("touchend", [[10, 10]]);
    expect(fake.term.options.fontSize).toBe(13);
  });

  it("a single tap does not reset it", () => {
    frame(24, 30);
    touch("touchstart", [
      [0, 0],
      [100, 0],
    ]);
    touch("touchmove", [
      [0, 0],
      [200, 0],
    ]);
    touch("touchend", [[0, 0]]);
    touch("touchstart", [[10, 10]]);
    touch("touchend", [[10, 10]]);
    expect(fake.term.options.fontSize).toBe(26);
  });
});

describe("terminal page: the bottom of the pane", () => {
  it("scrolls to the last row with each frame", () => {
    frame(120, 50);
    expect(box().scrollTop).toBe(1000);
  });

  it("stays at the bottom when the container shrinks, as under a soft keyboard", () => {
    frame(120, 50);
    define(box(), { clientHeight: 150, scrollHeight: 1200 });
    observed();
    expect(box().scrollTop).toBe(1200);
  });

  it("leaves the place alone once the person scrolled up", () => {
    frame(120, 50);
    define(box(), { scrollTop: 100 });
    box().dispatchEvent(new Event("scroll"));
    frame(120, 50);
    observed();
    expect(box().scrollTop).toBe(100);
    define(box(), { scrollTop: 700 });
    box().dispatchEvent(new Event("scroll"));
    frame(120, 50);
    expect(box().scrollTop).toBe(1000);
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
