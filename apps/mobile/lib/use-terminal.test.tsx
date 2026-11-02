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
