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

import { currentApiBase, saveApiBase } from "./api.js";
import { connectShepherd } from "./shepherd-connect.js";

type Hit = { method: string; url: string; origin?: string; body: string };
type Reply = { status: number; body: unknown; headers?: Record<string, string> };

// A real HTTP server with the bridge's two relevant endpoints.
let server: Server;
let hits: Hit[];
let discovery: Reply;
let open: Reply[];
let openCalls: number;

const wellKnown = (over: Record<string, unknown> = {}): Reply => ({
  status: 200,
  body: {
    name: "Test Server",
    bridge_url: null,
    api_version: 1,
    auth_modes: ["tailnet", "password"],
    tailnet: true,
    ...over,
  },
});
const TOKEN: Reply = { status: 200, body: { token: "owner-token" } };

function bridge(label: string): Server {
  return createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      hits.push({
        method: req.method ?? "",
        url: `${label}${req.url ?? ""}`,
        origin: req.headers.origin,
        body: Buffer.concat(chunks).toString(),
      });
      let reply: Reply = { status: 404, body: { message: "not found" } };
      if (req.url === "/.well-known/herdr-shepherd") reply = discovery;
      if (req.url === "/api/auth/open") {
        reply = open[Math.min(openCalls, open.length - 1)] as Reply;
        openCalls += 1;
      }
      res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
      res.end(JSON.stringify(reply.body));
    });
  });
}
const listen = async (s: Server) => {
  await new Promise<void>((done) => s.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};
let other: Server;
let otherBase: string;

beforeEach(async () => {
  store.clear();
  failKeychainWrites = false;
  hits = [];
  openCalls = 0;
  discovery = wellKnown();
  open = [TOKEN];
  server = bridge("");
  other = bridge("other");
  const base = await listen(server);
  otherBase = await listen(other);
  const saved = await saveApiBase(base);
  expect(saved.ok).toBe(true);
});

afterEach(async () => {
  for (const s of [server, other]) {
    s.closeAllConnections();
    await new Promise((done) => s.close(done));
  }
});

const paths = () => hits.map((h) => `${h.method} ${h.url}`);

describe("connectShepherd", () => {
  it("probes first, then opens the session with the app origin and stores the token", async () => {
    await expect(connectShepherd()).resolves.toEqual({ kind: "connected" });
    expect(paths()).toEqual(["GET /.well-known/herdr-shepherd", "POST /api/auth/open"]);
    expect(hits[1]?.origin).toBe("rakazo://");
    expect(JSON.parse(hits[1]?.body ?? "")).toEqual({});
    expect(store.get("rakazo.session_token")).toBe("owner-token");
  });

  it("uses the bridge_url the server names for the open and everything after", async () => {
    discovery = wellKnown({ bridge_url: "PLACEHOLDER" });
    (discovery.body as { bridge_url: string }).bridge_url = otherBase;
    await expect(connectShepherd()).resolves.toEqual({ kind: "connected" });
    expect(paths()).toEqual(["GET /.well-known/herdr-shepherd", "POST other/api/auth/open"]);
    expect(currentApiBase()).toBe(otherBase);
  });

  it("shows Connect Tailscale without calling open when the server is off the tailnet", async () => {
    discovery = wellKnown({ tailnet: false, auth_modes: ["tailnet", "password"] });
    await expect(connectShepherd()).resolves.toEqual({ kind: "connect-tailscale" });
    expect(paths()).toEqual(["GET /.well-known/herdr-shepherd"]);
    expect(store.has("rakazo.session_token")).toBe(false);
  });

  it("asks for an update on an unsupported api_version without calling open", async () => {
    discovery = wellKnown({ api_version: 7 });
    await expect(connectShepherd()).resolves.toEqual({ kind: "update-app" });
    expect(paths()).toEqual(["GET /.well-known/herdr-shepherd"]);
  });

  it("shows Connect Tailscale when the server refuses the caller with 403", async () => {
    open = [{ status: 403, body: { message: "no" } }];
    await expect(connectShepherd()).resolves.toEqual({ kind: "connect-tailscale" });
    expect(openCalls).toBe(1);
  });

  it("still tries the existing open when the server has no discovery endpoint", async () => {
    discovery = { status: 404, body: { message: "not found" } };
    await expect(connectShepherd()).resolves.toEqual({ kind: "connected" });
    expect(paths()).toEqual(["GET /.well-known/herdr-shepherd", "POST /api/auth/open"]);
  });

  it("still tries the existing open when tailnet sign-in is not enabled", async () => {
    discovery = wellKnown({ auth_modes: ["password"] });
    await expect(connectShepherd()).resolves.toEqual({ kind: "connected" });
    expect(openCalls).toBe(1);
  });

  it("waits out a 429 Retry-After once and retries silently", async () => {
    open = [
      { status: 429, body: { message: "slow down" }, headers: { "retry-after": "1" } },
      TOKEN,
    ];
    const started = Date.now();
    await expect(connectShepherd()).resolves.toEqual({ kind: "connected" });
    expect(openCalls).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it("does not call open again when the session cannot be saved on the device", async () => {
    failKeychainWrites = true;
    await expect(connectShepherd()).rejects.toThrow();
    expect(openCalls).toBe(1);
  });

  it("rethrows other refusals so the screen can say it cannot reach the assistant", async () => {
    open = [{ status: 401, body: { message: "no" } }];
    await expect(connectShepherd()).rejects.toThrow();
    expect(openCalls).toBe(1);
  });
});
