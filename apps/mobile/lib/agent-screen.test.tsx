// @vitest-environment jsdom
import { tokensForAppearance } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AgentScreen from "../app/agent";
import Agents from "../app/agents";
import { agentRouteId } from "./agent-route";
import { rpc, streamRpc } from "./api";
import { queryClient } from "./query";
import { InboxBesideContext } from "./side-insets";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  canGoBack: vi.fn(() => false),
}));
const screenOptions = vi.hoisted(() => ({
  title: undefined as string | undefined,
  headerBackVisible: undefined as boolean | undefined,
}));
const headerInset = vi.hoisted(() => ({ value: 96 }));
vi.mock("./floating-header", () => ({ useFloatingHeaderInset: () => headerInset.value }));
const routeParams = vi.hoisted(() => ({ id: "a1" as string, decodes: 0 }));
vi.mock("expo-router", () => ({
  useRouter: () => router,
  useLocalSearchParams: () => {
    let id = routeParams.id;
    for (let i = 0; i < routeParams.decodes; i++) id = decodeURIComponent(id);
    return { id };
  },
  Stack: {
    Screen: ({ options }: { options?: { title?: string; headerBackVisible?: boolean } }) => {
      screenOptions.title = options?.title;
      screenOptions.headerBackVisible = options?.headerBackVisible;
      return null;
    },
  },
}));
vi.mock("react-native", () => {
  const View = ({
    children,
    testID,
    style,
    pointerEvents,
    accessibilityElementsHidden,
    importantForAccessibility,
  }: {
    children?: ReactNode;
    testID?: string;
    style?: unknown;
    pointerEvents?: string;
    accessibilityElementsHidden?: boolean;
    importantForAccessibility?: string;
  }) => (
    <div
      data-testid={testID}
      data-style={JSON.stringify(style)}
      data-pointer-events={pointerEvents}
      data-a11y-hidden={String(accessibilityElementsHidden)}
      data-importance={importantForAccessibility}
    >
      {children}
    </div>
  );
  return {
    Platform: { OS: "ios" },
    useWindowDimensions: () => ({ fontScale: 1, width: 800 }),
    StyleSheet: {
      create: <T,>(styles: T) => styles,
      hairlineWidth: 1,
      absoluteFill: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
    },
    View,
    Text: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
      <span data-testid={testID}>{children}</span>
    ),
    ActivityIndicator: () => <div role="progressbar" />,
    RefreshControl: () => null,
    Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) => (
      <button type="button" onClick={onPress}>
        {children}
      </button>
    ),
    FlatList: ({
      data,
      renderItem,
      ListHeaderComponent,
      ListEmptyComponent,
      ListFooterComponent,
      onStartReached,
      contentContainerStyle,
    }: {
      data: unknown[];
      renderItem: (info: { item: unknown; index: number }) => ReactNode;
      ListHeaderComponent?: ReactNode;
      ListEmptyComponent?: ReactNode;
      ListFooterComponent?: ReactNode;
      onStartReached?: () => void;
      contentContainerStyle?: unknown;
    }) => (
      <div data-testid="event-list" data-content-style={JSON.stringify(contentContainerStyle)}>
        <button type="button" aria-label="scroll-top" onClick={onStartReached} />
        {ListHeaderComponent}
        {data.length === 0 ? ListEmptyComponent : null}
        {data.map((item, index) => (
          <div key={(item as { seq?: number; id?: string }).seq ?? (item as { id?: string }).id}>
            {renderItem({ item, index })}
          </div>
        ))}
        {ListFooterComponent}
      </div>
    ),
  };
});
const stored = vi.hoisted(() => ({ modes: null as string | null }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => stored.modes),
  setItemAsync: vi.fn(async () => {}),
}));
const terminalMounts = vi.hoisted(() => ({ count: 0 }));
vi.mock("../components/terminal-view", async () => {
  const { useEffect } = await import("react");
  return {
    TerminalView: ({
      agentId,
      focused,
      keyboardOffset,
    }: {
      agentId: string;
      focused: boolean;
      keyboardOffset?: number;
    }) => {
      useEffect(() => {
        terminalMounts.count += 1;
      }, []);
      return (
        <div
          data-testid="terminal"
          data-agent={agentId}
          data-focused={String(focused)}
          data-offset={keyboardOffset}
        />
      );
    },
  };
});
vi.mock("../components/native-segmented-control", () => ({
  NativeSegmentedControl: ({
    accessibilityLabel,
    disabled,
    value,
    onChange,
    options,
  }: {
    accessibilityLabel: string;
    disabled?: boolean;
    value: string;
    onChange: (value: string) => void;
    options: { value: string; label: string }[];
  }) => (
    <fieldset aria-label={accessibilityLabel} data-disabled={String(!!disabled)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  ),
}));
const insets = vi.hoisted(() => ({ left: 0, right: 0 }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: insets.left, right: insets.right }),
}));
vi.mock("@rakazo/chat-ui/native", () => ({
  ChatMarkdown: ({ children }: { children: ReactNode }) => <p data-md>{children}</p>,
}));
const foreground = vi.hoisted(() => ({ value: true }));
vi.mock("./app-foreground", () => ({ useAppForeground: () => foreground.value }));
vi.mock("./native", () => {
  const tokens = tokensForAppearance("dark");
  return {
    useMobileTokens: () => tokens,
    useResolvedAppearance: () => "dark",
    useThemedStyles: (create: () => unknown) => create(),
    native: new Proxy({}, { get: () => "#888" }),
  };
});
vi.mock("./i18n", () => ({
  useI18n: () => ({
    t: (text: string, values?: Record<string, string>) =>
      text.replace(/\{(\w+)\}/g, (_, key: string) => values?.[key] ?? key),
  }),
  t: (text: string) => text,
}));
vi.mock("./api", () => ({ rpc: vi.fn(), streamRpc: vi.fn() }));
vi.mock("./query", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  return {
    queryClient: client,
    rpcQuery: (proc: string, input: unknown) => ({
      queryKey: [proc, input ?? {}],
      queryFn: async () =>
        (rpc as unknown as (p: string, i: unknown) => Promise<unknown>)(proc, input),
    }),
  };
});

