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
  await act(async () => api?.resize(24, 80));
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
  // The first open waits for the page's size.
  await act(async () => api?.resize(30, 100));
  await vi.waitFor(() => expect(api?.state).toBe("live"));
  return { root, Harness };
}

it("opens at the size the page reports first", async () => {
  const { root } = await mountHook();
  expect(call).toHaveBeenCalledWith("terminal/open", { id: "a1", rows: 30, cols: 100 });
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
