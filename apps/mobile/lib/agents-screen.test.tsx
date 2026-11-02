// @vitest-environment jsdom
import { tokensForAppearance } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Agents from "../app/agents";
import { HomeTabBar } from "../components/home-tab-bar";
import { rpc, streamRpc } from "./api";
import { queryClient } from "./query";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), dismissTo: vi.fn() }));
vi.mock("expo-router", () => ({ useRouter: () => router }));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Platform: { OS: "ios" },
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
    View,
    Text: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
      <span data-testid={testID}>{children}</span>
    ),
    ActivityIndicator: () => <div role="progressbar" />,
    RefreshControl: () => null,
    Pressable: ({
      children,
      onPress,
      accessibilityLabel,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      accessibilityLabel?: string;
    }) => (
      <button type="button" aria-label={accessibilityLabel} onClick={onPress}>
        {children}
      </button>
    ),
    FlatList: ({
      data,
      renderItem,
      ListEmptyComponent,
      ListFooterComponent,
      windowSize,
      initialNumToRender,
    }: {
      data: unknown[];
      renderItem: (info: { item: unknown; index: number }) => ReactNode;
      ListEmptyComponent?: ReactNode;
      ListFooterComponent?: ReactNode;
      windowSize?: number;
      initialNumToRender?: number;
    }) => (
      <div data-window={windowSize} data-initial={initialNumToRender}>
        {data.length === 0 ? ListEmptyComponent : null}
        {data.map((item, index) => renderItem({ item, index }))}
        {ListFooterComponent}
      </div>
    ),
  };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("./app-foreground", () => ({ useAppForeground: () => true }));
vi.mock("./native", () => {
  const tokens = tokensForAppearance("dark");
  return {
    useMobileTokens: () => tokens,
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

type Row = {
  id: string;
  name: string;
  machine: string | null;
  status: string;
  summary: string;
  updated_at: string;
  has_conversation: boolean;
};
const row = (id: string, status: string, updated = "2026-11-01T10:00:00Z", extra = {}): Row => ({
  id,
  name: `agent-${id}`,
  machine: "mac",
  status,
  summary: `summary ${id}`,
  updated_at: updated,
  has_conversation: true,
  ...extra,
});
const list = (agents: Row[], hiddenCount = 0) => ({ agents, hiddenCount, cursor: 7 });

let host: HTMLDivElement;
let root: Root;
const rpcMock = vi.mocked(rpc) as unknown as ReturnType<typeof vi.fn>;
const streamMock = vi.mocked(streamRpc) as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // A stream that stays open without frames.
  streamMock.mockImplementation(
    (_p: string, _b: unknown, signal: AbortSignal) =>
      new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve())),
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

async function render(node: ReactNode = <Agents />) {
  await act(async () => root.render(node));
  await settle();
}
async function settle() {
  // The query cache notifies on a timer, so let it fire.
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1);
    else await new Promise((resolve) => setTimeout(resolve, 5));
  });
}
const button = (label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(label));
const names = () =>
  [...host.querySelectorAll('[data-testid="agent-name"]')].map((n) => n.textContent);

it("renders rows in the order the server sends and a Needs you badge for blocked and done", async () => {
  rpcMock.mockResolvedValue(
    list([row("1", "blocked"), row("2", "done"), row("3", "working"), row("4", "idle")]),
  );
  await render();
  expect(names()).toEqual(["agent-1", "agent-2", "agent-3", "agent-4"]);
  expect(host.querySelectorAll('[data-testid="needs-you"]').length).toBe(2);
  expect(host.textContent).toContain("Needs you");
  expect(host.textContent).not.toMatch(/\b[1-4]\b.*id/);
  expect(host.querySelector("[data-window]")?.getAttribute("data-window")).toBe("7");
});

it("renders a status it does not know as unknown", async () => {
  rpcMock.mockResolvedValue(list([row("1", "paused")]));
  await render();
  expect(host.textContent).toContain("Unknown");
});

it("shows No agents yet for an empty list", async () => {
  rpcMock.mockResolvedValue(list([]));
  await render();
  expect(host.textContent).toContain("No agents yet");
});

it("shows the unsupported-server state when agents.list is an unknown procedure", async () => {
  rpcMock.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }));
  await render();
  expect(host.textContent).toContain("This server does not offer the Agents view yet");
  expect(host.textContent).not.toContain("Could not load agents");
  expect(rpcMock).toHaveBeenCalledTimes(1);
});

it("Show older refetches with showOlder true", async () => {
  rpcMock.mockImplementation(async (_p: string, input: { showOlder: boolean }) =>
    input.showOlder
      ? list([row("1", "working"), row("9", "closed")])
      : list([row("1", "working")], 1),
  );
  await render();
  expect(names()).toEqual(["agent-1"]);
  await act(async () => button("Show older")!.click());
  await settle();
  expect(rpcMock).toHaveBeenLastCalledWith("agents/list", { showOlder: true });
  expect(names()).toEqual(["agent-1", "agent-9"]);
  expect(button("Show older")).toBeUndefined();
});

it("applies live rows in the server order and drops a row that arrives closed", async () => {
  rpcMock.mockResolvedValue(
    list([row("1", "blocked"), row("2", "working", "2026-11-01T10:00:00Z"), row("3", "idle")]),
  );
  let onFrame: (json: unknown) => void = () => {};
  streamMock.mockImplementation(
    (_p: string, _b: unknown, signal: AbortSignal, cb: (json: unknown) => void) => {
      onFrame = cb;
      return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    },
  );
  await render();
  expect(streamMock.mock.calls[0]?.[1]).toEqual({ cursor: 7 });
  await act(async () => onFrame({ seq: 8, row: row("3", "done") }));
  expect(names()).toEqual(["agent-1", "agent-3", "agent-2"]);
  await act(async () => onFrame({ seq: 9, row: row("1", "closed") }));
  expect(names()).toEqual(["agent-3", "agent-2"]);
  await act(async () =>
    onFrame({ seq: 10, row: row("2", "working", "2026-11-01T11:00:00Z", { summary: "later" }) }),
  );
  expect(host.textContent).toContain("later");
});

it("falls back to polling every 5 seconds when the stream is refused", async () => {
  vi.useFakeTimers();
  rpcMock.mockResolvedValue(list([row("1", "working")]));
  streamMock.mockRejectedValue(Object.assign(new Error("busy"), { status: 429 }));
  await render();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  const settled = rpcMock.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(rpcMock.mock.calls.length).toBe(settled + 1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(rpcMock.mock.calls.length).toBe(settled + 2);
});

it("tapping the Agents tab from home navigates to /agents and back", async () => {
  await render(<HomeTabBar active="assistant" />);
  await act(async () => button("Agents")!.click());
  expect(router.push).toHaveBeenCalledWith("/agents");
  await render(<HomeTabBar active="agents" />);
  await act(async () => button("Assistant")!.click());
  expect(router.dismissTo).toHaveBeenCalledWith("/");
  router.push.mockClear();
  await act(async () => button("Agents")!.click());
  expect(router.push).not.toHaveBeenCalled();
});
