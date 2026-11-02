import { describe, expect, it, vi } from "vitest";
import {
  compactKeyRow,
  controlByte,
  createKeyRepeater,
  isRepeatable,
  KEY_ROW,
  type KeyName,
  keyBytes,
  pressRowKey,
  REPEAT_DELAY_MS,
  REPEAT_INTERVAL_MS,
} from "./terminal-keys";

const none = { ctrl: false, alt: false, shift: false };
const ctrl = { ...none, ctrl: true };
const alt = { ...none, alt: true };
const shift = { ...none, shift: true };
const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);
const key = (name: KeyName, mods = none, opts?: { applicationCursor?: boolean }) =>
  Array.from(keyBytes(name, mods, opts));

describe("keyBytes table", () => {
  it("sends the plain control keys", () => {
    expect(key("Esc")).toEqual([0x1b]);
    expect(key("Tab")).toEqual([0x09]);
    expect(key("Enter")).toEqual([0x0d]);
    expect(key("Backspace")).toEqual([0x7f]);
  });

  it("sends shift+Tab as the back-tab sequence", () => {
    expect(key("Tab", shift)).toEqual(Array.from(text("\x1b[Z")));
  });

  it("sends arrows as CSI, or SS3 in application cursor mode", () => {
    const csi = { Up: "A", Down: "B", Right: "C", Left: "D" } as const;
    for (const [name, letter] of Object.entries(csi)) {
      expect(key(name as KeyName)).toEqual(Array.from(text(`\x1b[${letter}`)));
      expect(key(name as KeyName, none, { applicationCursor: false })).toEqual(
        Array.from(text(`\x1b[${letter}`)),
      );
      expect(key(name as KeyName, none, { applicationCursor: true })).toEqual(
        Array.from(text(`\x1bO${letter}`)),
      );
    }
  });

  it("sends Home, End, PgUp and PgDn", () => {
    expect(key("Home")).toEqual(Array.from(text("\x1b[H")));
    expect(key("End")).toEqual(Array.from(text("\x1b[F")));
    expect(key("PgUp")).toEqual(Array.from(text("\x1b[5~")));
    expect(key("PgDn")).toEqual(Array.from(text("\x1b[6~")));
  });

  it("sends Home and End as SS3 in application cursor mode, like xterm", () => {
    expect(key("Home", none, { applicationCursor: true })).toEqual(Array.from(text("\x1bOH")));
    expect(key("End", none, { applicationCursor: true })).toEqual(Array.from(text("\x1bOF")));
    // PgUp and PgDn do not change with the mode.
    expect(key("PgUp", none, { applicationCursor: true })).toEqual(Array.from(text("\x1b[5~")));
  });

  it("sends the literal symbols and any single character as UTF-8", () => {
    for (const symbol of ["|", "~", "/", "-", "a", "Z", "7", "é", "€", "😀"]) {
      expect(keyBytes(symbol, none)).toEqual(text(symbol));
    }
  });

  it("turns ctrl+letter into its control byte", () => {
    expect(key("c", ctrl)).toEqual([0x03]);
    expect(key("a", ctrl)).toEqual([0x01]);
    expect(key("z", ctrl)).toEqual([0x1a]);
    expect(key("C", ctrl)).toEqual([0x03]);
    for (let code = 0x61; code <= 0x7a; code += 1) {
      expect(key(String.fromCharCode(code), ctrl)).toEqual([code & 0x1f]);
    }
  });

  it("maps the ctrl punctuation controls", () => {
    expect(key("[", ctrl)).toEqual([0x1b]);
    expect(key("\\", ctrl)).toEqual([0x1c]);
    expect(key("]", ctrl)).toEqual([0x1d]);
    expect(key("^", ctrl)).toEqual([0x1e]);
    expect(key("_", ctrl)).toEqual([0x1f]);
    expect(key(" ", ctrl)).toEqual([0x00]);
    expect(key("@", ctrl)).toEqual([0x00]);
    expect(key("?", ctrl)).toEqual([0x7f]);
  });

  it("prefixes ESC for alt, on keys and characters alike", () => {
    expect(key("b", alt)).toEqual([0x1b, 0x62]);
    expect(key("Backspace", alt)).toEqual([0x1b, 0x7f]);
    expect(key("Left", alt)).toEqual(Array.from(text("\x1b\x1b[D")));
    expect(key("Left", alt, { applicationCursor: true })).toEqual(Array.from(text("\x1b\x1bOD")));
    expect(key("c", { ctrl: true, alt: true, shift: false })).toEqual([0x1b, 0x03]);
    expect(key("é", alt)).toEqual([0x1b, 0xc3, 0xa9]);
  });

  it("falls back to the plain key for combinations it does not know", () => {
    expect(key("Up", ctrl)).toEqual(key("Up"));
    expect(key("Enter", ctrl)).toEqual(key("Enter"));
    expect(key("-", ctrl)).toEqual(key("-"));
    expect(key("é", ctrl)).toEqual(key("é"));
    expect(key("Home", shift)).toEqual(key("Home"));
    expect(key("a", shift)).toEqual(key("a"));
  });

  it("sends nothing for an unknown key name", () => {
    expect(key("NoSuchKey" as KeyName)).toEqual([]);
    expect(key("" as KeyName)).toEqual([]);
  });
});

