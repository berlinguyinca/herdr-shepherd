import { describe, expect, it } from "vitest";
import { createAssistantInput, setDefaultInput } from "./assistant-actions";

describe("createAssistantInput", () => {
  it("builds bots/create input with name and instructions", () => {
    expect(createAssistantInput("Ops", "runs deploys")).toEqual({
      name: "Ops",
      instructions: "runs deploys",
      notifyOnFinish: true,
      computerMode: "team",
    });
  });

  it("trims name and role", () => {
    expect(createAssistantInput("  Ops  ", "  runs deploys ")).toMatchObject({
      name: "Ops",
      instructions: "runs deploys",
    });
  });

  it("defaults instructions to empty", () => {
    expect(createAssistantInput("Ops").instructions).toBe("");
  });

  it("rejects empty and whitespace names", () => {
    expect(() => createAssistantInput("")).toThrow();
    expect(() => createAssistantInput("   ")).toThrow();
  });
});

describe("setDefaultInput", () => {
  it("builds bots/update input", () => {
    expect(setDefaultInput("bot-1")).toEqual({ botId: "bot-1", isDefault: true });
  });

  it("rejects an empty bot id", () => {
    expect(() => setDefaultInput("")).toThrow();
  });
});
