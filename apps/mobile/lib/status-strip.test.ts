import type { AgentRow, RunActivityRow } from "@rakazo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { resetI18nForTests } from "./i18n";
import { statusChip, statusStripRows, summarizeStatus } from "./status-strip";

afterEach(() => resetI18nForTests());

// Same name AgentsUnsupportedError carries; importing ./agents would pull in react-native.
const unsupported = Object.assign(new Error("This server does not support agents"), {
  name: "AgentsUnsupportedError",
});

const NOW = new Date("2026-01-01T01:00:00.000Z");
const agent = (id: string, status: AgentRow["status"], summary = ""): AgentRow => ({
  id,
  name: `Agent ${id}`,
  machine: null,
  status,
  summary,
  updated_at: "2026-01-01T00:00:00.000Z",
  has_conversation: true,
});

describe("agents with an unusable updated_at", () => {
  it("count as active when working or blocked", () => {
    const missing = { ...agent("a", "working"), updated_at: "" };
    const garbage = { ...agent("b", "blocked"), updated_at: "not a date" };
    expect(summarizeStatus([missing, garbage], [], NOW).map((r) => r.state)).toEqual([
      "blocked",
      "working",
    ]);
    expect(statusChip([missing], NOW).tone).toBe("working");
  });
});

describe("summarizeStatus", () => {
  it("excludes idle, closed, unknown and done agents", () => {
    const rows = summarizeStatus(
      [agent("a", "idle"), agent("b", "closed"), agent("c", "unknown"), agent("d", "done")],
      [],
      NOW,
    );
    expect(rows).toEqual([]);
  });

  it("sorts blocked before working", () => {
    const rows = summarizeStatus([agent("a", "working", "x"), agent("b", "blocked", "y")], [], NOW);
    expect(rows.map((r) => [r.name, r.state])).toEqual([
      ["Agent b", "blocked"],
      ["Agent a", "working"],
    ]);
  });

  it("truncates the one-line summary to 60 chars", () => {
    const [row] = summarizeStatus(
      [agent("a", "working", `${"x".repeat(80)}\nsecond line`)],
      [],
      NOW,
    );
    expect(row?.line).toHaveLength(60);
    expect(row?.line.endsWith("…")).toBe(true);
    expect(row?.line).not.toContain("\n");
  });

  it("shows 3 rows plus a +2 more marker for 5 working", () => {
    const rows = summarizeStatus(
      ["1", "2", "3", "4", "5"].map((id) => agent(id, "working", "s")),
      [],
      NOW,
    );
    expect(rows).toHaveLength(4);
    expect(rows[3]).toEqual({ name: "", state: "idle", line: "+2 more" });
  });

  it("falls back to the active run prompt when the summary is empty", () => {
    const run = {
      botName: "Agent a",
      status: "running",
      promptSnippet: "Fix the build",
    } as RunActivityRow;
    const [row] = summarizeStatus([agent("a", "working", "")], [run], NOW);
    expect(row?.line).toBe("Fix the build");
  });
});

describe("statusStripRows", () => {
  it("hides the strip when the server has no agents support", () => {
    expect(statusStripRows(undefined, [], unsupported)).toEqual([]);
  });
  it("hides the strip when there is no data", () => {
    expect(statusStripRows(undefined, [], new Error("x"))).toEqual([]);
    expect(statusStripRows(undefined, [], null)).toEqual([]);
  });
  it("keeps stale rows when a refetch errors but data exists", () => {
    expect(statusStripRows([agent("a", "working", "s")], [], new Error("x"), NOW)).toHaveLength(1);
  });
  it("summarizes data when present", () => {
    expect(statusStripRows([agent("a", "working", "s")], [], null, NOW)).toHaveLength(1);
  });
});

describe("statusChip", () => {
  it("is idle with no active agents", () => {
    expect(statusChip([agent("a", "idle")], NOW)).toEqual({ tone: "idle", label: "All idle" });
    expect(statusChip(undefined)).toEqual({ tone: "idle", label: "All idle" });
  });
  it("counts working agents", () => {
    expect(statusChip([agent("a", "working"), agent("b", "working")], NOW)).toEqual({
      tone: "working",
      label: "2 working",
    });
  });
  it("blocked wins and counts only blocked", () => {
    expect(statusChip([agent("a", "working"), agent("b", "blocked")], NOW)).toEqual({
      tone: "blocked",
      label: "1 blocked",
    });
  });
});

describe("stale agents", () => {
  const old = (id: string, status: AgentRow["status"]): AgentRow => ({
    ...agent(id, status, "s"),
    updated_at: "2025-12-31T00:00:00.000Z",
  });
  const agents = [old("o1", "working"), old("o2", "blocked"), agent("n", "working", "s")];
  it("ignores working/blocked agents older than 6 hours", () => {
    expect(summarizeStatus(agents, [], NOW).map((r) => r.name)).toEqual(["Agent n"]);
  });
  it("chip and rows agree", () => {
    expect(statusChip(agents, NOW)).toEqual({ tone: "working", label: "1 working" });
    expect(statusStripRows(agents, [], null, NOW)).toHaveLength(1);
    expect(statusChip([old("o", "blocked")], NOW).tone).toBe("idle");
  });
});
