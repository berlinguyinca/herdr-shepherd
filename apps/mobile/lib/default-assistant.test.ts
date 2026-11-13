import type { Bot } from "@rakazo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { pickDefaultBot } from "./default-assistant";
import { singleChatOnly } from "./server-config";

const bot = (id: string, over: Partial<Bot> = {}): Bot =>
  ({ id, isDefault: false, archivedAt: null, ...over }) as Bot;

describe("pickDefaultBot", () => {
  it("returns the default bot", () => {
    expect(pickDefaultBot([bot("a"), bot("b", { isDefault: true })])?.id).toBe("b");
  });
  it("returns the first of two flagged bots", () => {
    expect(
      pickDefaultBot([bot("a"), bot("b", { isDefault: true }), bot("c", { isDefault: true })])?.id,
    ).toBe("b");
  });
  it("falls back to the first live bot when the default is archived", () => {
    const bots = [
      bot("a", { archivedAt: "2026-01-01" }),
      bot("b", { isDefault: true, archivedAt: "2026-01-01" }),
      bot("c"),
    ];
    expect(pickDefaultBot(bots)?.id).toBe("c");
  });
  it("returns null when empty", () => {
    expect(pickDefaultBot([])).toBeNull();
  });
});

describe("singleChatOnly", () => {
  const saved = process.env.EXPO_PUBLIC_SINGLE_CHAT;
  afterEach(() => {
    if (saved === undefined) delete process.env.EXPO_PUBLIC_SINGLE_CHAT;
    else process.env.EXPO_PUBLIC_SINGLE_CHAT = saved;
  });
  it("is false when unset and true when 'true'", () => {
    delete process.env.EXPO_PUBLIC_SINGLE_CHAT;
    expect(singleChatOnly()).toBe(false);
    process.env.EXPO_PUBLIC_SINGLE_CHAT = "true";
    expect(singleChatOnly()).toBe(true);
  });
});
