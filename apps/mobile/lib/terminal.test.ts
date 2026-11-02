import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stream = vi.hoisted(() => vi.fn());
const call = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ streamRpc: stream, rpc: call }));

import { createTerminalClient, type TerminalOutput } from "./terminal";

type Json = Record<string, unknown>;
type Emit = (json: unknown) => void;

const b64 = (text: string) => btoa(text);
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);
const failure = (status: number) => Object.assign(new Error(`rpc failed (${status})`), { status });

/** Each subscribe call waits for the test to finish it: `end()` is a clean close, `fail` an error. */
type Live = { body: Json; emit: Emit; end: () => void; fail: (error: unknown) => void };
let live: Live[] = [];
let opens = 0;
let posts: Json[] = [];
let inputFailures: unknown[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  live = [];
  opens = 0;
  posts = [];
  inputFailures = [];
  stream.mockReset();
  call.mockReset();
  call.mockImplementation(async (proc: string, body: Json) => {
    if (proc === "terminal/open") {
      opens += 1;
      return {
        terminalId: `t${opens}`,
        seq: opens === 1 ? 0 : 40,
        rows: body.rows,
        cols: body.cols,
      };
    }
    if (proc === "terminal/input") {
      const failing = inputFailures.shift();
      posts.push(body);
      if (failing) throw failing;
    }
    return { ok: true };
  });
  stream.mockImplementation(
    (_proc: string, body: Json, signal: AbortSignal, onJson: Emit) =>
      new Promise<void>((resolve, reject) => {
        signal.addEventListener("abort", () => resolve());
        live.push({ body, emit: onJson, end: () => resolve(), fail: reject });
      }),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

const settle = () => vi.advanceTimersByTimeAsync(0);

async function start() {
  const client = createTerminalClient("agent-1", { rows: 24, cols: 80 });
  const output: TerminalOutput[] = [];
  client.onOutput((chunk) => output.push(chunk));
  await settle();
  return { client, output };
}

const inputs = () => posts.filter((p) => p.terminalId !== undefined);

describe("open and output", () => {
  it("opens, subscribes from the returned seq and delivers bytes", async () => {
    const { client, output } = await start();
    expect(call).toHaveBeenCalledWith("terminal/open", { id: "agent-1", rows: 24, cols: 80 });
    expect(live[0]?.body).toEqual({ terminalId: "t1", cursor: 0 });
    expect(client.state).toBe("live");
    live[0]?.emit({ seq: 1, data: b64("hi") });
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ kind: "data" });
    expect(text((output[0] as { data: Uint8Array }).data)).toBe("hi");
    client.dispose();
  });

  it("a reset frame clears the screen and then writes its data", async () => {
    const { client, output } = await start();
    live[0]?.emit({ seq: 5, data: b64("fresh"), reset: true });
    expect(output.map((o) => o.kind)).toEqual(["clear", "data"]);
    client.dispose();
  });
});

