import { expect, it } from "vitest";
import { applyAgentRow } from "./agent-order";
import type { AgentRow } from "./agents";

const row = (id: string, status: string, updated_at: string): AgentRow =>
  ({
    id,
    name: id,
    machine: null,
    status,
    summary: "",
    updated_at,
    has_conversation: true,
  }) as AgentRow;

const now = Date.now();
const iso = (ageSeconds: number) => new Date(now - ageSeconds * 1000).toISOString();

it("drops a closed row and a stale-idle row unless Show older is on", () => {
  const rows = [row("a", "working", iso(10)), row("b", "idle", iso(10))];
  expect(applyAgentRow(rows, row("b", "idle", iso(8 * 86400)), false).map((r) => r.id)).toEqual([
    "a",
  ]);
  expect(applyAgentRow(rows, row("b", "idle", iso(8 * 86400)), true).map((r) => r.id)).toEqual([
    "a",
    "b",
  ]);
  expect(applyAgentRow(rows, row("b", "idle", iso(6 * 86400)), false).map((r) => r.id)).toEqual([
    "a",
    "b",
  ]);
  expect(applyAgentRow(rows, row("a", "working", iso(9 * 86400)), false).map((r) => r.id)).toEqual([
    "a",
    "b",
  ]);
});
