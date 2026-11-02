import type { RpcOutput, TerminalFrame } from "@rakazo/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { rpc, streamRpc } from "./api";
import { base64ToBytes as fromBase64, bytesToBase64 as toBase64 } from "./terminal-bridge";

/**
 * `error` is backing off before another try; `busy` is the same after a 429 (too many open
 * terminals); `failed` means the client gave up (a refusal asking again cannot change);
 * `relay_down` is the same after a 503 HOST_NOT_CONNECTED (the host's relay is not running).
 */
export type TerminalState =
  | "connecting"
  | "live"
  | "ended"
  | "taken_over"
  | "error"
  | "busy"
  | "failed"
  | "relay_down";

/**
 * Screen output: bytes to feed the emulator, or a signal to wipe it before a replay. A frame's
 * data carries the pane's own size (`rows`, `cols`), which the emulator must take before writing;
 * `reset` marks a whole screen (it starts by clearing, so it replaces everything before it).
 */
export type TerminalOutput =
  | { kind: "data"; data: Uint8Array; rows?: number; cols?: number; reset?: boolean }
  | { kind: "clear" };

/** Batch keystrokes typed within this long into one call. */
export const WRITE_BATCH_MS = 8;
/** The bridge takes 64 KB per call; stay well below it. */
export const WRITE_CHUNK_BYTES = 32 * 1024;
/** Closing waits this long for the zoom-off before it retires the terminal anyway. */
export const CLOSE_ZOOM_WAIT_MS = 500;
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
const codeOf = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
const retryAfterOf = (error: unknown): number =>
  typeof error === "object" && error !== null && "retryAfterMs" in error
    ? Number((error as { retryAfterMs?: unknown }).retryAfterMs) || 0
    : 0;

