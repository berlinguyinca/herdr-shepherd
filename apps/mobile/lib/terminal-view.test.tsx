// @vitest-environment jsdom
import { act, forwardRef, type ReactNode, useImperativeHandle, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalView } from "../components/terminal-view";
import type { TerminalState } from "./terminal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type WebProps = {
  onMessage: (event: { nativeEvent: { data: string } }) => void;
  onContentProcessDidTerminate: () => void;
  dataDetectorTypes?: string;
};
const web = vi.hoisted(() => ({
  props: undefined as unknown,
  posted: [] as string[],
}));
const term = vi.hoisted(() => ({
  state: "live" as string,
  setState: (_state: string) => {},
  reopen: vi.fn(),
  resize: vi.fn(),
  calls: [] as Array<{ agentId: string; retain?: { current: boolean } }>,
}));
const keyboard = vi.hoisted(() => ({ visible: false }));
const batchers = vi.hoisted(() => ({
  options: [] as Array<{ maxPendingBytes?: number; onOverflow?: () => void }>,
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios", isPad: false },
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  useWindowDimensions: () => ({ fontScale: 1 }),
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
  Text: ({
    children,
    testID,
    accessibilityLiveRegion,
  }: {
    children?: ReactNode;
    testID?: string;
    accessibilityLiveRegion?: string;
  }) => (
    <span data-testid={testID} data-live={accessibilityLiveRegion}>
      {children}
    </span>
  ),
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  useKeyboardState: (select: (state: { isVisible: boolean }) => unknown) =>
    select({ isVisible: keyboard.visible }),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));
vi.mock("react-native-webview", () => ({
  default: forwardRef((props: unknown, ref) => {
    web.props = props;
    useImperativeHandle(ref, () => ({
      postMessage: (message: string) => web.posted.push(message),
    }));
    return <div data-testid="webview" />;
  }),
}));
vi.mock("expo-clipboard", () => ({
  getStringAsync: async () => "",
  setStringAsync: async () => {},
}));
vi.mock("./i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("./native", () => ({
  useMobileTokens: () => ({ background: "bg", border: "b", foreground: "fg" }),
  useResolvedAppearance: () => "dark",
}));
vi.mock("./terminal", () => ({
  useTerminal: (agentId: string, _size: unknown, retain?: { current: boolean }) => {
    const [state, setState] = useState(term.state);
    term.setState = setState;
    term.calls.push({ agentId, retain });
    return {
      state,
      write: vi.fn(),
      resize: term.resize,
      reopen: term.reopen,
      onOutput: () => () => {},
      onInputError: () => () => {},
    };
  },
}));
vi.mock("./terminal-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./terminal-bridge")>();
  return {
    ...actual,
    createOutputBatcher: (
      send: never,
      schedule: never,
      options: { maxPendingBytes?: number; onOverflow?: () => void },
    ) => {
      batchers.options.push(options);
      return actual.createOutputBatcher(send, schedule, options as never);
    },
  };
});
vi.mock("./terminal-html.generated", () => ({ terminalHtml: "<html></html>" }));
vi.mock("../components/terminal-key-row", () => ({
  TerminalKeyRow: ({ bottomInset, keyboardOn }: { bottomInset: number; keyboardOn: boolean }) => (
    <div data-testid="key-row" data-inset={bottomInset} data-keyboard={String(keyboardOn)} />
  ),
}));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  web.posted = [];
  term.state = "live";
  term.reopen.mockClear();
  term.calls = [];
  batchers.options = [];
  keyboard.visible = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const render = (agentId = "a1", focused = true) =>
  act(() => root.render(<TerminalView agentId={agentId} focused={focused} />));
const webProps = () => web.props as WebProps;
const message = (msg: unknown) =>
  act(() => webProps().onMessage({ nativeEvent: { data: JSON.stringify(msg) } }));
const sent = () => web.posted.map((raw) => JSON.parse(raw) as { t: string });
const setState = (state: TerminalState) => act(() => term.setState(state));
const status = () => host.querySelector('[data-testid="terminal-status"]');
const reopenButton = () =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === "Reopen");

describe("the page", () => {
  it("is not given a chance to turn numbers into links", () => {
    render();
    expect(webProps().dataDetectorTypes).toBe("none");
  });

  it("is told to blur when the terminal stops being the focused view", () => {
    render("a1", true);
    message({ t: "ready" });
    expect(sent().map((m) => m.t)).toContain("focus");
    web.posted = [];
    render("a1", false);
    expect(sent().map((m) => m.t)).toEqual(["blur"]);
  });

  it("is never blurred when it was never focused", () => {
    render("a1", false);
    message({ t: "ready" });
    expect(sent().map((m) => m.t)).not.toContain("blur");
  });
});

describe("the overlay", () => {
  it.each([
    ["connecting", "Connecting…", false],
    ["ended", "Session ended", true],
    ["taken_over", "Opened elsewhere", true],
    ["error", "Connection lost. Retrying…", false],
    ["busy", "Too many open terminals, close one to continue", false],
    ["failed", "Could not open the terminal", true],
  ] as const)("%s reads %s", async (state, text, reopen) => {
    render();
    await setState(state);
    expect(status()?.textContent).toBe(text);
    expect(status()?.getAttribute("data-live")).toBe("polite");
    expect(reopenButton() !== undefined).toBe(reopen);
  });

  it("shows nothing while live", async () => {
    render();
    await setState("live");
    expect(status()).toBeNull();
  });

  it.each(["ended", "taken_over", "failed"] as const)("Reopen after %s reopens", async (state) => {
    render();
    await setState(state);
    act(() => reopenButton()?.click());
    expect(term.reopen).toHaveBeenCalledTimes(1);
  });
});

describe("closing the terminal when the view goes", () => {
  it("keeps it open while the page is only rebuilt", () => {
    render();
    const first = term.calls.at(-1)?.retain;
    expect(first?.current).toBe(false);
    act(() => webProps().onContentProcessDidTerminate());
    expect(first?.current).toBe(true);
    expect(term.calls.at(-1)?.retain).not.toBe(first);
    expect(term.calls.at(-1)?.retain?.current).toBe(false);
  });
});

describe("the key row", () => {
  it("clears the home indicator while the keyboard is hidden, and not once it is up", () => {
    render();
    const row = () => host.querySelector('[data-testid="key-row"]');
    expect(row()?.getAttribute("data-inset")).toBe("34");
    keyboard.visible = true;
    render();
    expect(row()?.getAttribute("data-inset")).toBe("0");
  });
});

describe("another agent on the same view", () => {
  it("starts from a clean page, not the uncapped one an earlier overflow left behind", () => {
    render("a1");
    act(() => batchers.options.at(-1)?.onOverflow?.());
    message({ t: "ready" });
    expect(batchers.options.at(-1)?.maxPendingBytes).toBe(Number.POSITIVE_INFINITY);
    render("a2");
    expect(term.calls.at(-1)?.agentId).toBe("a2");
    expect(batchers.options.at(-1)?.maxPendingBytes).toBeUndefined();
  });
});