const agent = {
  id: "a1",
  name: "alpha",
  machine: "mac-1",
  status: "working",
  summary: "",
  updated_at: "2026-11-01T10:00:00Z",
  has_conversation: true,
};
type Data = Record<string, unknown>;
const ev = (seq: number, kind: string, data: Data, rev = seq) => ({
  seq,
  rev,
  kind,
  agent_id: "main",
  parent_agent_id: null,
  ts: "2026-11-01T10:00:00Z",
  sensitive: false,
  redacted: false,
  truncated: false,
  size: 1,
  data,
});
const msg = (seq: number, role: string, text: string, extra: Data = {}) =>
  ev(seq, "message", { role, text, ...extra });
const tool = (seq: number, data: Data, rev = seq) =>
  ev(seq, "tool", { tool: "bash", args_preview: "ls -la", status: "ok", output: "", ...data }, rev);
const page = (events: unknown[], extra: Data = {}) => ({
  events,
  hasMore: false,
  newestSeq: 1,
  rev: 10,
  ...extra,
});

let host: HTMLDivElement;
let root: Root;
const rpcMock = vi.mocked(rpc) as unknown as ReturnType<typeof vi.fn>;
const streamMock = vi.mocked(streamRpc) as unknown as ReturnType<typeof vi.fn>;
let onFrame: (json: unknown) => void = () => {};

/** Routes rpc calls by procedure; `messages` may be a function of the input. */
function serve(opts: {
  get?: unknown | ((input: Data) => unknown);
  messages: unknown | ((input: Data) => unknown);
  event?: (input: Data) => unknown;
}) {
  rpcMock.mockImplementation(async (proc: string, input: Data) => {
    const value =
      proc === "agents/get"
        ? ((typeof opts.get === "function"
            ? (opts.get as (i: Data) => unknown)(input)
            : opts.get) ?? {
            agent,
            hasConversation: true,
          })
        : proc === "agents/messages"
          ? typeof opts.messages === "function"
            ? (opts.messages as (i: Data) => unknown)(input)
            : opts.messages
          : opts.event?.(input);
    if (value instanceof Error) throw value;
    return value;
  });
}
const notFound = () => Object.assign(new Error("nf"), { status: 404 });

