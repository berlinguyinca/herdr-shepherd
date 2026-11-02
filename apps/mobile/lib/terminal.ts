import type { RpcOutput, TerminalFrame } from "@rakazo/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { rpc, streamRpc } from "./api";

export type TerminalState = "connecting" | "live" | "ended" | "taken_over" | "error";

/** Screen output: bytes to feed the emulator, or a signal to wipe it before a replay. */
export type TerminalOutput = { kind: "data"; data: Uint8Array } | { kind: "clear" };

/** Batch keystrokes typed within this long into one call. */
export const WRITE_BATCH_MS = 8;
/** The bridge takes 64 KB per call; stay well below it. */
export const WRITE_CHUNK_BYTES = 32 * 1024;
export const RESIZE_DEBOUNCE_MS = 150;
export const BACKOFF_MIN_MS = 500;
export const BACKOFF_MAX_MS = 8_000;
/** A stream that closed cleanly after this long was alive (heartbeats), so it does not back off. */
const MIN_LIVE_MS = 5_000;

const statusOf = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "status" in error
    ? (error as { status?: unknown }).status
    : undefined;

export type OpenedTerminal = RpcOutput<"terminal/open">;

/** Opens (or takes over) the agent's terminal. `seq` 0 replays the whole kept buffer. */
export function openTerminal(agentId: string, rows: number, cols: number) {
  return rpc("terminal/open", { id: agentId, rows, cols });
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

const nextBackoff = (ms: number) => Math.min(BACKOFF_MAX_MS, ms * 2);

/** Unsent input beyond this is dropped, oldest first. */
const QUEUE_MAX_BYTES = 256 * 1024;

/**
 * One queued input call. `n` belongs to `terminalId` and is reused by every retry of the call.
 * Input rules across terminals: an item never sent is numbered for whichever terminal is current;
 * one already attempted on an older terminal has an unknown outcome and is dropped, never
 * retyped (a repeated "...\r" would run a command twice; the replayed screen shows what landed).
 * Input is also cleared on taken_over, ended and stream errors, so typing made while the
 * terminal was away is never typed later.
 */
type Pending = { bytes: Uint8Array; terminalId?: string; n?: number; attempts: number };

/** A 4xx other than a timeout or rate limit will not change by asking again. */
const isFinal4xx = (error: unknown) => {
  const status = statusOf(error);
  return (
    typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429
  );
};
const retryAfterOf = (error: unknown): number =>
  typeof error === "object" && error !== null && "retryAfterMs" in error
    ? Number((error as { retryAfterMs?: unknown }).retryAfterMs) || 0
    : 0;

export type TerminalClient = {
  readonly state: TerminalState;
  /** Types the bytes; order is kept across batching, retries and reconnects. */
  write(bytes: Uint8Array): void;
  /** Debounced to the last size. */
  resize(rows: number, cols: number): void;
  /** Opens the terminal again after another client took it over. */
  reopen(): void;
  onOutput(callback: (chunk: TerminalOutput) => void): () => void;
  /** Called with the error when the bridge refuses one input call (the call is dropped). */
  onInputError(callback: (error: unknown) => void): () => void;
  onState(callback: (state: TerminalState) => void): () => void;
  dispose(): void;
};

/**
 * Drives one agent terminal: open, follow the output stream and type input. After an error it
 * opens again (a new terminalId, so `n` restarts at 1), clears the screen and replays from the
 * seq open returns. After a clean stream end it resubscribes from the last seq without opening.
 * `ended` stops for good; `taken_over` waits for `reopen()` since another client owns the terminal.
 */
export function createTerminalClient(
  agentId: string,
  size: { rows: number; cols: number },
): TerminalClient {
  let { rows, cols } = size;
  let state: TerminalState = "connecting";
  let terminalId: string | undefined;
  let cursor = 0;
  let nextN = 1;
  let disposed = false;
  let running = false;
  let everOpened = false;
  let controller = new AbortController();
  const outputs = new Set<(chunk: TerminalOutput) => void>();
  const states = new Set<(state: TerminalState) => void>();
  const inputErrors = new Set<(error: unknown) => void>();

  let batch: Uint8Array[] = [];
  let batchTimer: ReturnType<typeof setTimeout> | undefined;
  const queue: Pending[] = [];
  let pumping = false;
  let pumpTimer: ReturnType<typeof setTimeout> | undefined;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  let pumpWake: (() => void) | undefined;

  const setState = (next: TerminalState) => {
    if (state === next) return;
    state = next;
    for (const callback of states) callback(next);
  };
  /** `state` as of now; narrowing cannot see the callbacks that change it. */
  const stopped = () => state === "ended" || state === "taken_over";
  const emit = (chunk: TerminalOutput) => {
    for (const callback of outputs) callback(chunk);
  };
  /** Sleeps unless disposed or stopped sooner; resolves false when the loop should give up. */
  const sleep = (ms: number) =>
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        wake = undefined;
        resolve(!disposed);
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = undefined;
        resolve(false);
      };
    });

  const settled = (next: "ended" | "taken_over") => {
    setState(next);
    controller.abort();
    queue.length = 0;
  };

  const onFrame = (json: unknown) => {
    if (typeof json !== "object" || json === null) return;
    const frame = json as TerminalFrame;
    if (typeof frame.seq !== "number") return;
    if (frame.seq <= cursor) return;
    cursor = frame.seq;
    if (frame.taken_over) return settled("taken_over");
    if (frame.ended) return settled("ended");
    if (frame.reset) emit({ kind: "clear" });
    if (typeof frame.data === "string" && frame.data) {
      emit({ kind: "data", data: fromBase64(frame.data) });
    }
  };

  const run = async () => {
    if (running) return;
    running = true;
    let needOpen = true;
    let backoff = BACKOFF_MIN_MS;
    try {
      while (!disposed && !stopped()) {
        controller = new AbortController();
        const signal = controller.signal;
        const started = Date.now();
        let received = false;
        try {
          if (needOpen) {
            setState("connecting");
            const asked = { rows, cols };
            const opened = await openTerminal(agentId, asked.rows, asked.cols);
            if (disposed) return;
            terminalId = opened.terminalId;
            nextN = 1;
            cursor = opened.seq;
            // The queue holds no attempted item here: every way to a new open (an error, a
            // taken_over, ended) cleared it first, so none can be retyped on the new terminal.
            if (everOpened) emit({ kind: "clear" });
            everOpened = true;
            needOpen = false;
            if (asked.rows !== rows || asked.cols !== cols) sendResize();
          }
          setState("live");
          void pump();
          await streamRpc("terminal/subscribe", { terminalId, cursor }, signal, (json) => {
            if (!received) backoff = BACKOFF_MIN_MS;
            received = true;
            onFrame(json);
          });
        } catch (error) {
          if (disposed) return;
          // Opening is refused for good (unknown agent, no access): asking again changes nothing.
          if (needOpen && isFinal4xx(error)) {
            queue.length = 0;
            return setState("error");
          }
          // The same terminal answering 404: another client's open retired it.
          if (!needOpen && statusOf(error) === 404) return settled("taken_over");
          needOpen = true;
          setState("error");
          queue.length = 0;
          if (!(await sleep(Math.max(backoff, retryAfterOf(error))))) return;
          backoff = nextBackoff(backoff);
          continue;
        }
        if (disposed || stopped()) return;
        // Clean end (the server closes a stream after its time limit): resume, no open. A stream
        // that closes at once without a frame backs off so it cannot spin.
        if (received || Date.now() - started >= MIN_LIVE_MS) continue;
        if (!(await sleep(backoff))) return;
        backoff = nextBackoff(backoff);
      }
    } finally {
      running = false;
    }
  };

  /** Sends queued input one call at a time; a failed call is retried with the same `n`. */
  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    let backoff = BACKOFF_MIN_MS;
    try {
      while (!disposed && queue.length > 0 && state === "live" && terminalId) {
        const item = queue[0] as Pending;
        if (item.terminalId === undefined) {
          item.terminalId = terminalId;
          item.n = nextN;
          nextN += 1;
        }
        const sentTo = terminalId;
        item.attempts += 1;
        try {
          await rpc("terminal/input", {
            terminalId: sentTo,
            data: toBase64(item.bytes),
            n: item.n as number,
          });
          const at = queue.indexOf(item);
          if (at >= 0) queue.splice(at, 1);
          backoff = BACKOFF_MIN_MS;
        } catch (error) {
          if (disposed) return;
          // The terminal was reopened meanwhile and the item dropped: carry on with the rest.
          if (terminalId !== sentTo) continue;
          // Retired (taken over or closed): keep the item and stop; the stream says which.
          if (statusOf(error) === 404) return;
          if (isFinal4xx(error)) {
            // This call was refused, not the connection: drop it and go on. Its number goes back
            // only after a first attempt; an earlier one of unknown outcome may have landed, and
            // reusing the number would then swallow the next call.
            const at = queue.indexOf(item);
            if (at >= 0) queue.splice(at, 1);
            if (item.attempts === 1 && item.n === nextN - 1) nextN -= 1;
            for (const callback of inputErrors) callback(error);
            continue;
          }
          await new Promise<void>((resolve) => {
            pumpWake = resolve;
            pumpTimer = setTimeout(resolve, backoff);
          });
          pumpWake = undefined;
          backoff = nextBackoff(backoff);
        }
      }
    } finally {
      pumping = false;
    }
  }

  const sendResize = () => {
    if (!terminalId) return;
    // Best effort: the next open carries the size anyway.
    rpc("terminal/resize", { terminalId, rows, cols }).catch(() => undefined);
  };

  const flush = () => {
    batchTimer = undefined;
    const total = batch.reduce((sum, part) => sum + part.length, 0);
    const joined = new Uint8Array(total);
    let at = 0;
    for (const part of batch) {
      joined.set(part, at);
      at += part.length;
    }
    batch = [];
    if (state === "error" || stopped()) return;
    for (let i = 0; i < joined.length; i += WRITE_CHUNK_BYTES) {
      queue.push({ bytes: joined.subarray(i, i + WRITE_CHUNK_BYTES), attempts: 0 });
    }
    let queued = queue.reduce(
      (sum, item) => (item.terminalId === undefined ? sum + item.bytes.length : sum),
      0,
    );
    for (let i = 0; queued > QUEUE_MAX_BYTES && i < queue.length; ) {
      const item = queue[i] as Pending;
      if (item.terminalId !== undefined) {
        i += 1;
        continue;
      }
      queued -= item.bytes.length;
      queue.splice(i, 1);
    }
    void pump();
  };

  void run();

  return {
    get state() {
      return state;
    },
    write(bytes) {
      if (disposed || state === "error" || stopped() || bytes.length === 0) return;
      batch.push(bytes.slice());
      batchTimer ??= setTimeout(flush, WRITE_BATCH_MS);
    },
    resize(nextRows, nextCols) {
      rows = nextRows;
      cols = nextCols;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (disposed || state !== "live") return;
        sendResize();
      }, RESIZE_DEBOUNCE_MS);
    },
    reopen() {
      if (disposed || running || state === "live") return;
      state = "connecting";
      for (const callback of states) callback(state);
      void run();
    },
    onOutput(callback) {
      outputs.add(callback);
      return () => outputs.delete(callback);
    },
    onInputError(callback) {
      inputErrors.add(callback);
      return () => inputErrors.delete(callback);
    },
    onState(callback) {
      states.add(callback);
      return () => states.delete(callback);
    },
    dispose() {
      disposed = true;
      controller.abort();
      clearTimeout(batchTimer);
      clearTimeout(pumpTimer);
      clearTimeout(resizeTimer);
      wake?.();
      pumpWake?.();
    },
  };
}

