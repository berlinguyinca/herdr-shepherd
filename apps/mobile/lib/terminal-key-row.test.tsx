// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TerminalKeyRow } from "../components/terminal-key-row";
import { KEY_ROW, REPEAT_DELAY_MS, REPEAT_INTERVAL_MS } from "./terminal-keys";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-native", () => ({
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  View: ({
    children,
    testID,
    style,
  }: {
    children?: ReactNode;
    testID?: string;
    style?: unknown;
  }) => (
    <div data-testid={testID} data-style={JSON.stringify(style)}>
      {children}
    </div>
  ),
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Pressable: ({
    children,
    testID,
    accessibilityLabel,
    accessibilityRole,
    accessibilityState,
    onPress,
    onPressIn,
    onPressOut,
  }: {
    children?: ReactNode;
    testID?: string;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityState?: { checked?: boolean };
    onPress?: () => void;
    onPressIn?: () => void;
    onPressOut?: () => void;
  }) => (
    <button
      type="button"
      data-testid={testID}
      aria-label={accessibilityLabel}
      data-role={accessibilityRole}
      data-checked={String(accessibilityState?.checked)}
      onClick={onPress}
      onMouseDown={onPressIn}
      onMouseUp={onPressOut}
    >
      {children}
    </button>
  ),
}));
vi.mock("../lib/i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("../lib/native", () => ({
  useMobileTokens: () => ({
    primary: "p",
    primaryForeground: "pf",
    card: "c",
    border: "b",
    background: "bg",
    foreground: "fg",
  }),
}));
vi.mock("../components/native-symbol", () => ({ NativeSymbol: () => <i data-icon /> }));

const noop = () => {};
const props = {
  ctrl: false,
  keyboardOn: false,
  hasSelection: false,
  compact: false,
  onKey: noop,
  onToggleCtrl: noop,
  onToggleKeyboard: noop,
  zoom: false,
  onToggleZoom: noop,
  onPaste: noop,
  onCopy: noop,
  bottomInset: 0,
};

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});
const render = (over: Partial<typeof props> = {}) =>
  act(() => root.render(<TerminalKeyRow {...props} {...over} />));
const byId = (id: string) =>
  host.querySelector(`[data-testid="${id === "row" ? "terminal-key-row" : `terminal-key-${id}`}"]`);

it("renders every row key with a test id and an accessibility label", () => {
  render();
  for (const key of KEY_ROW) expect(byId(key), key).not.toBeNull();
  expect(byId("Esc")?.getAttribute("aria-label")).toBe("Escape");
  expect(byId("|")?.getAttribute("aria-label")).toBe("Pipe");
  expect(byId("Left")?.textContent).toBe("←");
  expect(byId("keyboard")?.getAttribute("aria-label")).toBe("Keyboard");
  expect(byId("keyboard")?.querySelector("[data-icon]")).not.toBeNull();
});

it("reports Ctrl and the keyboard toggle as switches with their state", () => {
  render();
  expect(byId("Ctrl")?.getAttribute("data-role")).toBe("switch");
  expect(byId("Ctrl")?.getAttribute("data-checked")).toBe("false");
  expect(byId("keyboard")?.getAttribute("data-role")).toBe("switch");
  render({ ctrl: true, keyboardOn: true });
  expect(byId("Ctrl")?.getAttribute("data-checked")).toBe("true");
  expect(byId("keyboard")?.getAttribute("data-checked")).toBe("true");
  expect(byId("keyboard")?.getAttribute("aria-label")).toBe("Keyboard");
  expect(byId("Tab")?.getAttribute("data-role")).toBe("button");
});

it("shows Copy only while there is a selection, and Paste always", () => {
  render();
  expect(byId("copy")).toBeNull();
  expect(byId("paste")).not.toBeNull();
  render({ hasSelection: true });
  expect(byId("copy")).not.toBeNull();
});

it("calls the handlers for Paste, Copy, Ctrl and the keyboard toggle", () => {
  const onPaste = vi.fn();
  const onCopy = vi.fn();
  const onToggleCtrl = vi.fn();
  const onToggleKeyboard = vi.fn();
  render({ hasSelection: true, onPaste, onCopy, onToggleCtrl, onToggleKeyboard });
  const click = (id: string) =>
    act(() => {
      byId(id)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  click("paste");
  click("copy");
  click("Ctrl");
  click("keyboard");
  expect(onPaste).toHaveBeenCalledTimes(1);
  expect(onCopy).toHaveBeenCalledTimes(1);
  expect(onToggleCtrl).toHaveBeenCalledTimes(1);
  expect(onToggleKeyboard).toHaveBeenCalledTimes(1);
});

it("releases the key repeat when the row unmounts", () => {
  vi.useFakeTimers();
  const onKey = vi.fn();
  render({ onKey });
  act(() => {
    byId("Left")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
  expect(onKey).toHaveBeenCalledTimes(1);
  act(() => {
    vi.advanceTimersByTime(REPEAT_DELAY_MS + REPEAT_INTERVAL_MS);
  });
  const before = onKey.mock.calls.length;
  expect(before).toBeGreaterThan(1);
  act(() => root.unmount());
  vi.advanceTimersByTime(5000);
  expect(onKey).toHaveBeenCalledTimes(before);
  root = createRoot(host);
});

const fire = (id: string, ...events: string[]) =>
  act(() => {
    for (const type of events) byId(id)?.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  });

it("a plain activation of a repeating key (TalkBack) sends it once", () => {
  vi.useFakeTimers();
  const onKey = vi.fn();
  render({ onKey });
  fire("Tab", "click");
  expect(onKey).toHaveBeenCalledTimes(1);
  expect(onKey).toHaveBeenCalledWith("Tab");
});

it("a touch tap sends once, not once for the press and again for the activation", () => {
  vi.useFakeTimers();
  const onKey = vi.fn();
  render({ onKey });
  fire("Tab", "mousedown", "mouseup", "click");
  act(() => {
    vi.advanceTimersByTime(REPEAT_DELAY_MS / 2);
  });
  expect(onKey).toHaveBeenCalledTimes(1);
});

it("pads the bottom by the inset it is given, so the home indicator clears the keys", () => {
  render({ bottomInset: 34 });
  const bar = JSON.parse(byId("row")?.getAttribute("data-style") ?? "[]") as Array<
    Record<string, unknown>
  >;
  expect(bar.some((style) => style.paddingBottom === 38)).toBe(true);
  render({ bottomInset: 0 });
  const flat = JSON.parse(byId("row")?.getAttribute("data-style") ?? "[]") as Array<
    Record<string, unknown>
  >;
  expect(flat.some((style) => style.paddingBottom === 4)).toBe(true);
});

it("has a Zoom pane switch that shows its state and calls its handler", () => {
  const onToggleZoom = vi.fn();
  render({ onToggleZoom });
  expect(byId("zoom")?.getAttribute("aria-label")).toBe("Zoom pane");
  expect(byId("zoom")?.getAttribute("data-role")).toBe("switch");
  expect(byId("zoom")?.getAttribute("data-checked")).toBe("false");
  act(() => {
    byId("zoom")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(onToggleZoom).toHaveBeenCalledTimes(1);
  render({ zoom: true });
  expect(byId("zoom")?.getAttribute("data-checked")).toBe("true");
});