describe("write", () => {
  it("batches within 8 ms and numbers calls from 1 in order", async () => {
    const { client } = await start();
    client.write(bytes("a"));
    client.write(bytes("b"));
    await vi.advanceTimersByTimeAsync(7);
    expect(inputs()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(inputs()).toHaveLength(1);
    expect(inputs()[0]).toEqual({ terminalId: "t1", data: b64("ab"), n: 1 });
    client.write(bytes("c"));
    await vi.advanceTimersByTimeAsync(8);
    expect(inputs()[1]).toEqual({ terminalId: "t1", data: b64("c"), n: 2 });
    client.dispose();
  });

  it("retries a failed POST with the same n and keeps order", async () => {
    const { client } = await start();
    inputFailures = [failure(503)];
    client.write(bytes("a"));
    await vi.advanceTimersByTimeAsync(8);
    client.write(bytes("b"));
    await vi.advanceTimersByTimeAsync(8);
    expect(inputs()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(8);
    expect(inputs().map((p) => [p.n, p.data])).toEqual([
      [1, b64("a")],
      [1, b64("a")],
      [2, b64("b")],
    ]);
    client.dispose();
  });

  it("splits 100 KB into ordered 32 KB calls", async () => {
    const { client } = await start();
    const big = new Uint8Array(100 * 1024).map((_, i) => i % 251);
    client.write(big);
    await vi.advanceTimersByTimeAsync(8);
    await settle();
    const sizes = inputs().map((p) => atob(p.data as string).length);
    expect(sizes).toEqual([32768, 32768, 32768, 4096]);
    expect(inputs().map((p) => p.n)).toEqual([1, 2, 3, 4]);
    const sent = inputs()
      .map((p) => atob(p.data as string))
      .join("");
    expect(sent).toBe(String.fromCharCode(...big));
    client.dispose();
  });
});

describe("resize", () => {
  it("is debounced 150 ms to the last value", async () => {
    const { client } = await start();
    client.resize(30, 100);
    await vi.advanceTimersByTimeAsync(100);
    client.resize(40, 120);
    await vi.advanceTimersByTimeAsync(149);
    expect(call).not.toHaveBeenCalledWith("terminal/resize", expect.anything());
    await vi.advanceTimersByTimeAsync(1);
    const resizes = call.mock.calls.filter(([proc]) => proc === "terminal/resize");
    expect(resizes).toEqual([["terminal/resize", { terminalId: "t1", rows: 40, cols: 120 }]]);
    client.dispose();
  });
});

describe("reconnect", () => {
  it("after an error re-opens (new id, n restarts at 1), clears, and replays from the new seq", async () => {
    const { client, output } = await start();
    client.write(bytes("a"));
    await vi.advanceTimersByTimeAsync(8);
    live[0]?.emit({ seq: 3, data: b64("x") });
    live[0]?.fail(new TypeError("Network request failed"));
    await settle();
    expect(client.state).toBe("error");
    await vi.advanceTimersByTimeAsync(499);
    expect(opens).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(opens).toBe(2);
    expect(live[1]?.body).toEqual({ terminalId: "t2", cursor: 40 });
    expect(output.map((o) => o.kind)).toEqual(["data", "clear"]);
    client.write(bytes("b"));
    await vi.advanceTimersByTimeAsync(8);
    expect(inputs().at(-1)).toEqual({ terminalId: "t2", data: b64("b"), n: 1 });
    client.dispose();
  });

  it("backs off 0.5 s doubling to 8 s", async () => {
    const { client } = await start();
    call.mockImplementation(async (proc: string) => {
      if (proc === "terminal/open") {
        opens += 1;
        throw failure(503);
      }
      return { ok: true };
    });
    live[0]?.fail(new Error("boom"));
    const seen: number[] = [];
    for (const wait of [500, 1000, 2000, 4000, 8000, 8000]) {
      const before = opens;
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(opens).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      seen.push(opens - before);
    }
    expect(seen).toEqual([1, 1, 1, 1, 1, 1]);
    client.dispose();
  });

  it("a clean end resubscribes from the last seq without calling open", async () => {
    const { client } = await start();
    live[0]?.emit({ seq: 7, data: b64("x") });
    live[0]?.end();
    await settle();
    expect(opens).toBe(1);
    expect(live[1]?.body).toEqual({ terminalId: "t1", cursor: 7 });
    client.dispose();
  });

  it("an ended frame stops reconnecting", async () => {
    const { client } = await start();
    live[0]?.emit({ seq: 9, ended: true, exit: 0 });
    live[0]?.end();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(client.state).toBe("ended");
    expect(live).toHaveLength(1);
    expect(opens).toBe(1);
    client.dispose();
  });

  it("taken_over does not reopen until reopen() is called", async () => {
    const { client, output } = await start();
    live[0]?.emit({ seq: 9, taken_over: true });
    live[0]?.end();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(client.state).toBe("taken_over");
    expect(opens).toBe(1);
    client.reopen();
    await settle();
    expect(opens).toBe(2);
    expect(client.state).toBe("live");
    expect(output.map((o) => o.kind)).toEqual(["clear"]);
    client.dispose();
  });
});
