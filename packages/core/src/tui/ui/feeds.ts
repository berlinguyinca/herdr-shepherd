import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { AgentRow } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import {
  applyListFrame,
  chatLineFor,
  formatAgentEvent,
  messageText,
  sanitize,
  sortAgents,
} from "../render.js";
import type { TuiClient } from "../rpc.js";
import { explainRpcError } from "../rpc.js";
import { createInputSequencer } from "../terminal-io.js";
import type { SidebarItem } from "./state.js";
import { itemKey } from "./state.js";

export type Line = { key: string; tone: "you" | "them" | "event"; text: string };
export type Report = (message: string) => void;
/** A question a room or bot is waiting on; `a` answers it. */
export type Ask = { runId: string; messageId: string; text: string };
export type Target = { botId: string } | { groupId: string };

const targetOf = (item: SidebarItem): Target =>
  item.kind === "room" ? { groupId: item.id } : { botId: item.id };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The open question in a message, if any; `answered` asks and plain text give undefined. */
function askIn(message: Record<string, unknown>): Ask | undefined {
  const blocks = Array.isArray(message.blocks) ? message.blocks : [];
  const messageId = message.id ?? message.messageId;
  if (typeof message.runId !== "string" || typeof messageId !== "string") return undefined;
  for (const block of blocks) {
    if (isRecord(block) && block.kind === "ask" && typeof block.text === "string") {
      return block.status === "pending"
        ? { runId: message.runId, messageId, text: sanitize(block.text) }
        : undefined;
    }
  }
  return undefined;
}

const MAX_LINES = 500;
const RETRY_MS = 1500;
const SETTLE_MS = 250;

/**
 * Runs a stream until `signal` aborts, reopening it after a drop or a clean end. `open` reads the
 * latest cursor itself, so a reconnect resumes where the last frame left off.
 */
export async function follow<F>(
  label: string,
  open: (signal: AbortSignal) => Promise<AsyncIterable<F>>,
  onFrame: (frame: F) => void,
  signal: AbortSignal,
  report: Report,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const frames = (await open(signal))[Symbol.asyncIterator]();
      // Aborting right as the stream opens can miss the connection, so hang up explicitly too.
      const hangUp = () => void frames.return?.().catch(() => undefined);
      signal.addEventListener("abort", hangUp, { once: true });
      if (signal.aborted) hangUp();
      try {
        for (let next = await frames.next(); !next.done; next = await frames.next()) {
          onFrame(next.value);
        }
      } finally {
        signal.removeEventListener("abort", hangUp);
      }
    } catch (error) {
      if (signal.aborted) return;
      report(explainRpcError(error, label).message);
    }
    await sleep(RETRY_MS, undefined, { signal }).catch(() => undefined);
  }
}

/** True when the account has no collaboration link, so the server has no rooms to list. */
const isCollaborationUnlinked = (error: unknown): boolean =>
  isRecord(error) &&
  error.status === 400 &&
  typeof error.message === "string" &&
  /not linked/i.test(error.message);

/** The rooms, or undefined while unknown and when the account is not linked (no Rooms section). */
export function useRooms(
  client: TuiClient,
  tick: number,
  report: Report,
): { id: string; name: string }[] | undefined {
  const [rooms, setRooms] = useState<{ id: string; name: string }[] | undefined>();
  useEffect(() => {
    let live = true;
    client.groups.list().then(
      (list) =>
        live &&
        setRooms(list.filter((room) => !room.archivedAt).map((r) => ({ id: r.id, name: r.name }))),
      (error) => {
        if (!live) return;
        if (isCollaborationUnlinked(error)) setRooms(undefined);
        else report(explainRpcError(error, "groups/list").message);
      },
    );
    return () => {
      live = false;
    };
  }, [client, tick, report]);
  return rooms;
}

/** The agent list, kept current from the list stream. `tick` reloads it. */
export function useAgents(client: TuiClient, tick: number, report: Report): AgentRow[] {
  const [rows, setRows] = useState<AgentRow[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    const byId = new Map<string, AgentRow>();
    const publish = () => setRows(sortAgents(byId.values()));
    let cursor = -1;
    void (async () => {
      try {
        const list = await client.agents.list({});
        for (const row of list.agents) byId.set(row.id, row);
        cursor = list.cursor;
        publish();
      } catch (error) {
        if (!controller.signal.aborted) report(explainRpcError(error, "agents/list").message);
        return;
      }
      await follow(
        "agents/subscribeList",
        (signal) => client.agents.subscribeList({ cursor }, { signal }),
        (frame) => {
          // Keep-alive frames carry no row.
          if (!frame.row) return;
          cursor = frame.seq;
          applyListFrame(byId, frame.row);
          publish();
        },
        controller.signal,
        report,
      );
    })();
    return () => controller.abort();
  }, [client, tick, report]);
  return rows;
}

export function useBots(
  client: TuiClient,
  tick: number,
  report: Report,
): { id: string; name: string }[] {
  const [bots, setBots] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let live = true;
    client.bots.list().then(
      (list) => live && setBots(list.map((bot) => ({ id: bot.id, name: bot.name }))),
      // A server without bots (or without this route) just shows no bots section.
      (error) => live && report(explainRpcError(error, "bots/list").message),
    );
    return () => {
      live = false;
    };
  }, [client, tick, report]);
  return bots;
}

