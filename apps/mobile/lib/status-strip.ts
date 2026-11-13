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

/** Rows for the strip from a query result; any error (including unsupported servers) hides it. */
export function statusStripRows(
  agents: readonly AgentRow[] | undefined,
  runs: readonly RunActivityRow[],
  error: unknown,
): StatusRow[] {
  if (error || !agents) return [];
  return summarizeStatus(agents, runs);
}
