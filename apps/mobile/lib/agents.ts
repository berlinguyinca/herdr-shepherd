import type { AgentEvent, AgentRow, RpcInput } from "@rakazo/contracts";
import { rpc, streamRpc } from "./api";
import { rpcQuery } from "./query";

export type { AgentEvent, AgentRow };

const statusOf = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "status" in error
    ? (error as { status?: unknown }).status
    : undefined;

/** The server has no Agents procedures at all, so it is too old for the tab. */
export class AgentsUnsupportedError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("This server does not support agents", options);
    this.name = "AgentsUnsupportedError";
  }
}

/** The agent id is unknown or closed (a 404 from get, messages or event). */
export class AgentGoneError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("This agent is no longer available", options);
    this.name = "AgentGoneError";
  }
}

/**
 * True for the error `agents/list` raises when the server lacks the Agents view. Only the list
 * call can say so: a 404 there is always an unknown procedure, while a 404 from get, messages
 * or event can also mean an unknown agent id (see isAgentGone).
 */
export function isAgentsUnsupported(error: unknown): boolean {
  return error instanceof AgentsUnsupportedError;
}

/** True when get, messages or event answered 404 because the agent no longer exists. */
export function isAgentGone(error: unknown): boolean {
  return error instanceof AgentGoneError;
}

async function classify<T>(call: () => Promise<T>, wrap: (cause: unknown) => Error): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw statusOf(error) === 404 ? wrap(error) : error;
  }
}

const unsupported = (cause: unknown) => new AgentsUnsupportedError({ cause });
const gone = (cause: unknown) => new AgentGoneError({ cause });

/** The list of agents; `showOlder` also returns the ones hidden as closed or stale. */
export function agentListQuery(showOlder: boolean) {
  const query = rpcQuery("agents/list", { showOlder });
  return {
    ...query,
    queryFn: (ctx: never) => classify(async () => query.queryFn(ctx), unsupported),
  };
}

export function getAgent(id: string) {
  return classify(() => rpc("agents/get", { id }), gone);
}

export function agentMessages(input: RpcInput<"agents/messages">) {
  return classify(() => rpc("agents/messages", input), gone);
}

export function agentEvent(id: string, seq: number) {
  return classify(() => rpc("agents/event", { id, seq }), gone);
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
      // A 404 on a stream is an unknown procedure (too old) or a vanished agent: stop either way.
      if (status === 429 || status === 404) return fallback();
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
