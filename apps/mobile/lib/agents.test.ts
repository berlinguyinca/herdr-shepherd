import { beforeEach, describe, expect, it, vi } from "vitest";

const stream = vi.hoisted(() => vi.fn());
const call = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ streamRpc: stream, rpc: call }));
vi.mock("./query", () => ({
  rpcQuery: vi.fn((proc, input) => ({ queryKey: [proc, input], queryFn: () => call(proc, input) })),
}));

import {
  agentEvent,
  agentListQuery,
  agentMessages,
  getAgent,
  isAgentGone,
  isAgentsUnsupported,
  subscribeAgent,
  subscribeAgentList,
} from "./agents";

const failure = (status: number, code?: string) =>
  Object.assign(new Error(`rpc failed (${status})`), { status, code });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  stream.mockReset();
  call.mockReset();
});

describe("404 classification", () => {
  const caught = async (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (e) => e,
    );

  it("a 404 from agents/list is unsupported and not gone", async () => {
    call.mockRejectedValue(failure(404, "NOT_FOUND"));
    const error = await caught(agentListQuery(false).queryFn(undefined as never));
    expect(isAgentsUnsupported(error)).toBe(true);
    expect(isAgentGone(error)).toBe(false);
  });

  it("a 404 from get, messages or event is gone and not unsupported", async () => {
    call.mockRejectedValue(failure(404, "NOT_FOUND"));
    for (const error of [
      await caught(getAgent("a")),
      await caught(agentMessages({ id: "a" })),
      await caught(agentEvent("a", 1)),
    ]) {
      expect(isAgentGone(error)).toBe(true);
      expect(isAgentsUnsupported(error)).toBe(false);
    }
  });

  it("network errors and other statuses are neither", async () => {
    for (const cause of [new TypeError("Network request failed"), failure(503)]) {
      call.mockRejectedValue(cause);
      for (const error of [
        await caught(agentListQuery(false).queryFn(undefined as never)),
        await caught(getAgent("a")),
      ]) {
        expect(error).toBe(cause);
        expect(isAgentGone(error)).toBe(false);
        expect(isAgentsUnsupported(error)).toBe(false);
      }
    }
    expect(isAgentsUnsupported(null)).toBe(false);
    expect(isAgentGone(undefined)).toBe(false);
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
