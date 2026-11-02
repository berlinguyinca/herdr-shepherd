// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentEvent } from "./agents";
import { agentMessages, getAgent, subscribeAgent } from "./agents";
import type { AgentConversation } from "./use-agent-conversation";
import { mergeEvents, useAgentConversation } from "./use-agent-conversation";

const foreground = vi.hoisted(() => ({ value: true }));
vi.mock("./app-foreground", () => ({ useAppForeground: () => foreground.value }));
vi.mock("./agents", () => ({
  getAgent: vi.fn(),
  agentMessages: vi.fn(),
  subscribeAgent: vi.fn(),
  isAgentGone: (error: unknown) => (error as { gone?: boolean })?.gone === true,
}));

const getMock = vi.mocked(getAgent) as unknown as ReturnType<typeof vi.fn>;
const messagesMock = vi.mocked(agentMessages) as unknown as ReturnType<typeof vi.fn>;
const subscribeMock = vi.mocked(subscribeAgent) as unknown as ReturnType<typeof vi.fn>;

const ev = (seq: number, rev = seq, data: Record<string, unknown> = {}): AgentEvent => ({
  seq,
  rev,
  kind: "message",
  agent_id: "main",
  parent_agent_id: null,
  ts: "2026-11-01T10:00:00Z",
  sensitive: false,
  redacted: false,
  truncated: false,
  size: 1,
  data: { role: "assistant", text: `m${seq}`, ...data },
});
const agent = {
  id: "a1",
  name: "alpha",
  machine: "mac",
  status: "working",
  summary: "",
  updated_at: "",
  has_conversation: true,
};

let host: HTMLDivElement;
let root: Root;
let latest: AgentConversation;
let probeId = "a1";
function Probe() {
  latest = useAgentConversation(probeId);
  return null;
}
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

