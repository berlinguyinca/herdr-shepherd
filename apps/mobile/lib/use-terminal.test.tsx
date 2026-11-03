// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const call = vi.hoisted(() => vi.fn());
const stream = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ rpc: call, streamRpc: stream }));

import { useTerminal } from "./terminal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.clearAllMocks();
});

it("delivers an input error to a listener registered before the client exists", async () => {
  call.mockImplementation(async (proc: string) => {
    if (proc === "terminal/open") return { terminalId: "t1", seq: 0, rows: 24, cols: 80 };
    if (proc === "terminal/input") throw Object.assign(new Error("refused"), { status: 400 });
    return { ok: true };
  });
  stream.mockImplementation(
    (_proc: string, _body: unknown, signal: AbortSignal) =>
      new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve())),
  );
  const refused: unknown[] = [];
  let api: ReturnType<typeof useTerminal> | undefined;

  // A child's effect runs before its parent's, so this registers before the client is created.
  function Early({
    onInputError,
  }: {
    onInputError: ReturnType<typeof useTerminal>["onInputError"];
  }) {
    useEffect(() => onInputError((error) => refused.push(error)), [onInputError]);
    return null;
  }
  function Harness() {
    api = useTerminal("a1");
    return <Early onInputError={api.onInputError} />;
  }

  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<Harness />));
  await vi.waitFor(() => expect(api?.state).toBe("live"));
  await act(async () => api?.write(new TextEncoder().encode("x")));
  await vi.waitFor(() => expect(refused).toHaveLength(1));
  await act(async () => root.unmount());
});

async function mountHook(retain?: { current: boolean }) {
  call.mockImplementation(async (proc: string) =>
    proc === "terminal/open" ? { terminalId: "t1", seq: 0, rows: 24, cols: 80 } : { ok: true },
  );
  stream.mockImplementation(
    (_proc: string, _body: unknown, signal: AbortSignal) =>
      new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve())),
  );
  let api: ReturnType<typeof useTerminal> | undefined;
  function Harness({ id }: { id: string }) {
    api = useTerminal(id, undefined, retain);
    return null;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<Harness id="a1" />));
  await vi.waitFor(() => expect(api?.state).toBe("live"));
  return { root, Harness };
}

it("opens at once at the seeded size, with no resize to follow", async () => {
  const { root } = await mountHook();
  expect(call).toHaveBeenCalledWith("terminal/open", { id: "a1", rows: 24, cols: 80 });
  expect(call).not.toHaveBeenCalledWith("terminal/resize", expect.anything());
  await act(async () => root.unmount());
});

it("closes the terminal when the view goes away for good", async () => {
  const { root } = await mountHook();
  await act(async () => root.unmount());
  expect(call).toHaveBeenCalledWith("terminal/close", { terminalId: "t1" });
});

it("closes the old agent's terminal when the agent changes", async () => {
  const { root, Harness } = await mountHook();
  await act(async () => root.render(<Harness id="a2" />));
  expect(call).toHaveBeenCalledWith("terminal/close", { terminalId: "t1" });
  await act(async () => root.unmount());
});

it("leaves the terminal open when the view is only being rebuilt", async () => {
  const retain = { current: true };
  const { root } = await mountHook(retain);
  await act(async () => root.unmount());
  expect(call).not.toHaveBeenCalledWith("terminal/close", expect.anything());
});

it("reports why the terminal ended, and forgets it on reopen", async () => {
  call.mockImplementation(async (proc: string) =>
    proc === "terminal/open" ? { terminalId: "t1", seq: 0, rows: 24, cols: 80 } : { ok: true },
  );
  let frames = 0;
  stream.mockImplementation(
    (_proc: string, _body: unknown, signal: AbortSignal, onJson: (json: unknown) => void) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve());
        if (frames === 0) {
          frames = 1;
          onJson({ seq: 1, ended: true, exit: null, reason: "stale" });
        }
      }),
  );
  let api: ReturnType<typeof useTerminal> | undefined;
  function Harness() {
    api = useTerminal("a1");
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  await vi.waitFor(() => expect(api?.state).toBe("ended"));
  expect(api?.reason).toBe("stale");
  await act(async () => api?.reopen());
  await vi.waitFor(() => expect(api?.state).toBe("live"));
  expect(api?.reason).toBeUndefined();
  await act(async () => root.unmount());
});

it("says a terminal that vanished on resubscribe is gone, not taken over", async () => {
  call.mockImplementation(async (proc: string) =>
    proc === "terminal/open" ? { terminalId: "t1", seq: 0, rows: 24, cols: 80 } : { ok: true },
  );
  let tries = 0;
  stream.mockImplementation(async () => {
    tries += 1;
    throw Object.assign(new Error("gone"), { status: tries === 1 ? undefined : 404 });
  });
  let api: ReturnType<typeof useTerminal> | undefined;
  function Harness() {
    api = useTerminal("a1");
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  await vi.waitFor(() => expect(api?.state).toBe("taken_over"), { timeout: 3000 });
  expect(api?.reason).toBe("gone");
  await act(async () => root.unmount());
});