/**
 * The terminal of one agent: connection state, input, resize and a subscription to its output.
 * `size` only seeds the first open; after that callers report the real size with resize().
 */
export function useTerminal(
  agentId: string,
  size: { rows: number; cols: number } = { rows: 24, cols: 80 },
) {
  const [state, setState] = useState<TerminalState>("connecting");
  const client = useRef<TerminalClient | undefined>(undefined);
  const listeners = useRef(new Set<(chunk: TerminalOutput) => void>());
  const { rows, cols } = size;

  useEffect(() => {
    setState("connecting");
    const next = createTerminalClient(agentId, { rows, cols });
    client.current = next;
    const stopState = next.onState(setState);
    const stopOutput = next.onOutput((chunk) => {
      for (const callback of listeners.current) callback(chunk);
    });
    return () => {
      stopState();
      stopOutput();
      next.dispose();
      if (client.current === next) client.current = undefined;
    };
  }, [agentId]);

  const write = useCallback((bytes: Uint8Array) => client.current?.write(bytes), []);
  const resize = useCallback(
    (nextRows: number, nextCols: number) => client.current?.resize(nextRows, nextCols),
    [],
  );
  const onInputError = useCallback(
    (callback: (error: unknown) => void) =>
      client.current?.onInputError(callback) ?? (() => undefined),
    [],
  );
  const reopen = useCallback(() => client.current?.reopen(), []);
  const onOutput = useCallback((callback: (chunk: TerminalOutput) => void) => {
    listeners.current.add(callback);
    return () => {
      listeners.current.delete(callback);
    };
  }, []);

  return { state, write, resize, reopen, onOutput, onInputError };
}
