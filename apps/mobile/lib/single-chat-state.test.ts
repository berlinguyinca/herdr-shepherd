import type { Bot } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { resolveSingleChat, type SingleChatInputs } from "./single-chat-state";

const bot = (id: string, over: Partial<Bot> = {}): Bot =>
  ({ id, isDefault: false, archivedAt: null, ...over }) as Bot;
const retry = () => undefined;
const inputs = (over: Partial<SingleChatInputs>): SingleChatInputs => ({
  hasSession: false,
  open: { kind: "idle" },
  bots: { kind: "pending" },
  retry,
  ...over,
});

describe("resolveSingleChat", () => {
  it("is connecting before the session check or while the open or list is in flight", () => {
    expect(resolveSingleChat(inputs({ hasSession: null })).kind).toBe("connecting");
    expect(resolveSingleChat(inputs({ open: { kind: "pending" } })).kind).toBe("connecting");
    expect(resolveSingleChat(inputs({ open: { kind: "ok" } })).kind).toBe("connecting");
    expect(resolveSingleChat(inputs({ hasSession: true })).kind).toBe("connecting");
  });
  it("is ready with the default bot after a silent open", () => {
    const state = resolveSingleChat(
      inputs({
        open: { kind: "ok" },
        bots: {
          kind: "loaded",
          bots: [bot("a"), bot("b", { isDefault: true })],
        },
      }),
    );
    expect(state).toEqual({
      kind: "ready",
      bot: bot("b", { isDefault: true }),
    });
  });
  it("is offline, with retry, when the open fails on the network", () => {
    const state = resolveSingleChat(inputs({ open: { kind: "failed", reason: "network" } }));
    expect(state).toEqual({ kind: "offline", retry });
  });
  it("is offline, never a sign-in, when the server refuses the open", () => {
    const state = resolveSingleChat(inputs({ open: { kind: "failed", reason: "refused" } }));
    expect(state.kind).toBe("offline");
  });
  it("is offline when the bot list fails", () => {
    expect(resolveSingleChat(inputs({ hasSession: true, bots: { kind: "failed" } })).kind).toBe(
      "offline",
    );
  });
  it("is empty with a session and no bots", () => {
    expect(
      resolveSingleChat(inputs({ hasSession: true, bots: { kind: "loaded", bots: [] } })),
    ).toEqual({ kind: "empty" });
  });
  it("is empty when the only bots are archived", () => {
    const bots = [bot("a", { isDefault: true, archivedAt: "2026-01-01" })];
    expect(
      resolveSingleChat(inputs({ hasSession: true, bots: { kind: "loaded", bots } })).kind,
    ).toBe("empty");
  });
});
