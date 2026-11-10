import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stream = vi.hoisted(() => vi.fn());
const call = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ rpc: call }));
vi.mock("./api-live", () => ({ streamRpc: stream }));

import type { TerminalOutput } from "./terminal";
import { createTerminalClient } from "./terminal";

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
/** A held input POST stays in flight until its promise settles (a rejection fails the call). */
let inputHolds: Promise<void>[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  live = [];
  opens = 0;
  posts = [];
  inputFailures = [];
  inputHolds = [];
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
      const hold = inputHolds.shift();
      if (hold) await hold;
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

  it("a reset frame is data marked reset, with no clear: the frame repaints the screen itself", async () => {
    const { client, output } = await start();
    live[0]?.emit({ seq: 5, data: b64("fresh"), reset: true });
    live[0]?.emit({ seq: 6, data: b64("more") });
    expect(output).toMatchObject([{ kind: "data", reset: true }, { kind: "data" }]);
    expect((output[1] as { reset?: boolean }).reset).toBeUndefined();
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

describe("the pane owns its size", () => {
  it("passes each frame's pane size on with its data", async () => {
    const { client, output } = await start();
    live[0]?.emit({ seq: 1, data: b64("a"), reset: true, rows: 120, cols: 97 });
    live[0]?.emit({ seq: 2, data: b64("b") });
    expect(output).toMatchObject([{ kind: "data", rows: 120, cols: 97 }, { kind: "data" }]);
    expect((output[1] as { rows?: number }).rows).toBeUndefined();
    client.dispose();
  });

  it("has no resize: the page's size never reaches the server", async () => {
    const { client } = await start();
    expect("resize" in client).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(call).not.toHaveBeenCalledWith("terminal/resize", expect.anything());
    client.dispose();
  });

  it("opens straight away at the seeded size", async () => {
    const { client } = await start();
    expect(call).toHaveBeenCalledWith("terminal/open", { id: "agent-1", rows: 24, cols: 80 });
    client.dispose();
  });
});

describe("setZoom", () => {
  const resizes = () => call.mock.calls.filter(([proc]) => proc === "terminal/resize");

  it("sends the zoom flag with the last pane size", async () => {
    const { client } = await start();
    live[0]?.emit({ seq: 1, data: b64("a"), reset: true, rows: 120, cols: 97 });
    client.setZoom(true);
    await settle();
    client.setZoom(false);
    await settle();
    expect(resizes()).toEqual([
      ["terminal/resize", { terminalId: "t1", rows: 120, cols: 97, zoom: true }],
      ["terminal/resize", { terminalId: "t1", rows: 120, cols: 97, zoom: false }],
    ]);
    client.dispose();
  });

  it("falls back to the opened size before any frame, and does nothing once stopped", async () => {
    const { client } = await start();
    client.setZoom(true);
    expect(resizes()).toEqual([
      ["terminal/resize", { terminalId: "t1", rows: 24, cols: 80, zoom: true }],
    ]);
    live[0]?.emit({ seq: 9, ended: true, exit: 0 });
    client.setZoom(false);
    expect(resizes()).toHaveLength(1);
    client.dispose();
  });
});

describe("why a terminal ended or could not open", () => {
  it("keeps the reason of an ended frame", async () => {
    const { client } = await start();
    expect(client.endReason).toBeUndefined();
    live[0]?.emit({ seq: 9, ended: true, exit: null, reason: "host_offline" });
    expect(client.state).toBe("ended");
    expect(client.endReason).toBe("host_offline");
    client.dispose();
  });

  it("clears the reason when the terminal opens again", async () => {
    const { client } = await start();
    live[0]?.emit({ seq: 9, ended: true, exit: null, reason: "stale" });
    await settle();
    client.reopen();
    await settle();
    expect(client.state).toBe("live");
    expect(client.endReason).toBeUndefined();
    client.dispose();
  });

  it("is relay_down for a 503 HOST_NOT_CONNECTED, and gives up until reopen", async () => {
    call.mockImplementation(async (proc: string) => {
      if (proc === "terminal/open") {
        opens += 1;
        throw Object.assign(failure(503), { code: "HOST_NOT_CONNECTED" });
      }
      return { ok: true };
    });
    const { client } = await start();
    expect(client.state).toBe("relay_down");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(opens).toBe(1);
    client.dispose();
  });
});

describe("reconnect", () => {
  it("after an error re-opens (new id, n restarts at 1), clears, and replays from the new seq", async () => {
    const { client, output } = await start();
    client.write(bytes("a"));
    await vi.advanceTimersByTimeAsync(8);
    live[0]?.emit({ seq: 3, data: b64("x") });
    live[0]?.fail(failure(502));
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
    live[0]?.fail(failure(502));
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

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
};

describe("input and a retired terminal", () => {
  it("a 404 on input keeps the stream; the taken_over frame drives the state", async () => {
    const { client } = await start();
    inputFailures = [failure(404)];
    client.write(bytes("a"));
    await vi.advanceTimersByTimeAsync(8);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(opens).toBe(1);
    expect(live).toHaveLength(1);
    expect(live[0]?.body).toEqual({ terminalId: "t1", cursor: 0 });
    live[0]?.emit({ seq: 2, taken_over: true });
    await settle();
    expect(client.state).toBe("taken_over");
    expect(opens).toBe(1);
    client.dispose();
  });

  it("a late 404 for the old id does not stall the queue on the new id", async () => {
    const { client } = await start();
    const hold = deferred();
    inputHolds = [hold.promise];
    client.write(bytes("a"));
    await vi.advanceTimersByTimeAsync(8);
    client.write(bytes("b"));
    await vi.advanceTimersByTimeAsync(8);
    live[0]?.fail(failure(502));
    await vi.advanceTimersByTimeAsync(500);
    expect(opens).toBe(2);
    client.write(bytes("c"));
    await vi.advanceTimersByTimeAsync(8);
    hold.reject(failure(404));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(8);
    expect(
      inputs()
        .filter((p) => p.terminalId === "t2")
        .map((p) => p.data),
    ).toEqual([b64("c")]);
    client.dispose();
  });

  it("an item already attempted on an older terminal is dropped, never retyped", async () => {
    const { client } = await start();
    const hold = deferred();
    inputHolds = [hold.promise];
    client.write(bytes("run\r"));
    await vi.advanceTimersByTimeAsync(8);
    live[0]?.fail(failure(502));
    await vi.advanceTimersByTimeAsync(500);
    expect(opens).toBe(2);
    hold.reject(failure(503));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(inputs().filter((p) => p.terminalId === "t2")).toEqual([]);
    client.dispose();
  });

  it("typing made while the stream was down is never typed later", async () => {
    const { client } = await start();
    live[0]?.fail(failure(502));
    await settle();
    client.write(bytes("offline"));
    await vi.advanceTimersByTimeAsync(500);
    expect(opens).toBe(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(inputs()).toEqual([]);
    client.dispose();
  });

  it("queued input is cleared on taken_over", async () => {
    const { client } = await start();
    inputFailures = [failure(503), failure(503), failure(503)];
    client.write(bytes("a"));
    await vi.advanceTimersByTimeAsync(8);
    live[0]?.emit({ seq: 2, taken_over: true });
    await settle();
    client.reopen();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(inputs().filter((p) => p.terminalId === "t2")).toEqual([]);
    client.dispose();
  });

  it("caps the unsent queue at 256 KB, dropping the oldest unsent", async () => {
    const { client } = await start();
    const hold = deferred();
    inputHolds = [hold.promise];
    client.write(bytes("first"));
    await vi.advanceTimersByTimeAsync(8);
    for (let i = 0; i < 10; i += 1) {
      client.write(new Uint8Array(32 * 1024).fill(65 + i));
      await vi.advanceTimersByTimeAsync(8);
    }
    hold.resolve();
    await vi.advanceTimersByTimeAsync(100);
    const sent = inputs().slice(1);
    expect(sent.reduce((sum, p) => sum + atob(p.data as string).length, 0)).toBe(256 * 1024);
    expect(atob(sent[0]?.data as string)[0]).toBe("C");
    client.dispose();
  });

  it("a refused input call is dropped and reported; the terminal stays live and input flows", async () => {
    const { client } = await start();
    const refused: unknown[] = [];
    client.onInputError((error) => refused.push(error));
    inputFailures = [failure(400)];
    client.write(bytes("a"));
    await vi.advanceTimersByTimeAsync(8);
    client.write(bytes("b"));
    await vi.advanceTimersByTimeAsync(8);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(refused).toHaveLength(1);
    expect(client.state).toBe("live");
    expect(inputs().map((p) => [p.n, p.data])).toEqual([
      [1, b64("a")],
      [1, b64("b")],
    ]);
    client.dispose();
  });

  it("keeps the number when the refused call had an earlier unknown-outcome attempt", async () => {
    const { client } = await start();
    inputFailures = [failure(503), failure(400)];
    client.write(bytes("a"));
    await vi.advanceTimersByTimeAsync(8);
    await vi.advanceTimersByTimeAsync(500);
    client.write(bytes("b"));
    await vi.advanceTimersByTimeAsync(8);
    expect(inputs().map((p) => [p.n, p.data])).toEqual([
      [1, b64("a")],
      [1, b64("a")],
      [2, b64("b")],
    ]);
    client.dispose();
  });

  it("a 404 when resubscribing the same terminal is a takeover and does not reopen", async () => {
    const { client } = await start();
    live[0]?.emit({ seq: 2, data: b64("x") });
    stream.mockImplementationOnce(async () => {
      throw failure(404);
    });
    live[0]?.end();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(opens).toBe(1);
    expect(client.state).toBe("taken_over");
    client.dispose();
  });

  it("copies the caller's bytes", async () => {
    const { client } = await start();
    const mine = bytes("a");
    client.write(mine);
    mine[0] = 90;
    await vi.advanceTimersByTimeAsync(8);
    expect(inputs()[0]?.data).toBe(b64("a"));
    client.dispose();
  });
});

describe("stream hygiene", () => {
  it("ignores frames at or before the cursor", async () => {
    const { client, output } = await start();
    live[0]?.emit({ seq: 5, data: b64("x") });
    live[0]?.emit({ seq: 5, data: b64("dup") });
    live[0]?.emit({ seq: 3, data: b64("old") });
    expect(output).toHaveLength(1);
    client.dispose();
  });

  it("a 4xx open (other than 408/429) is final", async () => {
    call.mockImplementation(async (proc: string) => {
      if (proc === "terminal/open") {
        opens += 1;
        throw failure(403);
      }
      return { ok: true };
    });
    const { client } = await start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(opens).toBe(1);
    expect(client.state).toBe("failed");
    client.dispose();
  });

  it("input typed while connecting is dropped when open is refused for good", async () => {
    const gate = deferred();
    let refuse = true;
    call.mockImplementation(async (proc: string, body: Json) => {
      if (proc === "terminal/open") {
        opens += 1;
        await gate.promise;
        if (refuse) throw failure(403);
        return { terminalId: "t2", seq: 0, rows: body.rows, cols: body.cols };
      }
      if (proc === "terminal/input") posts.push(body);
      return { ok: true };
    });
    const { client } = await start();
    client.write(bytes("early"));
    await vi.advanceTimersByTimeAsync(8);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.state).toBe("failed");
    refuse = false;
    client.reopen();
    await vi.advanceTimersByTimeAsync(100);
    expect(inputs()).toEqual([]);
    client.dispose();
  });

  it("a 429 open waits for Retry-After", async () => {
    let first = true;
    call.mockImplementation(async (proc: string, body: Json) => {
      if (proc === "terminal/open") {
        opens += 1;
        if (first) {
          first = false;
          throw Object.assign(failure(429), { retryAfterMs: 3_000 });
        }
        return { terminalId: "t9", seq: 0, rows: body.rows, cols: body.cols };
      }
      return { ok: true };
    });
    const { client } = await start();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(opens).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(opens).toBe(2);
    client.dispose();
  });

  it("resets the backoff on the first received frame, not on open", async () => {
    const { client } = await start();
    live[0]?.fail(failure(502));
    await vi.advanceTimersByTimeAsync(500);
    expect(opens).toBe(2);
    live[1]?.fail(failure(502));
    await settle();
    await vi.advanceTimersByTimeAsync(999);
    expect(opens).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(opens).toBe(3);
    live[2]?.emit({ seq: 41, data: b64("x") });
    live[2]?.fail(failure(502));
    await settle();
    await vi.advanceTimersByTimeAsync(500);
    expect(opens).toBe(4);
    client.dispose();
  });
});

describe("a transport error resubscribes the same terminal first", () => {
  it("resubscribes from the current cursor without opening, so nothing is taken back", async () => {
    const { client, output } = await start();
    live[0]?.emit({ seq: 3, data: b64("x") });
    live[0]?.fail(new TypeError("Network request failed"));
    await settle();
    expect(client.state).toBe("error");
    await vi.advanceTimersByTimeAsync(500);
    expect(opens).toBe(1);
    expect(live[1]?.body).toEqual({ terminalId: "t1", cursor: 3 });
    expect(client.state).toBe("live");
    expect(output.map((o) => o.kind)).toEqual(["data"]);
    client.dispose();
  });

  it("a 404 on that resubscribe is a takeover", async () => {
    const { client } = await start();
    live[0]?.fail(new TypeError("Network request failed"));
    await settle();
    stream.mockImplementationOnce(async () => {
      throw failure(404);
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(opens).toBe(1);
    expect(client.state).toBe("taken_over");
    // Nobody said another client opened it: the cause is unknown, and says so.
    expect(client.endReason).toBe("gone");
    client.dispose();
  });

  it("a taken_over frame is a known takeover: no reason", async () => {
    const { client } = await start();
    live[0]?.emit({ seq: 9, taken_over: true });
    expect(client.state).toBe("taken_over");
    expect(client.endReason).toBeUndefined();
    client.dispose();
  });

  it("any other failure of that resubscribe opens again", async () => {
    const { client } = await start();
    live[0]?.fail(new TypeError("Network request failed"));
    await settle();
    stream.mockImplementationOnce(async () => {
      throw failure(500);
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(opens).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(opens).toBe(2);
    client.dispose();
  });
});

describe("close", () => {
  it("retires the terminal on the server and stops", async () => {
    const { client } = await start();
    client.close();
    await settle();
    expect(call).toHaveBeenCalledWith("terminal/close", { terminalId: "t1" });
    expect(live[0]?.body).toEqual({ terminalId: "t1", cursor: 0 });
  });

  describe("with the zoom on", () => {
    const names = () =>
      call.mock.calls.map(([proc, body]) =>
        proc === "terminal/resize" ? `resize:${(body as Json).zoom}` : (proc as string),
      );

    it("turns it off before it retires the terminal", async () => {
      const { client } = await start();
      client.setZoom(true);
      await settle();
      client.close();
      await settle();
      expect(names().filter((n) => /^(resize|terminal\/close)/.test(n))).toEqual([
        "resize:true",
        "resize:false",
        "terminal/close",
      ]);
    });

    it("retires it after 500 ms even when the zoom-off is never answered", async () => {
      const { client } = await start();
      client.setZoom(true);
      await settle();
      call.mockImplementation(async (proc: string) =>
        proc === "terminal/resize" ? new Promise(() => {}) : { ok: true },
      );
      client.close();
      await vi.advanceTimersByTimeAsync(499);
      expect(names()).not.toContain("terminal/close");
      await vi.advanceTimersByTimeAsync(1);
      expect(names()).toContain("terminal/close");
    });

    it("sends no zoom-off when the zoom is already off", async () => {
      const { client } = await start();
      client.setZoom(true);
      client.setZoom(false);
      await settle();
      call.mockClear();
      client.close();
      expect(names()).toEqual(["terminal/close"]);
    });
  });

  it("dispose alone leaves the terminal for a later reattach", async () => {
    const { client } = await start();
    client.dispose();
    await settle();
    expect(call).not.toHaveBeenCalledWith("terminal/close", expect.anything());
  });

  it("does not close a terminal that is already over", async () => {
    const { client } = await start();
    live[0]?.emit({ seq: 9, taken_over: true });
    client.close();
    await settle();
    expect(call).not.toHaveBeenCalledWith("terminal/close", expect.anything());
  });

  it("a failing close is swallowed", async () => {
    const { client } = await start();
    call.mockImplementation(async () => {
      throw failure(500);
    });
    expect(() => client.close()).not.toThrow();
    await settle();
  });
});

describe("what the client reports when it stops trying", () => {
  const refuse = (status: number, extra: Json = {}) =>
    call.mockImplementation(async (proc: string, body: Json) => {
      if (proc === "terminal/open") {
        opens += 1;
        if (status) throw Object.assign(failure(status), extra);
        return { terminalId: "t9", seq: 0, rows: body.rows, cols: body.cols };
      }
      return { ok: true };
    });

  it("is failed after a final refusal, and reopen tries again", async () => {
    refuse(403);
    const { client } = await start();
    expect(client.state).toBe("failed");
    refuse(0);
    client.reopen();
    await settle();
    expect(client.state).toBe("live");
    client.dispose();
  });

  it("is busy while waiting out a 429, error while backing off from other failures", async () => {
    refuse(429, { retryAfterMs: 3_000 });
    const { client } = await start();
    expect(client.state).toBe("busy");
    client.dispose();
    refuse(503);
    const other = await start();
    expect(other.client.state).toBe("error");
    other.client.dispose();
  });

  it("reopen after ended opens a fresh terminal", async () => {
    const { client } = await start();
    live[0]?.emit({ seq: 9, ended: true, exit: 0 });
    expect(client.state).toBe("ended");
    await settle();
    client.reopen();
    await settle();
    expect(opens).toBe(2);
    expect(client.state).toBe("live");
    client.dispose();
  });
});
