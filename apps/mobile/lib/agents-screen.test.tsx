// @vitest-environment jsdom
import { tokensForAppearance } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Agents from "../app/agents";
import { AgentsList } from "../components/agents-list";
import { HomeTabBar } from "../components/home-tab-bar";
import { agentRouteId } from "./agent-route";
import { rpc } from "./api";
import { streamRpc } from "./api-live";
import { queryClient } from "./query";
import { InboxBesideContext } from "./side-insets";

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), dismissTo: vi.fn() }));
vi.mock("expo-router", () => ({ useRouter: () => router }));
vi.mock("react-native", () => {
  const View = ({
    children,
    accessibilityRole,
    testID,
    style,
  }: {
    children?: ReactNode;
    accessibilityRole?: string;
    testID?: string;
    style?: unknown;
  }) => (
    <div data-role={accessibilityRole} data-testid={testID} data-style={JSON.stringify(style)}>
      {children}
    </div>
  );
  return {
    Platform: { OS: "ios" },
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
    View,
    Text: ({
      children,
      testID,
      style,
      numberOfLines,
    }: {
      children?: ReactNode;
      testID?: string;
      style?: unknown;
      numberOfLines?: number;
    }) => (
      <span data-testid={testID} data-style={JSON.stringify(style)} data-lines={numberOfLines}>
        {children}
      </span>
    ),
    ActivityIndicator: () => <div role="progressbar" />,
    RefreshControl: () => null,
    Pressable: ({
      children,
      onPress,
      accessibilityLabel,
      accessibilityState,
      accessibilityRole,
      style,
    }: {
      children?: ReactNode;
      style?: unknown;
      onPress?: () => void;
      accessibilityRole?: string;
      accessibilityLabel?: string;
      accessibilityState?: { selected?: boolean };
    }) => (
      <button
        type="button"
        aria-label={accessibilityLabel}
        data-role={accessibilityRole}
        data-selected={accessibilityState?.selected}
        data-style={JSON.stringify(style)}
        onClick={onPress}
      >
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
      refreshing,
      onRefresh,
    }: {
      data: unknown[];
      renderItem: (info: { item: unknown; index: number }) => ReactNode;
      ListEmptyComponent?: ReactNode;
      ListFooterComponent?: ReactNode;
      windowSize?: number;
      initialNumToRender?: number;
      refreshing?: boolean;
      onRefresh?: () => void;
    }) => (
      <div
        data-window={windowSize}
        data-initial={initialNumToRender}
        data-refreshing={String(refreshing)}
      >
        <button type="button" aria-label="pull" onClick={onRefresh} />
        {data.length === 0 ? ListEmptyComponent : null}
        {data.map((item, index) => renderItem({ item, index }))}
        {ListFooterComponent}
      </div>
    ),
  };
});
const insets = vi.hoisted(() => ({ top: 0 }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: insets.top, bottom: 0, left: 0, right: 0 }),
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
vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("./api-live", () => ({ streamRpc: vi.fn() }));
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

it("the list highlights the open agent and reports the tapped row", async () => {
  rpcMock.mockResolvedValue(list([row("a1", "working"), row("a2", "idle")]));
  const onSelect = vi.fn();
  await render(<AgentsList selectedId="a2" onSelect={onSelect} />);
  const rows = [...host.querySelectorAll("button[data-selected]")];
  expect(rows.map((r) => r.getAttribute("data-selected"))).toEqual(["false", "true"]);
  // The open row has the Assistant list's selected fill; the others have none.
  expect(rows[1]?.getAttribute("data-style")).toContain('"backgroundColor":"#888"');
  expect(rows[0]?.getAttribute("data-style")).not.toContain("backgroundColor");
  await act(async () => (rows[0] as HTMLElement).click());
  expect(onSelect).toHaveBeenCalledWith("a1");
});

it("a row shrinks the agent name first and keeps the machine and the status chip", async () => {
  rpcMock.mockResolvedValue(list([row("a1", "working")]));
  await render(<AgentsList onSelect={vi.fn()} />);
  const name = host.querySelector('[data-testid="agent-name"]');
  const machine = host.querySelector('[data-testid="agent-row-machine"]');
  expect(machine?.textContent).toBe("mac");
  expect(name?.getAttribute("data-lines")).toBe("1");
  expect(machine?.getAttribute("data-lines")).toBe("1");
  expect(name?.getAttribute("data-style")).toContain('"flexShrink":1');
  expect(machine?.getAttribute("data-style")).toContain('"flexShrink":0');
  const chip = [...host.querySelectorAll("span")].find((n) => n.textContent === "Working");
  expect(chip?.getAttribute("data-style")).toContain('"flexShrink":0');
});

