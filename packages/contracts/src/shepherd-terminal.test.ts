import { describe, expect, it } from "vitest";
import { TerminalFrameSchema, TerminalResizeInputSchema } from "./shepherd-terminal.js";

describe("terminal resize", () => {
  const base = { terminalId: "t1", rows: 24, cols: 80 };

  it("takes an optional zoom flag", () => {
    expect(TerminalResizeInputSchema.parse({ ...base, zoom: true }).zoom).toBe(true);
    expect(TerminalResizeInputSchema.parse({ ...base, zoom: false }).zoom).toBe(false);
    expect(TerminalResizeInputSchema.parse(base).zoom).toBeUndefined();
    expect(TerminalResizeInputSchema.safeParse({ ...base, zoom: "yes" }).success).toBe(false);
  });
});

describe("terminal frame", () => {
  it("carries the pane's size and an end reason", () => {
    const frame = TerminalFrameSchema.parse({
      seq: 3,
      data: "eA==",
      reset: true,
      rows: 120,
      cols: 97,
    });
    expect(frame).toMatchObject({ rows: 120, cols: 97 });
    expect(
      TerminalFrameSchema.parse({ seq: 4, ended: true, exit: null, reason: "stale" }).reason,
    ).toBe("stale");
  });

  it("refuses a size outside the bridge's limits", () => {
    expect(TerminalFrameSchema.safeParse({ seq: 1, rows: 501, cols: 80 }).success).toBe(false);
    expect(TerminalFrameSchema.safeParse({ seq: 1, rows: 24, cols: 1001 }).success).toBe(false);
  });
});
