import type { AgentEvent, AgentRow, ProductEvent } from "@rakazo/contracts";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ESCAPE_SEQUENCES = [
  new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?`, "g"),
  new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g"),
  new RegExp(`${ESC}.`, "g"),
];
const CONTROL_CHARACTERS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}-${String.fromCharCode(31)}${String.fromCharCode(127)}-${String.fromCharCode(159)}]`,
  "g",
);

/** Strips terminal control sequences from text a remote machine wrote; keeps newline and tab. */
export function sanitize(text: string): string {
  return ESCAPE_SEQUENCES.reduce((out, pattern) => out.replace(pattern, ""), text).replace(
    CONTROL_CHARACTERS,
    "",
  );
}

const STATUS_ORDER: Record<AgentRow["status"], number> = {
  blocked: 0,
  done: 1,
  working: 2,
  idle: 3,
  unknown: 4,
  closed: 5,
};

export function sortAgents(rows: Iterable<AgentRow>): AgentRow[] {
  return [...rows].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      b.updated_at.localeCompare(a.updated_at) ||
      a.id.localeCompare(b.id),
  );
}

const oneLine = (text: string, max: number): string => {
  const flat = sanitize(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export function formatAgentRow(row: AgentRow): string {
  const machine = row.machine ? ` @${sanitize(row.machine)}` : "";
  const summary = row.summary ? `  ${oneLine(row.summary, 80)}` : "";
  return `${row.status.padEnd(8)} ${sanitize(row.id)}  ${oneLine(row.name, 40)}${machine}${summary}`;
}

/** The list as one screen: header plus a row per agent, most urgent first. */
export function formatAgentTable(rows: Iterable<AgentRow>): string {
  const sorted = sortAgents(rows);
  if (sorted.length === 0) return "No agents.";
  return sorted.map(formatAgentRow).join("\n");
}

/** `agents/subscribeList` frame onto the row map; a closed agent leaves the list. */
export function applyListFrame(rows: Map<string, AgentRow>, row: AgentRow): void {
  if (row.status === "closed") rows.delete(row.id);
  else rows.set(row.id, row);
}

const DATA_KEYS = ["text", "command", "message", "summary", "name", "path", "output"] as const;

export function formatAgentEvent(event: AgentEvent): string {
  if (event.data.withheld === true) {
    const reason = typeof event.data.withheld_reason === "string" ? event.data.withheld_reason : "";
    return `${event.ts}  ${event.kind}  [withheld${reason ? `: ${sanitize(reason)}` : ""}]`;
  }
  const found = DATA_KEYS.map((key) => event.data[key]).find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const more = DATA_KEYS.some((key) => event.data[`${key}_more`] === true) ? " …" : "";
  return `${event.ts}  ${sanitize(event.kind)}  ${found ? oneLine(found, 200) : ""}${more}`.trimEnd();
}

/** Text blocks of a message payload, joined; empty when the payload carries none. */
export function messageText(payload: Record<string, unknown>): string {
  const blocks = Array.isArray(payload.blocks) ? payload.blocks : [];
  return blocks
    .map((block) =>
      block && typeof block === "object" && "text" in block && typeof block.text === "string"
        ? block.text
        : "",
    )
    .filter(Boolean)
    .join("\n")
    .trim();
}

export type ChatLine =
  | { kind: "bot"; text: string }
  | { kind: "end"; text: string }
  | { kind: "ignore" };

/** One thread event as the chat shows it: bot replies as text, run ends as a status line. */
export function chatLineFor(event: ProductEvent): ChatLine {
  if (event.type === "thread.message.created" && event.payload.role === "bot") {
    const text = messageText(event.payload);
    return text ? { kind: "bot", text: sanitize(text) } : { kind: "ignore" };
  }
  if (event.type === "run.completed") return { kind: "end", text: "" };
  if (event.type === "run.failed") return { kind: "end", text: "[run failed]" };
  if (event.type === "run.cancelled") return { kind: "end", text: "[run stopped]" };
  return { kind: "ignore" };
}