/** History plus live follow for the selected item. Frames without an event are keep-alives. */
export function useTimeline(
  client: TuiClient,
  item: SidebarItem | undefined,
  tick: number,
  report: Report,
): { lines: Line[]; ask: Ask | undefined } {
  const [lines, setLines] = useState<Line[]>([]);
  const [ask, setAsk] = useState<Ask | undefined>();
  const key = item ? itemKey(item) : "";
  useEffect(() => {
    setLines([]);
    setAsk(undefined);
    if (!item) return;
    const controller = new AbortController();
    const seen = new Set<string>();
    const add = (more: Line[]) => {
      const fresh = more.filter((line) => !seen.has(line.key));
      for (const line of fresh) seen.add(line.key);
      if (fresh.length > 0) setLines((prev) => [...prev, ...fresh].slice(-MAX_LINES));
    };
    // Holding a key walks the whole list; the bridge rate-limits calls, so follow only once the
    // selection has settled.
    const settle = setTimeout(() => {
      if (item.kind === "agent") void followAgent(client, item.id, add, controller.signal, report);
      else void followThread(client, targetOf(item), add, setAsk, controller.signal, report);
    }, SETTLE_MS);
    return () => {
      clearTimeout(settle);
      controller.abort();
    };
  }, [client, key, tick, report]);
  return { lines, ask };
}

type Add = (lines: Line[]) => void;

async function followAgent(
  client: TuiClient,
  id: string,
  add: Add,
  signal: AbortSignal,
  report: Report,
): Promise<void> {
  let cursor: number;
  try {
    const page = await client.agents.messages({ id });
    add(
      [...page.events].reverse().map((event) => ({
        key: `e${event.seq}`,
        tone: "event",
        text: formatAgentEvent(event),
      })),
    );
    cursor = page.rev;
  } catch (error) {
    if (!signal.aborted) report(explainRpcError(error, "agents/messages").message);
    return;
  }
  await follow(
    "agents/subscribe",
    (stream) => client.agents.subscribe({ id, cursor }, { signal: stream }),
    (frame) => {
      if (!frame.event) return;
      cursor = Math.max(cursor, frame.event.rev);
      add([{ key: `e${frame.event.seq}`, tone: "event", text: formatAgentEvent(frame.event) }]);
    },
    signal,
    report,
  );
}

/** A bot's or a room's thread: history, then live. Pending questions are reported through `setAsk`. */
async function followThread(
  client: TuiClient,
  target: Target,
  add: Add,
  setAsk: (ask: Ask | undefined) => void,
  signal: AbortSignal,
  report: Report,
): Promise<void> {
  let cursor: number;
  let open: Ask | undefined;
  const track = (ask: Ask | undefined) => {
    open = ask;
    setAsk(ask);
  };
  try {
    const snapshot = await client.threads.get(target);
    track([...snapshot.messages].reverse().map(askIn).find(Boolean));
    add(
      snapshot.messages.map((message) => ({
        key: message.id,
        tone: message.role === "user" ? "you" : "them",
        text: sanitize(messageText({ blocks: message.blocks })),
      })),
    );
    cursor = snapshot.cursor;
  } catch (error) {
    if (!signal.aborted) report(explainRpcError(error, "threads/get").message);
    return;
  }
  await follow(
    "threads/subscribe",
    (stream) => client.threads.subscribe({ ...target, cursor }, { signal: stream }),
    (event) => {
      // Keep-alive frames are `{type:"heartbeat"}` with no payload.
      if (!event.id) return;
      cursor = Math.max(cursor, event.seq);
      if (event.type === "thread.message.created" || event.type === "thread.message.updated") {
        const ask = askIn(event.payload);
        if (ask) track(ask);
        else if (open && (event.payload.id ?? event.payload.messageId) === open.messageId) {
          track(undefined);
        }
      }
      if (event.type === "thread.message.created") {
        const text = messageText(event.payload);
        if (text) {
          const tone = event.payload.role === "user" ? "you" : "them";
          add([{ key: event.id, tone, text: sanitize(text) }]);
        }
        return;
      }
      const end = chatLineFor(event);
      if (end.kind === "end") track(undefined);
      if (end.kind === "end" && end.text) {
        add([{ key: event.id, tone: "event", text: end.text }]);
      }
    },
    signal,
    report,
  );
}

/** Messages a bot, a room or an agent (its bot id); the reply arrives on the thread stream. */
export async function sendMessage(
  client: TuiClient,
  item: SidebarItem,
  text: string,
): Promise<void> {
  await client.threads.send({ ...targetOf(item), text, clientNonce: randomUUID() });
}

/** Answers the open question in a room or bot thread. */
export async function answerAsk(
  client: TuiClient,
  item: SidebarItem,
  ask: Ask,
  answer: string,
): Promise<void> {
  await client.threads.answer({
    ...targetOf(item),
    runId: ask.runId,
    messageId: ask.messageId,
    answer,
  });
}

/**
 * Fallback when the bridge cannot message an agent: the text is typed into the agent's terminal,
 * then Enter. Callers confirm with the person first.
 */
export async function typeIntoAgent(
  client: TuiClient,
  id: string,
  text: string,
  size: { rows: number; cols: number },
): Promise<void> {
  const { terminalId } = await client.terminal.open({ id, ...size });
  try {
    const sequencer = createInputSequencer();
    for (const call of sequencer.next(new TextEncoder().encode(`${text}\r`))) {
      await client.terminal.input({ terminalId, ...call });
    }
  } finally {
    await client.terminal.close({ terminalId }).catch(() => undefined);
  }
}
