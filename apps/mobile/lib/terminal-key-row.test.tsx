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
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
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
  onPaste: noop,
  onCopy: noop,
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
const byId = (id: string) => host.querySelector(`[data-testid="terminal-key-${id}"]`);

it("renders every row key with a test id and an accessibility label", () => {
  render();
  for (const key of KEY_ROW) expect(byId(key), key).not.toBeNull();
  expect(byId("Esc")?.getAttribute("aria-label")).toBe("Escape");
  expect(byId("|")?.getAttribute("aria-label")).toBe("Pipe");
  expect(byId("Left")?.textContent).toBe("←");
  expect(byId("keyboard")?.getAttribute("aria-label")).toBe("Show keyboard");
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
  expect(byId("keyboard")?.getAttribute("aria-label")).toBe("Hide keyboard");
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
