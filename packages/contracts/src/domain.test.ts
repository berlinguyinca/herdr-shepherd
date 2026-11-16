import { describe, expect, it } from "vitest";
import { BotSchema, SpaceBotSchema, UpdateBotInput } from "./domain.js";

const botWithoutIsDefault = {
  id: "bot-1",
  spaceId: "space-1",
  name: "Fixture",
  title: "",
  description: "",
  instructions: "",
  color: "#000000",
  notifyOnFinish: false,
  pinned: false,
  sectionId: null,
  archivedAt: null,
  unread: false,
  parentBotId: null,
  memoryScope: null,
  threadId: "thread-1",
  preview: "",
  status: "idle",
  computerMode: "team",
  updatedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  voiceId: null,
  autoSpeak: false,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  teamChatAmbientEnabled: false,
  teamChatRules: "",
  webhookConfigured: false,
  spawnKey: null,
};

describe("isDefault on bots", () => {
  it("defaults to false when a bot omits it", () => {
    expect(BotSchema.parse(botWithoutIsDefault).isDefault).toBe(false);
  });
  it("keeps a true value", () => {
    expect(BotSchema.parse({ ...botWithoutIsDefault, isDefault: true }).isDefault).toBe(true);
  });
  it("is kept by the space bot projection", () => {
    expect(SpaceBotSchema.parse({ ...botWithoutIsDefault, isDefault: true }).isDefault).toBe(true);
  });
  it("is kept by UpdateBotInput", () => {
    expect(UpdateBotInput.parse({ botId: "bot-1", isDefault: true }).isDefault).toBe(true);
  });
});