beforeEach(() => {
  vi.clearAllMocks();
  routeParams.id = "a1";
  routeParams.decodes = 0;
  queryClient.clear();
  foreground.value = true;
  terminalMounts.count = 0;
  stored.modes = null;
  insets.left = 0;
  insets.right = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  streamMock.mockImplementation(
    (_p: string, _b: unknown, signal: AbortSignal, cb: (json: unknown) => void) => {
      onFrame = cb;
      return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render(node: ReactNode = <AgentScreen />) {
  await act(async () => root.render(node));
  await settle();
}
async function settle() {
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1);
    else await new Promise((resolve) => setTimeout(resolve, 5));
  });
}
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(label));
const texts = () => [...host.querySelectorAll("[data-md]")].map((n) => n.textContent);
const messageCalls = () => rpcMock.mock.calls.filter((c) => c[0] === "agents/messages");

it("shows the name once, in the native title, with machine and status in a sub-row", async () => {
  serve({ messages: page([msg(1, "user", "hi")]) });
  await render();
  expect(screenOptions.title).toBe("alpha");
  expect(host.textContent).not.toContain("alpha");
  expect(host.querySelector('[data-testid="agent-name"]')).toBeNull();
  expect(host.querySelector('[data-testid="agent-machine"]')?.textContent).toContain("mac-1");
  expect(host.textContent).toContain("Working");
  expect(host.textContent).not.toContain("a1");
});

it("keeps the back arrow on a phone and drops it when the list is beside the conversation", async () => {
  serve({ messages: page([msg(1, "user", "hi")]) });
  await render();
  expect(screenOptions.headerBackVisible).toBe(true);
  await render(
    <InboxBesideContext.Provider value={true}>
      <AgentScreen />
    </InboxBesideContext.Provider>,
  );
  expect(screenOptions.headerBackVisible).toBe(false);
});

it("keeps the sub-row and the events in a centred column at most 720 points wide", async () => {
  serve({ messages: page([msg(1, "user", "hi")]) });
  await render();
  const column = {
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
  };
  const list = host.querySelector('[data-testid="event-list"]');
  expect(JSON.parse(list?.getAttribute("data-content-style") ?? "null")).toEqual(column);
  const header = host.querySelector('[data-testid="agent-column"]');
  expect(JSON.parse(header?.getAttribute("data-style") ?? "[]")[0]).toEqual(column);
});

it("offsets the header sub-row below the floating native header", async () => {
  serve({ messages: page([msg(1, "user", "hi")]) });
  headerInset.value = 96;
  await render();
  const row = host.querySelector('[data-testid="agent-subheader"]');
  expect(row?.getAttribute("data-style")).toContain('"paddingTop":106');
});

it("shows messages oldest at top and loads older on scroll up using beforeSeq", async () => {
  serve({
    messages: (input: Data) =>
      input.beforeSeq === 2
        ? page([msg(1, "user", "first")], { hasMore: false })
        : page([msg(3, "assistant", "third"), msg(2, "user", "second")], { hasMore: true }),
  });
  await render();
  expect(texts()).toEqual(["second", "third"]);
  expect(host.querySelector('[data-testid="bubble-user"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="bubble-assistant"]')).not.toBeNull();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="scroll-top"]')!.click(),
  );
  await settle();
  expect(messageCalls().at(-1)?.[1]).toEqual({ id: "a1", beforeSeq: 2, limit: 50 });
  expect(texts()).toEqual(["first", "second", "third"]);
  expect(button("Load earlier messages")).toBeUndefined();
});