beforeEach(() => {
  vi.clearAllMocks();
  foreground.value = true;
  probeId = "a1";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  getMock.mockResolvedValue({ agent, hasConversation: true });
  subscribeMock.mockReturnValue(() => {});
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("mergeEvents replaces the same seq, adds new ones and keeps seq order", () => {
  const out = mergeEvents([ev(1), ev(3)], [ev(2), ev(3, 9, { text: "new" })]);
  expect(out.map((e) => e.seq)).toEqual([1, 2, 3]);
  expect(out[2]?.data.text).toBe("new");
});

it("reads the newest page and subscribes from the returned rev, oldest first", async () => {
  messagesMock.mockResolvedValue({ events: [ev(3), ev(2)], hasMore: true, newestSeq: 3, rev: 42 });
  await act(async () => root.render(<Probe />));
  await flush();
  expect(latest.events.map((e) => e.seq)).toEqual([2, 3]);
  expect(latest.hasMore).toBe(true);
  expect(messagesMock).toHaveBeenCalledWith({ id: "a1", limit: 50 });
  expect(subscribeMock.mock.calls[0]?.[1]).toBe(42);
});

it("loadOlder pages with beforeSeq of the oldest loaded event", async () => {
  messagesMock.mockResolvedValueOnce({
    events: [ev(3), ev(2)],
    hasMore: true,
    newestSeq: 3,
    rev: 5,
  });
  await act(async () => root.render(<Probe />));
  await flush();
  messagesMock.mockResolvedValueOnce({ events: [ev(1)], hasMore: false, newestSeq: 3, rev: 5 });
  await act(async () => latest.loadOlder());
  await flush();
  expect(messagesMock).toHaveBeenLastCalledWith({ id: "a1", beforeSeq: 2, limit: 50 });
  expect(latest.events.map((e) => e.seq)).toEqual([1, 2, 3]);
  expect(latest.hasMore).toBe(false);
});

it("a streamed event replaces the loaded one with the same seq", async () => {
  messagesMock.mockResolvedValue({
    events: [ev(2, 2, { status: "running" })],
    hasMore: false,
    newestSeq: 2,
    rev: 2,
  });
  await act(async () => root.render(<Probe />));
  await flush();
  const onEvent = subscribeMock.mock.calls[0]?.[2] as (e: AgentEvent) => void;
  await act(async () => onEvent(ev(2, 3, { status: "ok" })));
  await act(async () => onEvent(ev(3)));
  expect(latest.events.map((e) => [e.seq, e.data.status])).toEqual([
    [2, "ok"],
    [3, undefined],
  ]);
});

it("polls the newest page every 5 seconds after the stream falls back", async () => {
  messagesMock.mockResolvedValue({ events: [ev(1)], hasMore: false, newestSeq: 1, rev: 1 });
  await act(async () => root.render(<Probe />));
  await flush();
  vi.useFakeTimers();
  const onFallback = subscribeMock.mock.calls[0]?.[3] as () => void;
  await act(async () => onFallback());
  messagesMock.mockResolvedValue({ events: [ev(2), ev(1)], hasMore: false, newestSeq: 2, rev: 4 });
  const before = messagesMock.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(messagesMock.mock.calls.length).toBe(before + 1);
  expect(latest.events.map((e) => e.seq)).toEqual([1, 2]);
});

it("reconnects after the app returns: re-reads the page and subscribes from the new rev", async () => {
  messagesMock.mockResolvedValueOnce({ events: [ev(5)], hasMore: false, newestSeq: 5, rev: 100 });
  await act(async () => root.render(<Probe />));
  await flush();
  const unsubscribe = vi.fn();
  subscribeMock.mockReturnValue(unsubscribe);
  foreground.value = false;
  await act(async () => root.render(<Probe />));
  messagesMock.mockResolvedValueOnce({ events: [ev(5)], hasMore: false, newestSeq: 5, rev: 3 });
  foreground.value = true;
  await act(async () => root.render(<Probe />));
  await flush();
  expect(messagesMock).toHaveBeenCalledTimes(2);
  expect(subscribeMock.mock.calls.at(-1)?.[1]).toBe(3);
});

it("reports gone on a 404 and does not subscribe", async () => {
  messagesMock.mockRejectedValue(Object.assign(new Error("gone"), { gone: true }));
  getMock.mockRejectedValue(Object.assign(new Error("gone"), { gone: true }));
  await act(async () => root.render(<Probe />));
  await flush();
  expect(latest.gone).toBe(true);
  expect(subscribeMock).not.toHaveBeenCalled();
});

it("is empty when nothing was captured", async () => {
  getMock.mockResolvedValue({ agent, hasConversation: false });
  messagesMock.mockResolvedValue({ events: [], hasMore: false, newestSeq: null, rev: 0 });
  await act(async () => root.render(<Probe />));
  await flush();
  expect(latest.empty).toBe(true);
});

const deferred = <T,>() => {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const tool = (seq: number, rev: number, status: string) => ev(seq, rev, { status, tool: "bash" });

it("mergeEvents never lets an older rev replace a newer one", () => {
  const out = mergeEvents([tool(2, 9, "ok")], [tool(2, 4, "running")]);
  expect(out[0]?.data.status).toBe("ok");
});

it("a stale poll resolving after a stream frame does not revert a finished tool call", async () => {
  vi.useFakeTimers();
  messagesMock.mockResolvedValueOnce({
    events: [tool(1, 1, "running")],
    hasMore: false,
    newestSeq: 1,
    rev: 1,
  });
  await act(async () => root.render(<Probe />));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  const stale = deferred<unknown>();
  messagesMock.mockReturnValueOnce(stale.promise);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  const onEvent = subscribeMock.mock.calls[0]?.[2] as (e: AgentEvent) => void;
  await act(async () => onEvent(tool(1, 5, "ok")));
  await act(async () =>
    stale.resolve({ events: [tool(1, 1, "running")], hasMore: false, newestSeq: 1, rev: 1 }),
  );
  expect(latest.events[0]?.data.status).toBe("ok");
});

it("a loadOlder boundary event and a replayed older frame do not revert a newer event", async () => {
  messagesMock.mockResolvedValueOnce({
    events: [tool(2, 8, "ok")],
    hasMore: true,
    newestSeq: 2,
    rev: 8,
  });
  await act(async () => root.render(<Probe />));
  await flush();
  messagesMock.mockResolvedValueOnce({
    events: [tool(2, 3, "running"), ev(1)],
    hasMore: false,
    newestSeq: 2,
    rev: 8,
  });
  await act(async () => latest.loadOlder());
  await flush();
  const onEvent = subscribeMock.mock.calls[0]?.[2] as (e: AgentEvent) => void;
  await act(async () => onEvent(tool(2, 2, "running")));
  expect(latest.events.map((e) => [e.seq, e.data.status])).toEqual([
    [1, undefined],
    [2, "ok"],
  ]);
});

it("switching id resets state and ignores in-flight loadOlder and poll of the old id", async () => {
  vi.useFakeTimers();
  messagesMock.mockResolvedValueOnce({
    events: [ev(3), ev(2)],
    hasMore: true,
    newestSeq: 3,
    rev: 5,
  });
  await act(async () => root.render(<Probe />));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  const older = deferred<unknown>();
  messagesMock.mockReturnValueOnce(older.promise);
  await act(async () => latest.loadOlder());
  const poll = deferred<unknown>();
  messagesMock.mockReturnValueOnce(poll.promise);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  probeId = "b2";
  getMock.mockResolvedValue({ agent: { ...agent, id: "b2", name: "beta" }, hasConversation: true });
  messagesMock.mockResolvedValue({ events: [ev(10)], hasMore: false, newestSeq: 10, rev: 1 });
  await act(async () => root.render(<Probe />));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  await act(async () => older.resolve({ events: [ev(1)], hasMore: false, newestSeq: 3, rev: 5 }));
  await act(async () => poll.resolve({ events: [ev(4)], hasMore: false, newestSeq: 4, rev: 5 }));
  expect(latest.events.map((e) => e.seq)).toEqual([10]);
  expect(latest.agent?.name).toBe("beta");
  expect(latest.hasMore).toBe(false);
});

it("a failed reconnect keeps the loaded conversation and polls", async () => {
  vi.useFakeTimers();
  messagesMock.mockResolvedValueOnce({ events: [ev(1)], hasMore: false, newestSeq: 1, rev: 1 });
  await act(async () => root.render(<Probe />));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  foreground.value = false;
  await act(async () => root.render(<Probe />));
  messagesMock.mockRejectedValueOnce(new Error("offline"));
  foreground.value = true;
  await act(async () => root.render(<Probe />));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(latest.failed).toBe(false);
  expect(latest.reconnecting).toBe(true);
  expect(latest.events.map((e) => e.seq)).toEqual([1]);
  messagesMock.mockResolvedValue({ events: [ev(2), ev(1)], hasMore: false, newestSeq: 2, rev: 2 });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(latest.events.map((e) => e.seq)).toEqual([1, 2]);
});

it("reconciles an open stream every 15s and resubscribes when the rev dropped (server restart)", async () => {
  vi.useFakeTimers();
  messagesMock.mockResolvedValueOnce({ events: [ev(1)], hasMore: false, newestSeq: 1, rev: 100 });
  await act(async () => root.render(<Probe />));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(subscribeMock).toHaveBeenCalledTimes(1);
  // Equal rev: merged, no resubscribe.
  messagesMock.mockResolvedValueOnce({
    events: [ev(2), ev(1)],
    hasMore: false,
    newestSeq: 2,
    rev: 100,
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(subscribeMock).toHaveBeenCalledTimes(1);
  expect(latest.events.map((e) => e.seq)).toEqual([1, 2]);
  // Higher rev: no resubscribe.
  messagesMock.mockResolvedValueOnce({ events: [ev(2)], hasMore: false, newestSeq: 2, rev: 120 });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(subscribeMock).toHaveBeenCalledTimes(1);
  // Lower rev: restart, resubscribe from the returned rev.
  messagesMock.mockResolvedValueOnce({ events: [ev(1)], hasMore: false, newestSeq: 1, rev: 7 });
  messagesMock.mockResolvedValue({ events: [ev(1)], hasMore: false, newestSeq: 1, rev: 7 });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(subscribeMock).toHaveBeenCalledTimes(2);
  expect(subscribeMock.mock.calls[1]?.[1]).toBe(7);
});
