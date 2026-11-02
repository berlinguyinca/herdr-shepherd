import { describe, expect, it } from "vitest";
import { AGENT_STATUSES, AgentEventSchema, AgentRowSchema } from "./agents.js";

const row = {
  id: "a1",
  name: "worker",
  machine: null,
  status: "working",
  summary: "doing it",
  updated_at: "2026-11-01T00:00:00Z",
  has_conversation: true,
};

describe("AgentRowSchema", () => {
  it("accepts the six statuses and rejects others", () => {
    expect([...AGENT_STATUSES]).toEqual([
      "blocked",
      "done",
      "working",
      "idle",
      "unknown",
      "closed",
    ]);
    for (const status of AGENT_STATUSES)
      expect(AgentRowSchema.safeParse({ ...row, status }).success).toBe(true);
    expect(AgentRowSchema.safeParse({ ...row, status: "paused" }).success).toBe(false);
  });

  it("allows a null or string machine", () => {
    expect(AgentRowSchema.safeParse({ ...row, machine: "mac" }).success).toBe(true);
    expect(AgentRowSchema.safeParse({ ...row, machine: 3 }).success).toBe(false);
  });
});

describe("AgentEventSchema", () => {
  it("keeps the rendered event fields and the withheld/_more markers in data", () => {
    const event = {
      seq: 3,
      rev: 9,
      kind: "message",
      agent_id: "a1",
      parent_agent_id: null,
      ts: "2026-11-01T00:00:00Z",
      sensitive: false,
      redacted: false,
      truncated: true,
      size: 5000,
      data: { text: "x", text_more: true, withheld: true, withheld_reason: "sensitive" },
    };
    expect(AgentEventSchema.parse(event)).toEqual(event);
  });
});