it("collapses tool calls to one line and expands on tap fetching the full event when output_more", async () => {
  serve({
    messages: page([tool(2, { output: "short…", output_more: true })]),
    event: () => tool(2, { output: "the complete output" }),
  });
  await render();
  expect(host.textContent).toContain("bash");
  expect(host.textContent).toContain("ls -la");
  expect(host.querySelector('[data-testid="tool-output"]')).toBeNull();
  await act(async () => button("bash")!.click());
  await settle();
  expect(rpcMock).toHaveBeenCalledWith("agents/event", { id: "a1", seq: 2 });
  expect(host.querySelector('[data-testid="tool-output"]')?.textContent).toBe(
    "the complete output",
  );
  await act(async () => button("bash")!.click());
  expect(host.querySelector('[data-testid="tool-output"]')).toBeNull();
});

it("expands a short tool call without fetching", async () => {
  serve({ messages: page([tool(2, { output: "plain" })]) });
  await render();
  await act(async () => button("bash")!.click());
  expect(host.querySelector('[data-testid="tool-output"]')?.textContent).toBe("plain");
  expect(rpcMock.mock.calls.some((c) => c[0] === "agents/event")).toBe(false);
});

it("appends live events from the stream without a refetch", async () => {
  serve({ messages: page([msg(1, "user", "hi")], { rev: 10 }) });
  await render();
  expect(streamMock.mock.calls[0]?.[1]).toEqual({ id: "a1", cursor: 10 });
  const before = rpcMock.mock.calls.length;
  await act(async () => onFrame({ seq: 11, event: msg(2, "assistant", "live!") }));
  expect(texts()).toEqual(["hi", "live!"]);
  expect(rpcMock.mock.calls.length).toBe(before);
});

it("a streamed update of an existing seq replaces it: a finished tool call updates in place", async () => {
  serve({ messages: page([tool(1, { status: "running", output: "" })]) });
  await render();
  expect(host.querySelector('[data-testid="tool-status"]')?.textContent).toBe("…");
  await act(async () =>
    onFrame({ seq: 12, event: tool(1, { status: "ok", output: "done", duration_ms: 1500 }, 12) }),
  );
  expect(host.querySelectorAll('[data-testid="tool-status"]').length).toBe(1);
  expect(host.querySelector('[data-testid="tool-status"]')?.textContent).toBe("✓");
  expect(host.textContent).toContain("1.5 s");
});

it("shows the empty state for a session with no conversation", async () => {
  serve({
    get: { agent: { ...agent, has_conversation: false }, hasConversation: false },
    messages: page([], { newestSeq: null, rev: 0 }),
  });
  await render();
  expect(host.textContent).toContain("No conversation was captured for this agent.");
});

it("shows This agent is no longer available on 404 and returns to the list", async () => {
  serve({ get: notFound(), messages: notFound() });
  await render();
  expect(host.textContent).toContain("This agent is no longer available");
  expect(streamMock).not.toHaveBeenCalled();
  const calls = rpcMock.mock.calls.length;
  await act(async () => button("Back to agents")!.click());
  expect(router.replace).toHaveBeenCalledWith("/agents");
  await settle();
  expect(rpcMock.mock.calls.length).toBe(calls);
});

it("withheld events render a translated reason chip, never blank text; reasoning is not rendered", async () => {
  serve({
    messages: page([
      ev(4, "reasoning", { withheld: true, withheld_reason: "reasoning requires a higher role" }),
      msg(3, "assistant", "", { withheld: true, withheld_reason: "something new" }),
      msg(2, "assistant", "", {
        withheld: true,
        withheld_reason: "sensitive output requires a higher role",
      }),
      tool(1, { withheld: true, withheld_reason: "sensitive output requires a higher role" }),
    ]),
  });
  await render();
  const chips = [...host.querySelectorAll('[data-testid="withheld"]')].map((n) => n.textContent);
  expect(chips).toEqual([
    "Sensitive output requires a higher role",
    "Sensitive output requires a higher role",
    "Withheld",
  ]);
  expect(host.textContent).not.toContain("Reasoning requires");
});

it("maps known lifecycle phases to words and an unknown one to a neutral line", async () => {
  serve({
    messages: page([
      ev(4, "lifecycle", { phase: "teleported" }),
      ev(3, "lifecycle", { phase: "interrupted" }),
      ev(2, "lifecycle", { phase: "restored" }),
      ev(1, "lifecycle", { phase: "started" }),
    ]),
  });
  await render();
  expect(host.textContent).toContain("Session started");
  expect(host.textContent).toContain("Session restored");
  expect(host.textContent).toContain("Session interrupted");
  expect(host.textContent).toContain("Session update");
  expect(host.textContent).not.toContain("teleported");
});

