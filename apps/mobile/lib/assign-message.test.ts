import { describe, expect, it } from "vitest";
import { assignSendInput, buildAssignMessage } from "./assign-message";

describe("buildAssignMessage", () => {
  it("names the agent or role and the task", () => {
    expect(buildAssignMessage({ target: "Reviewer", task: "check PR 33" })).toBe(
      "Assign Reviewer: check PR 33",
    );
  });
  it("trims both fields", () => {
    expect(buildAssignMessage({ target: "  Coder ", task: "\n fix the build  " })).toBe(
      "Assign Coder: fix the build",
    );
  });
  it("leaves the target out when blank", () => {
    expect(buildAssignMessage({ target: " ", task: "tidy up" })).toBe("Assign: tidy up");
  });
  it("rejects a blank task", () => {
    expect(buildAssignMessage({ target: "Coder", task: "  " })).toBeNull();
  });
});

describe("assignSendInput", () => {
  it("builds the threads/send input for the assistant", () => {
    expect(assignSendInput("bot-1", { target: "Coder", task: "x" }, "n-1")).toEqual({
      botId: "bot-1",
      clientNonce: "n-1",
      text: "Assign Coder: x",
    });
  });
  it("is null without a task", () => {
    expect(assignSendInput("bot-1", { target: "Coder", task: "" }, "n-1")).toBeNull();
  });
});
