import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEvent, AgentRow } from "./agents";
import { agentMessages, getAgent, isAgentGone, subscribeAgent } from "./agents";
import { useAppForeground } from "./app-foreground";

export const PAGE_SIZE = 50;
/** Poll interval while the stream is down. */
export const POLL_MS = 5_000;
/** How often an open stream is cross-checked with a read of the newest page. */
export const RECONCILE_MS = 15_000;
/** After the stream fell back, a poll that works this long afterwards tries the stream again. */
export const STREAM_RETRY_MS = 60_000;

/**
 * Merges events by seq, oldest first. A same-seq event replaces the loaded one only when its rev
 * is not older, so a slow read that resolves after a stream frame cannot revert a finished tool call.
 */
export function mergeEvents(current: AgentEvent[], incoming: AgentEvent[]): AgentEvent[] {
  if (incoming.length === 0) return current;
  const bySeq = new Map(current.map((event) => [event.seq, event]));
  for (const event of incoming) {
    const existing = bySeq.get(event.seq);
    if (!existing || event.rev >= existing.rev) bySeq.set(event.seq, event);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * True when a newest page leaves a hole after the loaded events: more history sits before it and
 * its oldest seq is past the newest loaded seq + 1. Merging would hide the gap for good, so the
 * page replaces what is loaded.
 */
export function pageLeavesGap(
  loaded: AgentEvent[],
  page: { events: AgentEvent[]; hasMore: boolean },
): boolean {
  const newest = loaded.at(-1);
  if (!newest || !page.hasMore || page.events.length === 0) return false;
  return Math.min(...page.events.map((event) => event.seq)) > newest.seq + 1;
}

export type AgentConversation = {
  agent: AgentRow | null;
  /** Oldest first. */
  events: AgentEvent[];
  loading: boolean;
  /** The agent no longer exists. */
  gone: boolean;
  /** The first load failed; a failure after something loaded keeps the conversation instead. */
  failed: boolean;
  /** A reconnect failed and the conversation is being kept fresh by polling. */
  reconnecting: boolean;
  /** The agent has no captured conversation. */
  empty: boolean;
  hasMore: boolean;
  loadingOlder: boolean;
  loadOlder: () => void;
  retry: () => void;
  markGone: () => void;
};

type State = {
  id: string;
  agent: AgentRow | null;
  hasConversation: boolean;
  events: AgentEvent[];
  hasMore: boolean;
  loading: boolean;
  loadingOlder: boolean;
  loaded: boolean;
  gone: boolean;
  failed: boolean;
  polling: boolean;
  reconnecting: boolean;
};

const initial = (id: string): State => ({
  id,
  agent: null,
  hasConversation: true,
  events: [],
  hasMore: false,
  loading: true,
  loadingOlder: false,
  loaded: false,
  gone: false,
  failed: false,
  polling: false,
  reconnecting: false,
});

/**
 * One agent's conversation. On every (re)connect it reads the newest page first and subscribes
 * from the revision that read returned, never from a remembered cursor. While the stream is down
 * it polls the newest page and merges by seq; while it is up, a periodic read catches a server
 * restart (a lower rev than the subscription started from) and resubscribes.
 */
export function useAgentConversation(
  id: string,
  { pollMs = POLL_MS, reconcileMs = RECONCILE_MS }: { pollMs?: number; reconcileMs?: number } = {},
): AgentConversation {
  const foreground = useAppForeground();
  const [state, setState] = useState<State>(() => initial(id));
  const [attempt, setAttempt] = useState(0);
  const idRef = useRef(id);
  idRef.current = id;
  const current = state.id === id ? state : initial(id);
  const stateRef = useRef(current);
  stateRef.current = current;
  const olderBusy = useRef<string | null>(null);
  const subscribedRev = useRef<number | null>(null);
  const fresh = useRef(false);
  const fellBackAt = useRef(0);

  /** Applies a change to this id's state; a continuation of a previous id changes nothing. */
  const patch = useCallback((forId: string, change: (state: State) => Partial<State>) => {
    if (idRef.current !== forId) return;
    setState((prev) => {
      const base = prev.id === forId ? prev : initial(forId);
      return { ...base, ...change(base) };
    });
  }, []);

  // Connect: get the agent, read the newest page, subscribe from the returned rev.
  useEffect(() => {
    if (!foreground) return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    const replaceAll = fresh.current;
    fresh.current = false;
    patch(id, () => ({ failed: false, polling: false }));
    void (async () => {
      try {
        const [info, page] = await Promise.all([
          getAgent(id),
          agentMessages({ id, limit: PAGE_SIZE }),
        ]);
        if (cancelled) return;
        subscribedRev.current = page.rev;
        patch(id, (s) => {
          const replace = replaceAll || pageLeavesGap(s.events, page);
          return {
            agent: info.agent,
            hasConversation: info.hasConversation,
            events: replace ? mergeEvents([], page.events) : mergeEvents(s.events, page.events),
            hasMore: s.loaded && !replace ? s.hasMore : page.hasMore,
            loaded: true,
            loading: false,
            reconnecting: false,
          };
        });
        unsubscribe = subscribeAgent(
          id,
          page.rev,
          (event) => {
            if (!cancelled) patch(id, (s) => ({ events: mergeEvents(s.events, [event]) }));
          },
          () => {
            if (cancelled) return;
            fellBackAt.current = Date.now();
            patch(id, () => ({ polling: true }));
          },
        );
      } catch (error) {
        if (cancelled) return;
        if (isAgentGone(error)) patch(id, () => ({ gone: true, loading: false }));
        // A failed reconnect keeps what is on screen and polls; only a first load shows the error.
        else if (stateRef.current.loaded) patch(id, () => ({ polling: true, reconnecting: true }));
        else patch(id, () => ({ failed: true, loading: false }));
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [id, foreground, attempt, patch]);

  // Keep the conversation fresh: poll fast while the stream is down, cross-check it while up.
  const gone = current.gone;
  const polling = current.polling;
  const loaded = current.loaded;
  useEffect(() => {
    if (!foreground || gone || !loaded) return;
    let cancelled = false;
    const timer = setInterval(
      () => {
        agentMessages({ id, limit: PAGE_SIZE })
          .then((page) => {
            if (cancelled) return;
            // A rev below the subscription's means the server restarted: start over from it.
            if (subscribedRev.current !== null && page.rev < subscribedRev.current) {
              fresh.current = true;
              setAttempt((value) => value + 1);
              return;
            }
            patch(id, (s) =>
              pageLeavesGap(s.events, page)
                ? { events: mergeEvents([], page.events), hasMore: page.hasMore }
                : { events: mergeEvents(s.events, page.events) },
            );
            // A poll that worked means the server is reachable: try the stream again.
            const s = stateRef.current;
            if (s.reconnecting || (s.polling && Date.now() - fellBackAt.current >= STREAM_RETRY_MS))
              setAttempt((value) => value + 1);
          })
          .catch((error) => {
            if (!cancelled && isAgentGone(error)) patch(id, () => ({ gone: true }));
          });
      },
      polling ? pollMs : reconcileMs,
    );
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id, polling, foreground, gone, loaded, pollMs, reconcileMs, patch]);

  const loadOlder = useCallback(() => {
    const s = stateRef.current;
    const oldest = s.events[0];
    if (!oldest || !s.hasMore || olderBusy.current === id) return;
    olderBusy.current = id;
    patch(id, () => ({ loadingOlder: true }));
    agentMessages({ id, beforeSeq: oldest.seq, limit: PAGE_SIZE })
      .then((page) =>
        patch(id, (cur) => ({
          events: mergeEvents(cur.events, page.events),
          hasMore: page.hasMore,
        })),
      )
      .catch((error) => {
        if (isAgentGone(error)) patch(id, () => ({ gone: true }));
      })
      .finally(() => {
        if (olderBusy.current === id) olderBusy.current = null;
        patch(id, () => ({ loadingOlder: false }));
      });
  }, [id, patch]);

  const retry = useCallback(() => {
    patch(id, () => ({ loading: true, failed: false }));
    setAttempt((value) => value + 1);
  }, [id, patch]);
  const markGone = useCallback(() => patch(id, () => ({ gone: true })), [id, patch]);

  return {
    agent: current.agent,
    events: current.events,
    loading: current.loading,
    gone: current.gone,
    failed: current.failed,
    reconnecting: current.reconnecting,
    empty:
      !current.loading &&
      !current.gone &&
      !current.failed &&
      current.events.length === 0 &&
      !current.hasConversation,
    hasMore: current.hasMore,
    loadingOlder: current.loadingOlder,
    loadOlder,
    retry,
    markGone,
  };
}
