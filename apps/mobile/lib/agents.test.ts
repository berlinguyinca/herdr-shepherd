import { beforeEach, describe, expect, it, vi } from "vitest";

const stream = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ streamRpc: stream, rpc: vi.fn() }));
vi.mock("./query", () => ({ rpcQuery: vi.fn((proc, input) => ({ queryKey: [proc, input] })) }));

import { agentListQuery, isAgentsUnsupported, subscribeAgent, subscribeAgentList } from "./agents";

const failure = (status: number, code?: string) =>
  Object.assign(new Error(`rpc failed (${status})`), { status, code });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  stream.mockReset();
});

describe("isAgentsUnsupported", () => {
  it("is true for an unknown-procedure error and false for network errors", () => {
    expect(isAgentsUnsupported(failure(404, "NOT_FOUND"))).toBe(true);
    expect(isAgentsUnsupported(failure(404))).toBe(true);
    expect(isAgentsUnsupported(new TypeError("Network request failed"))).toBe(false);
    expect(isAgentsUnsupported(failure(503))).toBe(false);
    expect(isAgentsUnsupported(null)).toBe(false);
  });
});

describe("agentListQuery", () => {
  it("passes showOlder through to agents/list", () => {
    expect(agentListQuery(true).queryKey).toEqual(["agents/list", { showOlder: true }]);
  });
});

describe("subscribeAgentList", () => {
  it("calls onFallback on a 429", async () => {
    stream.mockImplementation(async () => {
      throw failure(429);
    });
    const onFallback = vi.fn();
    subscribeAgentList(0, vi.fn(), onFallback);
    await tick();
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("forwards rows and tracks the cursor across a reconnect", async () => {
    const row = { id: "a" };
    stream
      .mockImplementationOnce(async (_p, _b, _s, onFrame) => {
        onFrame({ seq: 7, row });
      })
      .mockImplementationOnce(() => new Promise(() => undefined));
    const onRow = vi.fn();
    const stop = subscribeAgentList(-1, onRow, vi.fn(), { reconnectMs: 0 });
    await tick();
    await tick();
    expect(onRow).toHaveBeenCalledWith(row);
    expect(stream.mock.calls[1]?.[1]).toEqual({ cursor: 7 });
    stop();
  });

  it("stops quietly once unsubscribed", async () => {
    stream.mockImplementation(async (_p, _b, signal: AbortSignal) => {
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
    });
    const onFallback = vi.fn();
    subscribeAgentList(0, vi.fn(), onFallback)();
    await tick();
    expect(onFallback).not.toHaveBeenCalled();
  });
});

describe("subscribeAgent", () => {
  it("subscribes by rev and reports a 429 as a fallback", async () => {
    stream.mockImplementation(async () => {
      throw failure(429);
    });
    const onFallback = vi.fn();
    subscribeAgent("a1", 4, vi.fn(), onFallback);
    await tick();
    expect(stream.mock.calls[0]?.[0]).toBe("agents/subscribe");
    expect(stream.mock.calls[0]?.[1]).toEqual({ id: "a1", cursor: 4 });
    expect(onFallback).toHaveBeenCalledTimes(1);
  });
});