it("shows a calm message when the conversation has nothing renderable", async () => {
  serve({
    messages: page([ev(2, "usage", { input_tokens: 5 }), ev(1, "usage", { input_tokens: 1 })]),
  });
  await render();
  expect(host.textContent).toContain("Nothing to show yet.");
});

it("on reconnect it re-reads agentMessages and subscribes from the returned rev, not the old cursor", async () => {
  serve({ messages: page([msg(1, "user", "hi")], { rev: 100 }) });
  await render();
  expect(streamMock.mock.calls.at(-1)?.[1]).toEqual({ id: "a1", cursor: 100 });
  foreground.value = false;
  await render();
  serve({ messages: page([msg(1, "user", "hi")], { rev: 3 }) });
  foreground.value = true;
  await render();
  expect(messageCalls().length).toBe(2);
  expect(streamMock.mock.calls.at(-1)?.[1]).toEqual({ id: "a1", cursor: 3 });
});

it("polls agentMessages every 5 seconds while the stream is down and merges by seq", async () => {
  vi.useFakeTimers();
  serve({ messages: page([msg(1, "user", "hi")]) });
  streamMock.mockRejectedValue(Object.assign(new Error("busy"), { status: 429 }));
  await render();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  serve({ messages: page([msg(2, "assistant", "polled"), msg(1, "user", "hi")]) });
  const before = messageCalls().length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(messageCalls().length).toBe(before + 1);
  expect(texts()).toEqual(["hi", "polled"]);
});

it("hides usage events and shows lifecycle as a small line, with no raw JSON", async () => {
  serve({
    messages: page([
      ev(3, "usage", { input_tokens: 5 }),
      ev(2, "lifecycle", { phase: "ended" }),
      msg(1, "user", "hi"),
    ]),
  });
  await render();
  expect(host.textContent).toContain("Session ended");
  expect(host.textContent).not.toContain("input_tokens");
  expect(host.textContent).not.toContain("{");
});

it("tapping a row in the Agents list opens /agent with its id", async () => {
  rpcMock.mockResolvedValue({ agents: [agent], hiddenCount: 0, cursor: 1 });
  await render(<Agents />);
  await act(async () => button("alpha")!.click());
  expect(router.push).toHaveBeenCalledWith({ pathname: "/agent", params: { id: "a1" } });
});

it("a failing agentEvent shows a retry hint and a second tap retries", async () => {
  let calls = 0;
  serve({
    messages: page([tool(2, { output: "short…", output_more: true })]),
    event: () => {
      calls += 1;
      return calls === 1 ? new Error("boom") : tool(2, { output: "full now" });
    },
  });
  await render();
  await act(async () => button("bash")!.click());
  await settle();
  expect(host.textContent).toContain("Couldn't load the full output. Tap to retry.");
  await act(async () => button("Tap to retry")!.click());
  await settle();
  expect(calls).toBe(2);
  expect(host.querySelector('[data-testid="tool-output"]')?.textContent).toBe("full now");
  expect(host.textContent).not.toContain("Tap to retry");
});

it("a 404 from agentEvent routes to the gone state", async () => {
  serve({
    messages: page([tool(2, { output: "short…", output_more: true })]),
    event: () => notFound(),
  });
  await render();
  await act(async () => button("bash")!.click());
  await settle();
  expect(host.textContent).toContain("This agent is no longer available");
});

it("a failed reconnect keeps the conversation on screen with a Reconnecting line", async () => {
  serve({ messages: page([msg(1, "user", "kept")]) });
  await render();
  foreground.value = false;
  await render();
  serve({ messages: new Error("offline") });
  foreground.value = true;
  await render();
  expect(texts()).toEqual(["kept"]);
  expect(host.textContent).toContain("Reconnecting");
  expect(host.textContent).not.toContain("Could not load this conversation");
});

