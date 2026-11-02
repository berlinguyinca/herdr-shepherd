// @vitest-environment jsdom
import { tokensForAppearance } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AgentScreen from "../app/agent";
import Agents from "../app/agents";
import { rpc, streamRpc } from "./api";
import { queryClient } from "./query";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  canGoBack: vi.fn(() => false),
}));
vi.mock("expo-router", () => ({
  useRouter: () => router,
  useLocalSearchParams: () => ({ id: "a1" }),
  Stack: { Screen: () => null },
}));
vi.mock("react-native", () => {
  const View = ({ children, testID }: { children?: ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  );
  return {
    Platform: { OS: "ios" },
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
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
    }: {
      data: unknown[];
      renderItem: (info: { item: unknown; index: number }) => ReactNode;
      ListHeaderComponent?: ReactNode;
      ListEmptyComponent?: ReactNode;
      ListFooterComponent?: ReactNode;
      onStartReached?: () => void;
    }) => (
      <div>
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
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
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
  get?: unknown;
  messages: unknown | ((input: Data) => unknown);
  event?: (input: Data) => unknown;
}) {
  rpcMock.mockImplementation(async (proc: string, input: Data) => {
    const value =
      proc === "agents/get"
        ? (opts.get ?? { agent, hasConversation: true })
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
  queryClient.clear();
  foreground.value = true;
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

it("shows the header with name, machine and status, never the id", async () => {
  serve({ messages: page([msg(1, "user", "hi")]) });
  await render();
  expect(host.querySelector('[data-testid="agent-name"]')?.textContent).toBe("alpha");
  expect(host.querySelector('[data-testid="agent-machine"]')?.textContent).toContain("mac-1");
  expect(host.textContent).toContain("Working");
  expect(host.textContent).not.toContain("a1");
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

it("withheld events render a chip with the reason, never blank text", async () => {
  serve({
    messages: page([
      msg(2, "assistant", "", { withheld: true, withheld_reason: "secret" }),
      tool(1, { withheld: true, withheld_reason: "sensitive command", output: "" }),
    ]),
  });
  await render();
  const chips = [...host.querySelectorAll('[data-testid="withheld"]')].map((n) => n.textContent);
  expect(chips).toEqual(["Withheld: sensitive command", "Withheld: secret"]);
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
