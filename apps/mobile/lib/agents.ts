import type { AgentEvent, AgentRow } from "@rakazo/contracts";
import { streamRpc } from "./api";
import { rpcQuery } from "./query";

export type { AgentEvent, AgentRow };

/** The list of agents; `showOlder` also returns the ones hidden as closed or stale. */
export function agentListQuery(showOlder: boolean) {
  return rpcQuery("agents/list", { showOlder });
}

/**
 * True when the server does not have the Agents procedures at all (an unknown-procedure 404),
 * so the tab can say the server is too old. Network failures and other statuses are not that.
 */
export function isAgentsUnsupported(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 404
  );
}

type FollowOptions = {
  /** Wait before reopening a closed stream. */
  reconnectMs?: number;
  /** Streams that end without delivering a frame this many times in a row fall back to polling. */
  maxIdleReconnects?: number;
};

/**
 * Follows a stream, resuming from the last frame's seq after it closes. A 429 (too many live
 * connections), an unsupported server, or repeated empty reconnects call `onFallback` once and
 * stop, so the caller polls instead. Returns the unsubscribe function.
 */
function follow<F extends { seq: number }>(
  proc: "agents/subscribe" | "agents/subscribeList",
  bodyFor: (cursor: number) => object,
  parse: (json: unknown) => F | undefined,
  startCursor: number,
  onFrame: (frame: F) => void,
  onFallback: () => void,
  { reconnectMs = 1_000, maxIdleReconnects = 3 }: FollowOptions = {},
): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cursor = startCursor;
  let idle = 0;
  const fallback = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    clearTimeout(timer);
    onFallback();
  };
  const run = async () => {
    let received = false;
    try {
      await streamRpc(proc, bodyFor(cursor), controller.signal, (json) => {
        const frame = parse(json);
        if (!frame) return;
        received = true;
        if (frame.seq > cursor) cursor = frame.seq;
        onFrame(frame);
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      const status = (error as { status?: unknown } | null)?.status;
      if (status === 429 || isAgentsUnsupported(error)) return fallback();
    }
    if (controller.signal.aborted) return;
    idle = received ? 0 : idle + 1;
    if (idle >= maxIdleReconnects) return fallback();
    timer = setTimeout(run, reconnectMs);
  };
  void run();
  return () => {
    controller.abort();
    clearTimeout(timer);
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Live rows from `cursor` (the list's `cursor`, or -1 for a full snapshot). A row that left the
 * visible set arrives once with its closed or stale status so the caller can drop it.
 */
export function subscribeAgentList(
  cursor: number,
  onRow: (row: AgentRow) => void,
  onFallback: () => void,
  options?: FollowOptions,
): () => void {
  return follow(
    "agents/subscribeList",
    (next) => ({ cursor: next }),
    (json) =>
      isRecord(json) && typeof json.seq === "number" && isRecord(json.row)
        ? { seq: json.seq, row: json.row as AgentRow }
        : undefined,
    cursor,
    (frame) => onRow(frame.row),
    onFallback,
    options,
  );
}

/** Live events of one agent's conversation after `rev`, the revision `agents/messages` returned. */
export function subscribeAgent(
  id: string,
  rev: number,
  onEvent: (event: AgentEvent) => void,
  onFallback: () => void,
  options?: FollowOptions,
): () => void {
  return follow(
    "agents/subscribe",
    (cursor) => ({ id, cursor }),
    (json) =>
      isRecord(json) && typeof json.seq === "number" && isRecord(json.event)
        ? { seq: json.seq, event: json.event as AgentEvent }
        : undefined,
    rev,
    (frame) => onEvent(frame.event),
    onFallback,
    options,
  );
}