export type TerminalClient = {
  readonly state: TerminalState;
  /** Types the bytes; order is kept across batching, retries and reconnects. */
  write(bytes: Uint8Array): void;
  /** Asks the relay to zoom the pane (or not); the pane keeps its own size. */
  setZoom(on: boolean): void;
  /**
   * Why the stream stopped: the server's `reason` for `ended`; "gone" for a `taken_over` nobody
   * announced (the terminal 404ed on resubscribe: closed or opened elsewhere, unknown which).
   */
  readonly endReason: string | undefined;
  /** Opens the terminal again after another client took it over, it ended, or the client gave up. */
  reopen(): void;
  /** Retires the terminal on the server (best effort) and stops; `dispose` alone leaves it. */
  close(): void;
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
  // The size the terminal was opened at, then the pane's own as frames report it.
  let { rows, cols } = size;
  let endReason: string | undefined;
  let zoomOn = false;
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
    if (frame.ended) {
      endReason = frame.reason;
      return settled("ended");
    }
    if (frame.rows !== undefined && frame.cols !== undefined) {
      ({ rows, cols } = { rows: frame.rows, cols: frame.cols });
    }
    if (typeof frame.data === "string" && frame.data) {
      emit({
        kind: "data",
        data: fromBase64(frame.data),
        rows: frame.rows,
        cols: frame.cols,
        ...(frame.reset ? { reset: true } : {}),
      });
    }
  };

  const run = async () => {
    if (running) return;
    running = true;
    let needOpen = true;
    // A dropped connection resubscribes the same terminal once before asking to open again:
    // returning from the background must never take the terminal back from another client.
    let resubscribing = false;
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
            const opened = await openTerminal(agentId, rows, cols);
            if (disposed) return;
            terminalId = opened.terminalId;
            nextN = 1;
            cursor = opened.seq;
            // The queue holds no attempted item here: every way to a new open (an error, a
            // taken_over, ended) cleared it first, so none can be retyped on the new terminal.
            if (everOpened) emit({ kind: "clear" });
            everOpened = true;
            needOpen = false;
            endReason = undefined;
          }
          setState("live");
          void pump();
          await streamRpc("terminal/subscribe", { terminalId, cursor }, signal, (json) => {
            if (!received) backoff = BACKOFF_MIN_MS;
            received = true;
            onFrame(json);
          });
          resubscribing = false;
        } catch (error) {
          if (disposed) return;
          // Opening is refused for good (unknown agent, no access): asking again changes nothing.
          if (needOpen && isFinal4xx(error)) {
            queue.length = 0;
            return setState("failed");
          }
          // The host's relay is not running: it will not start by asking again.
          if (needOpen && statusOf(error) === 503 && codeOf(error) === "HOST_NOT_CONNECTED") {
            queue.length = 0;
            return setState("relay_down");
          }
          // The same terminal answering 404: another client's open retired it.
          if (!needOpen && statusOf(error) === 404) {
            endReason = "gone";
            return settled("taken_over");
          }
          // A transport error (no HTTP status) on a live terminal: resubscribe it first.
          if (!needOpen && !resubscribing && statusOf(error) === undefined) resubscribing = true;
          else {
            needOpen = true;
            resubscribing = false;
          }
          setState(statusOf(error) === 429 ? "busy" : "error");
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
    if (state === "error" || state === "busy" || state === "failed" || stopped()) return;
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

  const client: TerminalClient = {
    get state() {
      return state;
    },
    write(bytes) {
      if (disposed || state === "error" || state === "busy" || state === "failed") return;
      if (stopped() || bytes.length === 0) return;
      batch.push(bytes.slice());
      batchTimer ??= setTimeout(flush, WRITE_BATCH_MS);
    },
    get endReason() {
      return endReason;
    },
    setZoom(on) {
      if (!terminalId || disposed || state !== "live") return;
      zoomOn = on;
      // Best effort. The relay ignores the size: the pane owns it, and the schema wants one.
      rpc("terminal/resize", { terminalId, rows, cols, zoom: on }).catch(() => undefined);
    },
    reopen() {
      if (disposed || running || state === "live" || state === "connecting") return;
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
    close() {
      if (terminalId && !disposed && !stopped()) {
        const id = terminalId;
        const retire = () => rpc("terminal/close", { terminalId: id }).catch(() => undefined);
        if (zoomOn) {
          // Leave the pane unzoomed, but never hold the close up for it.
          let retired = false;
          const once = () => {
            if (retired) return;
            retired = true;
            void retire();
          };
          rpc("terminal/resize", { terminalId: id, rows, cols, zoom: false })
            .catch(() => undefined)
            .then(once);
          setTimeout(once, CLOSE_ZOOM_WAIT_MS);
        } else void retire();
      }
      client.dispose();
    },
    dispose() {
      disposed = true;
      controller.abort();
      clearTimeout(batchTimer);
      clearTimeout(pumpTimer);
      wake?.();
      pumpWake?.();
    },
  };
  return client;
}

/**
 * The terminal of one agent: connection state, input, zoom and a subscription to its output.
 * `size` only seeds the open: the pane owns its size and each frame reports it. The terminal is closed on the server when the agent changes or the view goes away
 * for good; backgrounding or an app kill leaves it for a reattach.
 */
export function useTerminal(
  agentId: string,
  size: { rows: number; cols: number } = { rows: 24, cols: 80 },
  /** Set while the view is only being rebuilt: its terminal stays open for the next one. */
  retain?: { current: boolean },
) {
  const [state, setState] = useState<TerminalState>("connecting");
  const [reason, setReason] = useState<string | undefined>(undefined);
  const client = useRef<TerminalClient | undefined>(undefined);
  const listeners = useRef(new Set<(chunk: TerminalOutput) => void>());
  const errorListeners = useRef(new Set<(error: unknown) => void>());
  const { rows, cols } = size;

  useEffect(() => {
    setState("connecting");
    setReason(undefined);
    const next = createTerminalClient(agentId, { rows, cols });
    client.current = next;
    const stopState = next.onState((value) => {
      setReason(value === "ended" || value === "taken_over" ? next.endReason : undefined);
      setState(value);
    });
    const stopOutput = next.onOutput((chunk) => {
      for (const callback of listeners.current) callback(chunk);
    });
    const stopInputError = next.onInputError((error) => {
      for (const callback of errorListeners.current) callback(error);
    });
    return () => {
      stopState();
      stopOutput();
      stopInputError();
      if (retain?.current) next.dispose();
      else next.close();
      if (client.current === next) client.current = undefined;
    };
  }, [agentId]);

  const write = useCallback((bytes: Uint8Array) => client.current?.write(bytes), []);
  const setZoom = useCallback((on: boolean) => client.current?.setZoom(on), []);
  const onInputError = useCallback((callback: (error: unknown) => void) => {
    errorListeners.current.add(callback);
    return () => {
      errorListeners.current.delete(callback);
    };
  }, []);
  const reopen = useCallback(() => client.current?.reopen(), []);
  const onOutput = useCallback((callback: (chunk: TerminalOutput) => void) => {
    listeners.current.add(callback);
    return () => {
      listeners.current.delete(callback);
    };
  }, []);

  return { state, reason, write, setZoom, reopen, onOutput, onInputError };
}
