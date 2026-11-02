/**
 * Bytes for the keys the terminal key row sends. Hardware keys never come through here: xterm.js
 * turns those into bytes in the page. A key is a name below, or any single character.
 */
export type NamedKey =
  | "Esc"
  | "Tab"
  | "Up"
  | "Down"
  | "Left"
  | "Right"
  | "Home"
  | "End"
  | "PgUp"
  | "PgDn"
  | "Enter"
  | "Backspace";
export type KeyName = NamedKey | "|" | "~" | "/" | "-" | (string & {});
export type KeyMods = { ctrl: boolean; alt: boolean; shift: boolean };

/** The row's keys, left to right. Ctrl is a sticky toggle, not a byte: see pressRowKey. */
export const KEY_ROW: KeyName[] = [
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
];

const ESC = 0x1b;
const encoder = new TextEncoder();
const ascii = (text: string) => encoder.encode(text);

const ARROW_LETTER: Record<string, string> = { Up: "A", Down: "B", Right: "C", Left: "D" };
const FIXED: Record<string, Uint8Array> = {
  Esc: Uint8Array.of(ESC),
  Tab: Uint8Array.of(0x09),
  Enter: Uint8Array.of(0x0d),
  Backspace: Uint8Array.of(0x7f),
  Home: ascii("\x1b[H"),
  End: ascii("\x1b[F"),
  PgUp: ascii("\x1b[5~"),
  PgDn: ascii("\x1b[6~"),
};

// control-byte:begin (the page inlines this function: see scripts/build-terminal-html.mjs)
/** The control byte for one character, or undefined when Ctrl does nothing to it. */
export function controlByte(char: string): number | undefined {
  if (char === "?") return 0x7f;
  if (char === " " || char === "@") return 0x00;
  if (char.length !== 1) return undefined;
  const code = char.charCodeAt(0);
  const folded = code >= 0x61 && code <= 0x7a ? code - 0x20 : code;
  return folded >= 0x40 && folded <= 0x5f ? folded & 0x1f : undefined;
}
// control-byte:end

function plainBytes(key: string, shift: boolean, applicationCursor: boolean): Uint8Array {
  const arrow = ARROW_LETTER[key];
  if (arrow) return ascii(`${applicationCursor ? "\x1bO" : "\x1b["}${arrow}`);
  if (applicationCursor && (key === "Home" || key === "End")) {
    return ascii(key === "Home" ? "\x1bOH" : "\x1bOF");
  }
  if (key === "Tab" && shift) return ascii("\x1b[Z");
  const fixed = FIXED[key];
  if (fixed) return fixed;
  return [...key].length === 1 ? ascii(key) : new Uint8Array(0);
}

/**
 * The bytes one key sends. Ctrl turns a letter or one of `[ \ ] ^ _ @ space ?` into its control
 * byte, Alt puts ESC in front, Shift only changes Tab; any other modifier combination sends the
 * plain key. An unknown name sends nothing. In application cursor mode Home and End are SS3
 * like the arrows. Alt+arrow is ESC before the arrow; xterm sends ESC [ 1 ; 3 D instead, which
 * the row does not expose.
 */
export function keyBytes(
  key: KeyName,
  mods: KeyMods,
  opts: { applicationCursor?: boolean } = {},
): Uint8Array {
  const control = mods.ctrl && [...key].length === 1 ? controlByte(key) : undefined;
  const base =
    control === undefined
      ? plainBytes(key, mods.shift, opts.applicationCursor === true)
      : Uint8Array.of(control);
  if (!mods.alt || base.length === 0) return base;
  const out = new Uint8Array(base.length + 1);
  out[0] = ESC;
  out.set(base, 1);
  return out;
}

/** One tap on a row key: its bytes under the sticky Ctrl, and Ctrl spent either way. */
export function pressRowKey(
  ctrl: boolean,
  key: KeyName,
  opts?: { applicationCursor?: boolean },
): { bytes: Uint8Array; ctrl: false } {
  return { bytes: keyBytes(key, { ctrl, alt: false, shift: false }, opts), ctrl: false };
}

export const REPEAT_DELAY_MS = 400;
export const REPEAT_INTERVAL_MS = 50;

const REPEATABLE = new Set<string>(["Up", "Down", "Left", "Right", "Backspace"]);
export const isRepeatable = (key: KeyName): boolean => REPEATABLE.has(key);

/**
 * Press-and-hold: `press` fires the key at once and, for a repeatable key, again every
 * REPEAT_INTERVAL_MS after REPEAT_DELAY_MS until `release`. A new press ends the one before.
 */
export function createKeyRepeater(fire: (key: KeyName) => void) {
  let delay: ReturnType<typeof setTimeout> | undefined;
  let every: ReturnType<typeof setInterval> | undefined;
  const release = () => {
    clearTimeout(delay);
    clearInterval(every);
    delay = undefined;
    every = undefined;
  };
  return {
    press(key: KeyName) {
      release();
      fire(key);
      if (!isRepeatable(key)) return;
      delay = setTimeout(() => {
        every = setInterval(() => fire(key), REPEAT_INTERVAL_MS);
        fire(key);
      }, REPEAT_DELAY_MS);
    },
    release,
  };
}

/** An iPad with no soft keyboard showing is typed on by a hardware keyboard: the row shrinks. */
export const compactKeyRow = (state: { isPad: boolean; softKeyboardVisible: boolean }): boolean =>
  state.isPad && !state.softKeyboardVisible;