it("a first load that fails still shows the error screen", async () => {
  serve({ messages: new Error("offline") });
  await render();
  expect(host.textContent).toContain("Could not load this conversation");
});

it("while the full fetch keeps failing, the header tap still collapses and the hint retries", async () => {
  let calls = 0;
  serve({
    messages: page([tool(2, { output: "short…", output_more: true })]),
    event: () => {
      calls += 1;
      return new Error("offline");
    },
  });
  await render();
  await act(async () => button("bash")!.click());
  await settle();
  expect(host.textContent).toContain("Tap to retry");
  await act(async () => button("Tap to retry")!.click());
  await settle();
  expect(calls).toBe(2);
  expect(host.textContent).toContain("Tap to retry");
  await act(async () => button("bash")!.click());
  expect(host.querySelector('[data-testid="tool-output"]')).toBeNull();
  expect(host.textContent).not.toContain("Tap to retry");
  expect(calls).toBe(2);
});

it.each([0, 1, 2])(
  "uses the original id on the wire when the param is decoded %i extra times",
  async (decodes) => {
    const original = "herdr:mac.lan:default:wD%3ApF";
    routeParams.id = agentRouteId(original);
    routeParams.decodes = decodes;
    serve({
      get: { agent: { ...agent, id: original }, hasConversation: true },
      messages: page([msg(1, "user", "hi")]),
    });
    await render();
    const calls = rpcMock.mock.calls.filter(([p]) => p === "agents/get" || p === "agents/messages");
    expect(calls.map(([p]) => p).sort()).toEqual(
      expect.arrayContaining(["agents/get", "agents/messages"]),
    );
    for (const [, input] of calls) expect((input as Data).id).toBe(original);
  },
);

const terminal = () => host.querySelector<HTMLElement>('[data-testid="terminal"]');
const pane = (testID: string) => host.querySelector(`[data-testid="${testID}"]`);

it("opens in Chat for a working agent and mounts the terminal only when asked", async () => {
  serve({ messages: page([msg(1, "user", "hi")]) });
  await render();
  expect(terminal()).toBeNull();
  expect(host.querySelector('[aria-label="Agent view"]')).not.toBeNull();
  await act(async () => button("Terminal")?.click());
  expect(terminal()?.dataset.agent).toBe("a1");
  expect(terminal()?.dataset.focused).toBe("true");
});

it("opens in Terminal for a blocked agent, below the header inset", async () => {
  serve({
    messages: page([msg(1, "user", "hi")]),
    get: { agent: { ...agent, status: "blocked" }, hasConversation: true },
  });
  headerInset.value = 96;
  await render();
  expect(terminal()?.dataset.focused).toBe("true");
  expect(terminal()?.dataset.offset).toBe("96");
  expect(merged("agent-terminal")).toMatchObject({ flex: 1 });
  expect(merged("agent-terminal").opacity).toBeUndefined();
  expect(merged("agent-terminal").position).toBeUndefined();
});

it("switching back to Chat keeps both mounted: no refetch, no new terminal, keyboard released", async () => {
  serve({ messages: page([msg(1, "user", "hi")]) });
  await render();
  await act(async () => button("Terminal")?.click());
  const fetched = rpcMock.mock.calls.length;
  await act(async () => button("Chat")?.click());
  await act(async () => button("Terminal")?.click());
  await act(async () => button("Chat")?.click());
  expect(terminalMounts.count).toBe(1);
  expect(terminal()?.dataset.focused).toBe("false");
  expect(host.querySelector('[data-testid="event-list"]')).not.toBeNull();
  expect(rpcMock.mock.calls.length).toBe(fetched);
});

it("offers no Terminal for a closed agent, and says why", async () => {
  serve({
    messages: page([msg(1, "user", "hi")]),
    get: { agent: { ...agent, status: "closed" }, hasConversation: true },
  });
  await render();
  const group = host.querySelector("fieldset");
  expect(group?.getAttribute("data-disabled")).toBe("true");
  expect(group?.getAttribute("aria-label")).toBe(
    "Terminal unavailable: this agent has no live session",
  );
  expect(terminal()).toBeNull();
});

