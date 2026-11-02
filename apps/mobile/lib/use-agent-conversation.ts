import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEvent, AgentRow } from "./agents";
import { agentMessages, getAgent, isAgentGone, subscribeAgent } from "./agents";
import { useAppForeground } from "./app-foreground";

export const PAGE_SIZE = 50;
export const POLL_MS = 5_000;

/** Merges events by seq: a same-seq event replaces the loaded one, new ones are added, oldest first. */
export function mergeEvents(current: AgentEvent[], incoming: AgentEvent[]): AgentEvent[] {
  if (incoming.length === 0) return current;
  const bySeq = new Map(current.map((event) => [event.seq, event]));
  for (const event of incoming) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export type AgentConversation = {
  agent: AgentRow | null;
  /** Oldest first. */
  events: AgentEvent[];
  loading: boolean;
  /** The agent no longer exists. */
  gone: boolean;
  failed: boolean;
  /** The agent has no captured conversation. */
  empty: boolean;
  hasMore: boolean;
  loadingOlder: boolean;
  loadOlder: () => void;
  retry: () => void;
};

/**
 * One agent's conversation. On every (re)connect it reads the newest page first and subscribes
 * from the revision that read returned, never from a remembered cursor. While the stream is down
 * it polls the newest page every few seconds and merges by seq.
 */
export function useAgentConversation(id: string): AgentConversation {
  const foreground = useAppForeground();
  const [agent, setAgent] = useState<AgentRow | null>(null);
  const [hasConversation, setHasConversation] = useState(true);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [gone, setGone] = useState(false);
  const [failed, setFailed] = useState(false);
  const [polling, setPolling] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const olderBusy = useRef(false);
  const loaded = useRef(false);

  // Connect: get the agent, read the newest page, subscribe from the returned rev.
  useEffect(() => {
    if (!foreground) return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    const fail = (error: unknown) => {
      if (cancelled) return;
      if (isAgentGone(error)) setGone(true);
      else setFailed(true);
      setLoading(false);
    };
    setFailed(false);
    setPolling(false);
    void (async () => {
      try {
        const [info, page] = await Promise.all([
          getAgent(id),
          agentMessages({ id, limit: PAGE_SIZE }),
        ]);
        if (cancelled) return;
        setAgent(info.agent);
        setHasConversation(info.hasConversation);
        setEvents((current) => mergeEvents(current, page.events));
        if (!loaded.current) setHasMore(page.hasMore);
        loaded.current = true;
        setLoading(false);
        unsubscribe = subscribeAgent(
          id,
          page.rev,
          (event) => setEvents((current) => mergeEvents(current, [event])),
          () => setPolling(true),
        );
      } catch (error) {
        fail(error);
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [id, foreground, attempt]);

  // While the stream is down, re-read the newest page and merge.
  useEffect(() => {
    if (!polling || !foreground || gone) return;
    let cancelled = false;
    const timer = setInterval(() => {
      agentMessages({ id, limit: PAGE_SIZE })
        .then((page) => {
          if (!cancelled) setEvents((current) => mergeEvents(current, page.events));
        })
        .catch((error) => {
          if (!cancelled && isAgentGone(error)) setGone(true);
        });
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id, polling, foreground, gone]);

  const loadOlder = useCallback(() => {
    const oldest = eventsRef.current[0];
    if (!oldest || !hasMore || olderBusy.current) return;
    olderBusy.current = true;
    setLoadingOlder(true);
    agentMessages({ id, beforeSeq: oldest.seq, limit: PAGE_SIZE })
      .then((page) => {
        setEvents((current) => mergeEvents(current, page.events));
        setHasMore(page.hasMore);
      })
      .catch((error) => {
        if (isAgentGone(error)) setGone(true);
      })
      .finally(() => {
        olderBusy.current = false;
        setLoadingOlder(false);
      });
  }, [id, hasMore]);

  const retry = useCallback(() => {
    setLoading(true);
    setAttempt((value) => value + 1);
  }, []);

  return {
    agent,
    events,
    loading,
    gone,
    failed,
    empty: !loading && !gone && !failed && events.length === 0 && !hasConversation,
    hasMore,
    loadingOlder,
    loadOlder,
    retry,
  };
}