it("the list has a title header with the Assistant list's top inset", async () => {
  rpcMock.mockResolvedValue(list([row("a1", "working")]));
  const header = () => host.querySelector('[data-testid="agents-header"]');
  await render(<AgentsList onSelect={vi.fn()} />);
  expect(header()?.textContent).toBe("Agents");
  // Never less than 20 points, plus the 8 the Assistant header adds.
  expect(header()?.getAttribute("data-style")).toContain('"paddingTop":28');
  insets.top = 59;
  await render(<AgentsList onSelect={vi.fn()} />);
  expect(header()?.getAttribute("data-style")).toContain('"paddingTop":67');
  insets.top = 0;
});

it("on a wide window the Agents screen is an empty right pane without the tab bar", async () => {
  rpcMock.mockResolvedValue(list([row("a1", "working")]));
  await render(
    <InboxBesideContext.Provider value>
      <Agents />
    </InboxBesideContext.Provider>,
  );
  expect(host.textContent).toContain("Select an agent");
  expect(host.textContent).not.toContain("agent-a1");
  expect(button("Agents")).toBeUndefined();
});

it("on a narrow window tapping a row pushes the agent over the list", async () => {
  rpcMock.mockResolvedValue(list([row("a1", "working")]));
  await render(<Agents />);
  await act(async () => (host.querySelector("button[data-selected]") as HTMLElement).click());
  expect(router.push).toHaveBeenCalledWith({ pathname: "/agent", params: { id: "a1" } });
});

it("navigation id is the decode-invariant route id", async () => {
  const id = "herdr:mac.lan:default:wD%3ApF";
  rpcMock.mockResolvedValue(list([row(id, "working")]));
  await render(<Agents />);
  await act(async () => (host.querySelector("button[data-selected]") as HTMLElement).click());
  expect(router.push).toHaveBeenCalledWith({
    pathname: "/agent",
    params: { id: agentRouteId(id) },
  });
});

const refreshing = () => host.querySelector("[data-refreshing]")?.getAttribute("data-refreshing");

it("does not show the pull spinner for background polls, only for an explicit pull", async () => {
  vi.useFakeTimers();
  let release: () => void = () => {};
  rpcMock.mockResolvedValue(list([row("1", "working")]));
  streamMock.mockRejectedValue(Object.assign(new Error("busy"), { status: 429 }));
  await render();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  const seen: (string | null | undefined)[] = [];
  rpcMock.mockImplementation(
    () =>
      new Promise((resolve) => {
        seen.push(refreshing());
        release = () => resolve(list([row("1", "working")]));
      }),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(seen.length).toBe(1);
  expect(refreshing()).toBe("false");
  await act(async () => release());
  await act(async () => {
    host.querySelector<HTMLButtonElement>('button[aria-label="pull"]')!.click();
  });
  expect(refreshing()).toBe("true");
  await act(async () => release());
  await settle();
  expect(refreshing()).toBe("false");
});

it("never commits the empty state while the list holds agents", async () => {
  rpcMock.mockResolvedValue(list([row("1", "working")]));
  const empties: boolean[] = [];
  const observer = new MutationObserver(() => {
    if (host.textContent?.includes("No agents yet")) empties.push(true);
  });
  observer.observe(host, { childList: true, subtree: true, characterData: true });
  await render();
  await Promise.resolve();
  observer.disconnect();
  expect(names()).toEqual(["agent-1"]);
  expect(empties).toEqual([]);
});

it("after the stream fell back a successful poll subscribes again from the fresh cursor", async () => {
  vi.useFakeTimers();
  rpcMock.mockResolvedValue(list([row("1", "working")]));
  streamMock.mockRejectedValueOnce(Object.assign(new Error("busy"), { status: 429 }));
  await render();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(streamMock).toHaveBeenCalledTimes(1);
  rpcMock.mockResolvedValue({ ...list([row("1", "working")]), cursor: 20 });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(55_000);
  });
  expect(streamMock).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(streamMock).toHaveBeenCalledTimes(2);
  expect(streamMock.mock.calls[1]?.[1]).toEqual({ cursor: 20 });
});

it("the tab bar is a tablist of tabs with the selected state", async () => {
  await render(<HomeTabBar active="agents" />);
  expect(host.querySelector('[data-role="tablist"]')).not.toBeNull();
  const tabs = [...host.querySelectorAll('button[data-role="tab"]')];
  expect(
    tabs.map((tab) => [tab.getAttribute("aria-label"), tab.getAttribute("data-selected")]),
  ).toEqual([
    ["Assistant", "false"],
    ["Agents", "true"],
  ]);
});
