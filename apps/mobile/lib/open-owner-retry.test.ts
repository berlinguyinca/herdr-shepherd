process.env.EXPO_PUBLIC_PERSONAL_SERVER_ONLY = "false";

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Native secure storage has no host implementation; an in-memory store stands in for the device keychain only.
const store = new Map<string, string>();
let failKeychainWrites = false;
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (k: string) => store.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => {
    if (failKeychainWrites) throw new Error("setValueWithKeyAsync has failed");
    store.set(k, v);
  },
  deleteItemAsync: async (k: string) => void store.delete(k),
}));
vi.mock("./live-notifications.js", () => ({
  resumeLiveNotifications: async () => undefined,
  stopLiveNotifications: async () => undefined,
}));
vi.mock("./network-cache.js", () => ({ clearNetworkCache: () => undefined }));
vi.mock("./ai-consent", () => ({ promptAiConsent: async () => undefined }));

import { openOwnerSession, saveApiBase } from "./api.js";

type Reply = { status: number; body: unknown; delayMs?: number; headers?: Record<string, string> };
let server: Server;
let replies: Reply[];
let hits: number;

beforeEach(async () => {
  store.clear();
  failKeychainWrites = false;
  hits = 0;
  replies = [];
  server = createServer((req, res) => {
    const reply = replies[Math.min(hits, replies.length - 1)] as Reply;
    hits += 1;
    req.resume();
    setTimeout(() => {
      res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
      res.end(JSON.stringify(reply.body));
    }, reply.delayMs ?? 0);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const saved = await saveApiBase(`http://127.0.0.1:${port}`);
  expect(saved.ok).toBe(true);
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
});

const OK: Reply = { status: 200, body: { token: "owner-token" } };

describe("openOwnerSession", () => {
  it("retries once when the first attempt times out", async () => {
    replies = [{ ...OK, delayMs: 400 }, OK];
    await expect(openOwnerSession(100)).resolves.toEqual({ verificationRequired: false });
    expect(hits).toBe(2);
    expect(store.get("rakazo.session_token")).toBe("owner-token");
  });

  it("fails after the retry also times out", async () => {
    replies = [{ ...OK, delayMs: 400 }];
    await expect(openOwnerSession(100)).rejects.toThrow();
    expect(hits).toBe(2);
  });

  it("retries a network failure once", async () => {
    replies = [OK];
    await new Promise((done) => server.close(done));
    await expect(openOwnerSession(100)).rejects.toThrow();
  });

  it.each([401, 403, 404])("does not retry a %i refusal", async (status) => {
    replies = [{ status, body: { message: "no" } }];
    await expect(openOwnerSession(100)).rejects.toThrow();
    expect(hits).toBe(1);
  });

  it("does not call open again when the session cannot be saved on the device", async () => {
    replies = [OK];
    failKeychainWrites = true;
    await expect(openOwnerSession(1_000)).rejects.toThrow();
    expect(hits).toBe(1);
  });

  it("waits out a 429 Retry-After once and then retries", async () => {
    replies = [
      { status: 429, body: { message: "Try again in a moment." }, headers: { "retry-after": "1" } },
      OK,
    ];
    const started = Date.now();
    await expect(openOwnerSession(1_000)).resolves.toEqual({ verificationRequired: false });
    expect(hits).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it("gives up after a second 429 without a third call", async () => {
    replies = [
      { status: 429, body: { message: "Try again in a moment." }, headers: { "retry-after": "1" } },
    ];
    await expect(openOwnerSession(1_000)).rejects.toThrow();
    expect(hits).toBe(2);
  });

  it("waits longer than the default RPC timeout by default", async () => {
    const { OPEN_OWNER_TIMEOUT_MS } = await import("./api.js");
    expect(OPEN_OWNER_TIMEOUT_MS).toBeGreaterThan(8_000);
  });
});
