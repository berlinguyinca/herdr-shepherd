import type { Bot, RunActivityRow } from "@rakazo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { assistantCandidates, isAssistantBot, pickDefaultBot } from "./default-assistant";
import { singleChatOnly } from "./server-config";

const bot = (id: string, over: Partial<Bot> = {}): Bot =>
  ({ id, isDefault: false, archivedAt: null, ...over }) as Bot;

const run = (botId: string, updatedAt: string, botName = botId): RunActivityRow =>
  ({ botId, botName, threadId: `thr_${botId}`, updatedAt }) as RunActivityRow;

describe("pickDefaultBot", () => {
  it("returns the default bot", () => {
    expect(pickDefaultBot([bot("a"), bot("b", { isDefault: true })])?.id).toBe("b");
  });
  it("returns the first of two flagged bots", () => {
    expect(
      pickDefaultBot([bot("a"), bot("b", { isDefault: true }), bot("c", { isDefault: true })])?.id,
    ).toBe("b");
  });
  it("ignores an archived default and falls back to the first live assistant", () => {
    const bots = [
      bot("a", { archivedAt: "2026-01-01" }),
      bot("b", { isDefault: true, archivedAt: "2026-01-01" }),
      bot("c"),
    ];
    expect(pickDefaultBot(bots)?.id).toBe("c");
  });
  it("falls back to the first assistant when no signal exists, never a spawned bot", () => {
    const bots = [bot("s", { spawnKey: "agent_1" }), bot("a"), bot("b")];
    expect(pickDefaultBot(bots)?.id).toBe("a");
  });
  it("ranks despite an unparsable updatedAt", () => {
    const bots = [
      bot("a", { updatedAt: "garbage" }),
      bot("b", { updatedAt: "2026-01-01T00:00:00Z" }),
    ];
    expect(pickDefaultBot(bots)?.id).toBe("b");
    expect(pickDefaultBot([bot("a", { updatedAt: "garbage" })], [run("a", "nope")])?.id).toBe("a");
  });
  it("does not resurrect an archived or spawned bot from a run", () => {
    const bots = [bot("x", { archivedAt: "2026-01-01" }), bot("s", { spawnKey: "k" })];
    expect(
      pickDefaultBot(bots, [run("x", "2026-02-01T00:00:00Z"), run("s", "2026-02-01T00:00:00Z")]),
    ).toBeNull();
  });
  it("ignores spawned and child bots, even when flagged", () => {
    const bots = [
      bot("s", { spawnKey: "agent_1", isDefault: true }),
      bot("p", { parentBotId: "x" }),
    ];
    expect(isAssistantBot(bots[0] as Bot)).toBe(false);
    expect(pickDefaultBot(bots)).toBeNull();
  });
  it("prefers the assistant with the most recent run", () => {
    const bots = [bot("a"), bot("b")];
    const runs = [run("a", "2026-01-01T00:00:00Z"), run("b", "2026-02-01T00:00:00Z")];
    expect(pickDefaultBot(bots, runs)?.id).toBe("b");
  });
  it("explicit default beats recent activity", () => {
    const runs = [run("a", "2026-02-01T00:00:00Z")];
    expect(pickDefaultBot([bot("a"), bot("d", { isDefault: true })], runs)?.id).toBe("d");
  });
  it("picks a bot known only from runs, with a minimal bot", () => {
    const picked = pickDefaultBot(
      [bot("s", { spawnKey: "agent_1" })],
      [run("h", "2026-02-01T00:00:00Z", "Herdr")],
    );
    expect(picked).toMatchObject({ id: "h", name: "Herdr", threadId: "thr_h" });
  });
  it("de-duplicates run bots against the list and each other", () => {
    const runs = [
      run("a", "2026-01-01T00:00:00Z"),
      run("h", "2026-01-01T00:00:00Z"),
      run("h", "2026-01-02T00:00:00Z"),
    ];
    expect(assistantCandidates([bot("a")], runs).map((b) => b.id)).toEqual(["a", "h"]);
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
