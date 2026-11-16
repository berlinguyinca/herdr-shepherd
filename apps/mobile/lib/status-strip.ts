import type { AgentRow, RunActivityRow } from "@rakazo/contracts";
import { t } from "./i18n";

export type StatusRow = {
  name: string;
  state: "working" | "blocked" | "done" | "idle";
  line: string;
};

export const STATUS_STRIP_MAX_ROWS = 3;
const LINE_MAX = 60;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > LINE_MAX ? `${flat.slice(0, LINE_MAX - 1)}…` : flat;
}

/**
 * Active assistants only (working, blocked), blocked first, at most 3 rows. When more are
 * active, a trailing overflow marker row is appended: `{name: "", state: "idle", line: "+N more"}`
 * (name empty, so callers render it as plain text). An empty result means the strip is hidden.
 * Rows come from agents; an empty summary falls back to the prompt of that assistant's active
 * run (matched by botName). Pure: takes already-fetched data.
 */
export function summarizeStatus(
  agents: readonly AgentRow[],
  runs: readonly RunActivityRow[],
): StatusRow[] {
  const active = agents
    .filter((a) => a.status === "working" || a.status === "blocked")
    .map((a) => ({ agent: a, blocked: a.status === "blocked" }));
  const ordered = [...active.filter((a) => a.blocked), ...active.filter((a) => !a.blocked)];
  const rows = ordered.slice(0, STATUS_STRIP_MAX_ROWS).map(({ agent, blocked }): StatusRow => {
    const run = runs.find((r) => r.botName === agent.name);
    return {
      name: agent.name,
      state: blocked ? "blocked" : "working",
      line: oneLine(agent.summary || run?.promptSnippet || ""),
    };
  });
  const extra = ordered.length - rows.length;
  if (extra > 0) rows.push({ name: "", state: "idle", line: t("+{count} more", { count: extra }) });
  return rows;
}

/** Rows for the strip; stale data stays visible after a failed refetch, no data (including an unsupported server) hides it. */
export function statusStripRows(
  agents: readonly AgentRow[] | undefined,
  runs: readonly RunActivityRow[],
  _error?: unknown,
): StatusRow[] {
  if (!agents) return [];
  return summarizeStatus(agents, runs);
}

export type StatusChip = { tone: "idle" | "working" | "blocked"; label: string };

/** One-line summary for the header chip: blocked agents first, then working, else idle. */
export function statusChip(agents: readonly AgentRow[] | undefined): StatusChip {
  const list = agents ?? [];
  const blocked = list.filter((a) => a.status === "blocked").length;
  if (blocked > 0) return { tone: "blocked", label: t("{count} blocked", { count: blocked }) };
  const working = list.filter((a) => a.status === "working").length;
  if (working > 0) return { tone: "working", label: t("{count} working", { count: working }) };
  return { tone: "idle", label: t("All idle") };
}
