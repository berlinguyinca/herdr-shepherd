import type { Bot, RunActivityRow } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { resolveSingleChat, type SingleChatInputs, shouldOpenSession } from "./single-chat-state";

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
  it("asks for Tailscale, with retry, when the server is off the tailnet", () => {
    const state = resolveSingleChat(inputs({ open: { kind: "failed", reason: "tailscale" } }));
    expect(state).toEqual({ kind: "connect-tailscale", retry });
  });
  it("asks for an app update when the server is newer than the app", () => {
    const state = resolveSingleChat(inputs({ open: { kind: "failed", reason: "update" } }));
    expect(state).toEqual({ kind: "update-app" });
  });
  it("is offline, never a sign-in, when the server refuses the open", () => {
    const state = resolveSingleChat(inputs({ open: { kind: "failed", reason: "refused" } }));
    expect(state.kind).toBe("offline");
  });
  it("is offline when the bot list fails", () => {
    expect(
      resolveSingleChat(inputs({ hasSession: true, bots: { kind: "failed", reason: "other" } }))
        .kind,
    ).toBe("offline");
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

describe("resolveSingleChat with run-only assistants", () => {
  it("opens the assistant known only from recent runs", () => {
    const runs = [
      { botId: "h", botName: "Herdr", threadId: "thr_h", updatedAt: "2026-11-16T00:00:00Z" },
    ] as RunActivityRow[];
    const bots = [bot("agent1", { spawnKey: "agent_01" })];
    const state = resolveSingleChat(
      inputs({ hasSession: true, bots: { kind: "loaded", bots, runs } }),
    );
    expect(state).toMatchObject({ kind: "ready", bot: { id: "h", name: "Herdr" } });
  });
  it("is empty when only spawned bots exist", () => {
    const bots = [bot("agent1", { spawnKey: "agent_01" })];
    expect(
      resolveSingleChat(inputs({ hasSession: true, bots: { kind: "loaded", bots } })).kind,
    ).toBe("empty");
  });
});

describe("shouldOpenSession", () => {
  it("opens when there is no saved session", () => {
    expect(
      shouldOpenSession({ hasSession: false, openedThisAttempt: false, lastFailure: null }),
    ).toBe(true);
  });
  it("keeps a saved session that worked", () => {
    expect(
      shouldOpenSession({ hasSession: true, openedThisAttempt: false, lastFailure: null }),
    ).toBe(false);
    expect(
      shouldOpenSession({ hasSession: true, openedThisAttempt: false, lastFailure: "other" }),
    ).toBe(false);
  });
  it("reopens a saved session the list refused, but only once per attempt", () => {
    expect(
      shouldOpenSession({ hasSession: true, openedThisAttempt: false, lastFailure: "auth" }),
    ).toBe(true);
    expect(
      shouldOpenSession({ hasSession: true, openedThisAttempt: true, lastFailure: "auth" }),
    ).toBe(false);
  });
});