it("fills the pane beside the list on an iPad as it does on a phone", async () => {
  serve({
    messages: page([msg(1, "user", "hi")]),
    get: { agent: { ...agent, status: "blocked" }, hasConversation: true },
  });
  await render(
    <InboxBesideContext.Provider value={true}>
      <AgentScreen />
    </InboxBesideContext.Provider>,
  );
  expect(terminal()).not.toBeNull();
  expect(
    JSON.parse(
      host.querySelector('[data-testid="agent-terminal"]')?.getAttribute("data-style") ?? "[]",
    )[0],
  ).toEqual({ flex: 1 });
});

const styleOf = (testID: string) =>
  JSON.parse(pane(testID)?.getAttribute("data-style") ?? "[]") as Array<Record<string, unknown>>;
const merged = (testID: string) => Object.assign({}, ...styleOf(testID).filter(Boolean));

it("keeps the hidden pane laid out at full size, transparent and out of reach, never display none", async () => {
  serve({ messages: page([msg(1, "user", "hi")]) });
  await render();
  await act(async () => button("Terminal")?.click());
  const chat = host.querySelector('[data-testid="agent-chat"]');
  const hidden = JSON.parse(chat?.getAttribute("data-style") ?? "[]") as Array<
    Record<string, unknown>
  >;
  const style = Object.assign({}, ...hidden.filter(Boolean));
  expect(style).toMatchObject({ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 });
  expect(style.opacity).toBe(0);
  expect(style.display).toBeUndefined();
  expect(chat?.getAttribute("data-pointer-events")).toBe("none");
  expect(chat?.getAttribute("data-a11y-hidden")).toBe("true");
  expect(chat?.getAttribute("data-importance")).toBe("no-hide-descendants");
  await act(async () => button("Chat")?.click());
  expect(merged("agent-terminal")).toMatchObject({ position: "absolute", opacity: 0 });
  expect(merged("agent-terminal").display).toBeUndefined();
  expect(pane("agent-terminal")?.getAttribute("data-pointer-events")).toBe("none");
  expect(merged("agent-chat").opacity).toBeUndefined();
});

it("clears a landscape notch beside the terminal, but not on the left in the split pane", async () => {
  serve({
    messages: page([msg(1, "user", "hi")]),
    get: { agent: { ...agent, status: "blocked" }, hasConversation: true },
  });
  insets.left = 44;
  insets.right = 20;
  await render();
  expect(merged("agent-terminal")).toMatchObject({ paddingLeft: 44, paddingRight: 20 });
  await act(async () => root.unmount());
  root = createRoot(host);
  await render(
    <InboxBesideContext.Provider value={true}>
      <AgentScreen />
    </InboxBesideContext.Provider>,
  );
  expect(merged("agent-terminal")).toMatchObject({ paddingLeft: 0, paddingRight: 20 });
});

it("never opens the terminal for a blocked agent whose stored choice is Chat", async () => {
  stored.modes = JSON.stringify({ a1: "chat" });
  serve({
    messages: page([msg(1, "user", "hi")]),
    get: { agent: { ...agent, status: "blocked" }, hasConversation: true },
  });
  await render();
  expect(terminalMounts.count).toBe(0);
  expect(terminal()).toBeNull();
});

it("another agent on the same screen does not inherit the terminal that was mounted", async () => {
  const byId = (input: Data) => ({
    agent: { ...agent, id: input.id, status: input.id === "a1" ? "blocked" : "working" },
    hasConversation: true,
  });
  serve({ messages: page([msg(1, "user", "hi")]), get: byId });
  await render();
  expect(terminal()?.dataset.agent).toBe("a1");
  routeParams.id = "a2";
  await render();
  expect(terminal()).toBeNull();
  expect(host.querySelector('[data-testid="event-list"]')).not.toBeNull();
});

it("keeps the Chat | Terminal switch when only the conversation failed to load", async () => {
  serve({ messages: new Error("offline") });
  await render();
  expect(host.textContent).toContain("Could not load this conversation");
  expect(host.querySelector('[aria-label="Agent view"]')).not.toBeNull();
  await act(async () => button("Terminal")?.click());
  expect(terminal()?.dataset.agent).toBe("a1");
});