describe("key row", () => {
  it("is Esc, Ctrl, Tab, the arrows and four symbols, in that order", () => {
    expect(KEY_ROW).toEqual([
      "Esc",
      "Ctrl",
      "Tab",
      "Left",
      "Down",
      "Up",
      "Right",
      "|",
      "~",
      "/",
      "-",
    ]);
  });

  it("applies a sticky Ctrl to the next key only", () => {
    expect(pressRowKey(true, "c")).toEqual({ bytes: bytes(0x03), ctrl: false });
    expect(pressRowKey(false, "c")).toEqual({ bytes: text("c"), ctrl: false });
    // Ctrl is spent even by a key it does not change.
    expect(pressRowKey(true, "Esc")).toEqual({ bytes: bytes(0x1b), ctrl: false });
  });

  it("follows the terminal's cursor mode", () => {
    expect(pressRowKey(false, "Up", { applicationCursor: true }).bytes).toEqual(text("\x1bOA"));
  });
});

describe("key repeat", () => {
  it("repeats arrows and Backspace only", () => {
    for (const name of ["Left", "Down", "Up", "Right", "Backspace"] as KeyName[]) {
      expect(isRepeatable(name), name).toBe(true);
    }
    for (const name of ["Esc", "Tab", "Enter", "|", "a", "Ctrl"] as KeyName[]) {
      expect(isRepeatable(name), name).toBe(false);
    }
  });

  it("fires once at once, then repeats after the delay until released", () => {
    vi.useFakeTimers();
    try {
      const fire = vi.fn();
      const repeater = createKeyRepeater(fire);
      repeater.press("Left");
      expect(fire).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(REPEAT_DELAY_MS - 1);
      expect(fire).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(fire).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(REPEAT_INTERVAL_MS * 3);
      expect(fire).toHaveBeenCalledTimes(5);
      repeater.release();
      vi.advanceTimersByTime(5000);
      expect(fire).toHaveBeenCalledTimes(5);
      expect(fire).toHaveBeenCalledWith("Left");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never repeats a key that is not repeatable, and stops with a new press", () => {
    vi.useFakeTimers();
    try {
      const fire = vi.fn();
      const repeater = createKeyRepeater(fire);
      repeater.press("Tab");
      vi.advanceTimersByTime(5000);
      expect(fire).toHaveBeenCalledTimes(1);
      repeater.press("Up");
      repeater.press("Down");
      fire.mockClear();
      vi.advanceTimersByTime(REPEAT_DELAY_MS + REPEAT_INTERVAL_MS);
      expect(fire.mock.calls.every(([name]) => name === "Down")).toBe(true);
      repeater.release();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("compact key row", () => {
  it("is compact on an iPad with no soft keyboard up, which means a hardware keyboard", () => {
    expect(compactKeyRow({ isPad: true, softKeyboardVisible: false })).toBe(true);
    expect(compactKeyRow({ isPad: true, softKeyboardVisible: true })).toBe(false);
    expect(compactKeyRow({ isPad: false, softKeyboardVisible: false })).toBe(false);
    expect(compactKeyRow({ isPad: false, softKeyboardVisible: true })).toBe(false);
  });
});

describe("controlByte", () => {
  it("is the one table: single code points only, everything else is undefined", () => {
    expect(controlByte("c")).toBe(0x03);
    expect(controlByte("C")).toBe(0x03);
    expect(controlByte("[")).toBe(0x1b);
    expect(controlByte(" ")).toBe(0x00);
    expect(controlByte("?")).toBe(0x7f);
    expect(controlByte("é")).toBeUndefined();
    expect(controlByte("😀")).toBeUndefined();
    expect(controlByte("ab")).toBeUndefined();
    expect(controlByte("")).toBeUndefined();
    expect(controlByte("1")).toBeUndefined();
  });
});
