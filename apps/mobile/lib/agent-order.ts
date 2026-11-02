import type { AgentRow } from "./agents";

const RANK: Record<string, number> = {
  blocked: 0,
  done: 1,
  working: 2,
  idle: 3,
  unknown: 4,
  closed: 5,
};
const UNRANKED = 4;

/** A status this app does not know is shown, and ordered, as unknown. */
export function agentStatus(status: string | undefined): AgentRow["status"] {
  return status !== undefined && status in RANK ? (status as AgentRow["status"]) : "unknown";
}

function time(row: AgentRow): number {
  const parsed = Date.parse(row.updated_at);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** The server's order: blocked, done, working, idle, unknown, closed; newest first in a group. */
export function compareAgents(a: AgentRow, b: AgentRow): number {
  const rank = (RANK[a.status] ?? UNRANKED) - (RANK[b.status] ?? UNRANKED);
  return rank !== 0 ? rank : time(b) - time(a);
}

/** The server hides an idle agent that has been quiet this long (its `visible()`). */
const STALE_IDLE_SECONDS = 7 * 86_400;

/** A row the default list no longer shows: closed, or idle and quiet for over seven days. */
export function leftDefaultList(row: AgentRow, now = Date.now()): boolean {
  if (row.status === "closed") return true;
  const updated = Date.parse(row.updated_at);
  return (
    row.status === "idle" && !Number.isNaN(updated) && now - updated > STALE_IDLE_SECONDS * 1000
  );
}

/**
 * Puts a live row in the list: it replaces the row with the same id and the list is re-sorted. A
 * closed or stale-idle row is dropped unless `keepClosed` (the "Show older" list still shows them).
 */
export function applyAgentRow(rows: AgentRow[], row: AgentRow, keepClosed: boolean): AgentRow[] {
  const rest = rows.filter((existing) => existing.id !== row.id);
  if (leftDefaultList(row) && !keepClosed) return rest;
  return [...rest, row].sort(compareAgents);
}
