import type { AgentRow, RunActivityRow } from "@rakazo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { resetI18nForTests } from "./i18n";
import { statusChip, statusStripRows, summarizeStatus } from "./status-strip";

afterEach(() => resetI18nForTests());

// Same name AgentsUnsupportedError carries; importing ./agents would pull in react-native.
const unsupported = Object.assign(new Error("This server does not support agents"), {
  name: "AgentsUnsupportedError",
});

const agent = (id: string, status: AgentRow["status"], summary = ""): AgentRow => ({
  id,
  name: `Agent ${id}`,
  machine: null,
  status,
  summary,
  updated_at: "2026-01-01T00:00:00.000Z",
  has_conversation: true,
});

describe("summarizeStatus", () => {
  it("excludes idle, closed, unknown and done agents", () => {
    const rows = summarizeStatus(
      [agent("a", "idle"), agent("b", "closed"), agent("c", "unknown"), agent("d", "done")],
      [],
    );
    expect(rows).toEqual([]);
  });

  it("sorts blocked before working", () => {
    const rows = summarizeStatus([agent("a", "working", "x"), agent("b", "blocked", "y")], []);
    expect(rows.map((r) => [r.name, r.state])).toEqual([
      ["Agent b", "blocked"],
      ["Agent a", "working"],
    ]);
  });

  it("truncates the one-line summary to 60 chars", () => {
    const [row] = summarizeStatus([agent("a", "working", `${"x".repeat(80)}\nsecond line`)], []);
    expect(row?.line).toHaveLength(60);
    expect(row?.line.endsWith("…")).toBe(true);
    expect(row?.line).not.toContain("\n");
  });

  it("shows 3 rows plus a +2 more marker for 5 working", () => {
    const rows = summarizeStatus(
      ["1", "2", "3", "4", "5"].map((id) => agent(id, "working", "s")),
      [],
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
    const [row] = summarizeStatus([agent("a", "working", "")], [run]);
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
    expect(statusStripRows([agent("a", "working", "s")], [], new Error("x"))).toHaveLength(1);
  });
  it("summarizes data when present", () => {
    expect(statusStripRows([agent("a", "working", "s")], [], null)).toHaveLength(1);
  });
});

describe("statusChip", () => {
  it("is idle with no active agents", () => {
    expect(statusChip([agent("a", "idle")])).toEqual({ tone: "idle", label: "All idle" });
    expect(statusChip(undefined)).toEqual({ tone: "idle", label: "All idle" });
  });
  it("counts working agents", () => {
    expect(statusChip([agent("a", "working"), agent("b", "working")])).toEqual({
      tone: "working",
      label: "2 working",
    });
  });
  it("blocked wins and counts only blocked", () => {
    expect(statusChip([agent("a", "working"), agent("b", "blocked")])).toEqual({
      tone: "blocked",
      label: "1 blocked",
    });
  });
});
