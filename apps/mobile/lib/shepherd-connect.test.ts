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
import { reprobeOnActive } from "./foreground-reprobe.js";
import { type ConnectOptions, connectShepherd } from "./shepherd-connect.js";

// The loopback test servers speak plain http; production only follows https addresses.
const connect = (options: ConnectOptions = {}) =>
  connectShepherd({ allowLoopbackHttp: true, ...options });

type Hit = { method: string; url: string; origin?: string; body: string };
type Reply = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
};

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
      const answer = () => {
        res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
        res.end(JSON.stringify(reply.body));
      };
      if (reply.delayMs) setTimeout(answer, reply.delayMs);
      else answer();
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
    await expect(connect()).resolves.toEqual({ kind: "connected" });
    expect(paths()).toEqual(["GET /.well-known/herdr-shepherd", "POST /api/auth/open"]);
    expect(hits[1]?.origin).toBe("rakazo://");
    expect(JSON.parse(hits[1]?.body ?? "")).toEqual({});
    expect(store.get("rakazo.session_token")).toBe("owner-token");
  });

  it("uses the bridge_url the server names for the open and everything after", async () => {
    (discovery.body as { bridge_url: string }).bridge_url = otherBase;
    await expect(connect()).resolves.toEqual({ kind: "connected" });
    expect(paths()).toEqual(["GET /.well-known/herdr-shepherd", "POST other/api/auth/open"]);
    expect(currentApiBase()).toBe(otherBase);
  });

  it("shows Connect Tailscale without calling open when the server cannot be reached", async () => {
    // A phone off the tailnet cannot reach the host at all.
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await expect(connect()).resolves.toEqual({ kind: "connect-tailscale" });
    expect(hits).toEqual([]);
    expect(store.has("rakazo.session_token")).toBe(false);
  });

  // PENDING OWNER DECISION: what a server that answers with `tailnet:false` and no tailnet sign-in
  // should do. Today the app keeps the plain open (so a server without tailnet mode still works);
  // the onboarding contract would show Connect Tailscale. This documents the current behaviour only.
  it("keeps the plain open for the shape the live server sends today (tailnet false, password only)", async () => {
    discovery = {
      status: 200,
      body: {
        name: "herdr-shepherd",
        bridge_url: null,
        api_version: 1,
        auth_modes: ["password"],
        tailnet: false,
      },
    };
    await expect(connect()).resolves.toEqual({ kind: "connected" });
    expect(paths()).toEqual(["GET /.well-known/herdr-shepherd", "POST /api/auth/open"]);
  });

  it("ignores a bridge_url that is not https", async () => {
    (discovery.body as { bridge_url: string }).bridge_url = otherBase;
    await expect(connectShepherd()).resolves.toEqual({ kind: "connected" });
    expect(paths()).toEqual(["GET /.well-known/herdr-shepherd", "POST /api/auth/open"]);
    expect(currentApiBase()).not.toBe(otherBase);
  });

  it("refuses a bridge_url with a path instead of dropping the path", async () => {
    (discovery.body as { bridge_url: string }).bridge_url = `${otherBase}/shepherd`;
    await expect(connect()).rejects.toThrow();
    expect(paths()).toEqual(["GET /.well-known/herdr-shepherd"]);
    expect(currentApiBase()).not.toBe(otherBase);
  });

  it("does not open against the old address when the new one cannot be saved", async () => {
    (discovery.body as { bridge_url: string }).bridge_url = otherBase;
    failKeychainWrites = true;
    await expect(connect()).rejects.toThrow();
    expect(paths()).toEqual(["GET /.well-known/herdr-shepherd"]);
    expect(openCalls).toBe(0);
  });

  it("refuses a redirect from the discovery endpoint", async () => {
    discovery = {
      status: 302,
      body: {},
      headers: { location: `${otherBase}/.well-known/herdr-shepherd` },
    };
    await expect(connect()).resolves.toEqual({ kind: "connect-tailscale" });
    expect(paths()).toEqual(["GET /.well-known/herdr-shepherd"]);
    expect(openCalls).toBe(0);
  });

  it("ignores bridge_url in a build pinned to one server", async () => {
    (discovery.body as { bridge_url: string }).bridge_url = otherBase;
    process.env.EXPO_PUBLIC_PERSONAL_SERVER_ONLY = "true";
    try {
      await expect(connect()).resolves.toEqual({ kind: "connected" });
    } finally {
      process.env.EXPO_PUBLIC_PERSONAL_SERVER_ONLY = "false";
    }
    expect(paths()).toEqual(["GET /.well-known/herdr-shepherd", "POST /api/auth/open"]);
    expect(currentApiBase()).not.toBe(otherBase);
  });

  it("a cancelled attempt leaves no retry and no saved session behind", async () => {
    open = [{ ...TOKEN, delayMs: 300 }];
    const controller = new AbortController();
    const attempt = connect({ signal: controller.signal });
    const outcome = attempt.then(
      () => "done",
      () => "aborted",
    );
    await vi.waitFor(() => expect(openCalls).toBe(1));
    controller.abort();
    await expect(outcome).resolves.toBe("aborted");
    await new Promise((done) => setTimeout(done, 400));
    expect(openCalls).toBe(1);
    expect(store.has("rakazo.session_token")).toBe(false);
  });

  it("repeated foreground events while an attempt runs start a single open", async () => {
    open = [{ ...TOKEN, delayMs: 200 }];
    const busy = { current: false };
    const retry = () => {
      busy.current = true;
      void connect().finally(() => {
        busy.current = false;
      });
    };
    for (let i = 0; i < 5; i += 1) reprobeOnActive({ next: "active", busy, retry });
    reprobeOnActive({ next: "background", busy, retry });
    await vi.waitFor(() => expect(busy.current).toBe(false), { timeout: 3000 });
    expect(openCalls).toBe(1);
  });

  it("asks for an update on an unsupported api_version without calling open", async () => {
    discovery = wellKnown({ api_version: 7 });
    await expect(connect()).resolves.toEqual({ kind: "update-app" });
    expect(paths()).toEqual(["GET /.well-known/herdr-shepherd"]);
  });

  it("shows Connect Tailscale when the server refuses the caller with 403", async () => {
    open = [{ status: 403, body: { message: "no" } }];
    await expect(connect()).resolves.toEqual({ kind: "connect-tailscale" });
    expect(openCalls).toBe(1);
  });

  it("still tries the existing open when the server has no discovery endpoint", async () => {
    discovery = { status: 404, body: { message: "not found" } };
    await expect(connect()).resolves.toEqual({ kind: "connected" });
    expect(paths()).toEqual(["GET /.well-known/herdr-shepherd", "POST /api/auth/open"]);
  });

  it("still tries the existing open when tailnet sign-in is not enabled", async () => {
    discovery = wellKnown({ auth_modes: ["password"] });
    await expect(connect()).resolves.toEqual({ kind: "connected" });
    expect(openCalls).toBe(1);
  });

  it("waits out a 429 Retry-After once and retries silently", async () => {
    open = [
      { status: 429, body: { message: "slow down" }, headers: { "retry-after": "1" } },
      TOKEN,
    ];
    const started = Date.now();
    await expect(connect()).resolves.toEqual({ kind: "connected" });
    expect(openCalls).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it("does not call open again when the session cannot be saved on the device", async () => {
    failKeychainWrites = true;
    await expect(connect()).rejects.toThrow();
    expect(openCalls).toBe(1);
  });

  it("rethrows other refusals so the screen can say it cannot reach the assistant", async () => {
    open = [{ status: 401, body: { message: "no" } }];
    await expect(connect()).rejects.toThrow();
    expect(openCalls).toBe(1);
  });
});
