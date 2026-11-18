import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acceptBridgeUrl, probeShepherd, WELL_KNOWN_PATH } from "./shepherd-discovery";

// A real HTTP server that answers like the Shepherd bridge's /.well-known/herdr-shepherd.
type Reply = {
  status: number;
  body?: unknown;
  raw?: string;
  delayMs?: number;
  location?: string;
};
let server: Server;
let reply: Reply;
let seen: IncomingMessage[];
let base: string;

beforeEach(async () => {
  seen = [];
  reply = { status: 200, body: {} };
  server = createServer((req, res) => {
    seen.push(req);
    req.resume();
    setTimeout(() => {
      res.writeHead(reply.status, {
        "content-type": "application/json",
        ...(reply.location ? { location: reply.location } : {}),
      });
      res.end(reply.raw ?? JSON.stringify(reply.body ?? {}));
    }, reply.delayMs ?? 0);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
});

const wellKnown = (over: Record<string, unknown> = {}) => ({
  name: "Test Server",
  bridge_url: "https://bridge.test.example",
  api_version: 1,
  auth_modes: ["tailnet", "password"],
  tailnet: true,
  ...over,
});

describe("probeShepherd", () => {
  it("asks the well-known path with a plain GET and no credentials", async () => {
    reply = { status: 200, body: wellKnown() };
    await probeShepherd(base);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.url).toBe(WELL_KNOWN_PATH);
    expect(seen[0]?.headers.authorization).toBeUndefined();
    expect(seen[0]?.headers.cookie).toBeUndefined();
  });

  it("opens the tailnet session when the server says tailnet and offers the tailnet mode", async () => {
    reply = { status: 200, body: wellKnown() };
    await expect(probeShepherd(base)).resolves.toEqual({
      kind: "tailnet",
      bridgeUrl: "https://bridge.test.example",
    });
  });

  it("keeps the probed URL when the response names no bridge_url", async () => {
    reply = { status: 200, body: wellKnown({ bridge_url: null }) };
    await expect(probeShepherd(base)).resolves.toEqual({ kind: "tailnet", bridgeUrl: base });
  });

  it("falls back to password when the tailnet mode is not enabled", async () => {
    reply = { status: 200, body: wellKnown({ auth_modes: ["password"] }) };
    await expect(probeShepherd(base)).resolves.toEqual({ kind: "password" });
  });

  // PENDING OWNER DECISION: this is the shape the live server sends today. The app keeps the plain
  // open for it; the onboarding contract would show Connect Tailscale instead. The server only sends
  // tailnet:true to an identified tailnet peer and lists "tailnet" in auth_modes only when
  // tailnet_open_owner is on, so "tailnet:false with a tailnet mode" is not a response it can emit.
  it("keeps the plain open for the live shape: tailnet false, password only, no bridge_url", async () => {
    reply = {
      status: 200,
      body: {
        name: "herdr-shepherd",
        bridge_url: null,
        api_version: 1,
        auth_modes: ["password"],
        tailnet: false,
      },
    };
    await expect(probeShepherd(base)).resolves.toEqual({ kind: "password" });
  });

  it("refuses a redirect from the discovery endpoint", async () => {
    reply = { status: 302, body: {}, location: "https://elsewhere.test.example/x" };
    await expect(probeShepherd(base)).resolves.toEqual({ kind: "off-tailnet" });
  });

  it("stops when the caller's signal aborts", async () => {
    reply = { status: 200, body: wellKnown(), delayMs: 500 };
    const controller = new AbortController();
    const result = probeShepherd(base, 5000, { signal: controller.signal });
    controller.abort();
    await expect(result).resolves.toEqual({ kind: "off-tailnet" });
  });

  it("asks for an app update on an api_version this app does not speak", async () => {
    reply = { status: 200, body: wellKnown({ api_version: 2 }) };
    await expect(probeShepherd(base)).resolves.toEqual({ kind: "update-app" });
  });

  it.each([
    ["missing", undefined],
    ["a string", "1"],
  ])("treats %s api_version as unsupported", async (_name, api_version) => {
    reply = { status: 200, body: wellKnown({ api_version }) };
    await expect(probeShepherd(base)).resolves.toEqual({ kind: "update-app" });
  });

  it("treats a timeout as off the tailnet", async () => {
    reply = { status: 200, body: wellKnown(), delayMs: 500 };
    await expect(probeShepherd(base, 100)).resolves.toEqual({ kind: "off-tailnet" });
  });

  it("treats an unreachable host as off the tailnet", async () => {
    await new Promise((done) => server.close(done));
    await expect(probeShepherd(base, 500)).resolves.toEqual({ kind: "off-tailnet" });
  });

  it.each([404, 405, 500])(
    "reports a server without discovery on HTTP %i so the existing sign-in path runs",
    async (status) => {
      reply = { status, body: { message: "nope" } };
      await expect(probeShepherd(base)).resolves.toEqual({ kind: "undiscoverable" });
    },
  );

  it("reports an unreadable body as a server without discovery", async () => {
    reply = { status: 200, raw: "<html>not json</html>" };
    await expect(probeShepherd(base)).resolves.toEqual({ kind: "undiscoverable" });
  });

  it("does not follow a bridge_url that is not an http(s) URL", async () => {
    reply = { status: 200, body: wellKnown({ bridge_url: "javascript:alert(1)" }) };
    await expect(probeShepherd(base)).resolves.toEqual({ kind: "tailnet", bridgeUrl: base });
  });
});

describe("acceptBridgeUrl", () => {
  it("accepts https and keeps the path, without a trailing slash", () => {
    expect(acceptBridgeUrl("https://bridge.test.example")).toBe("https://bridge.test.example");
    expect(acceptBridgeUrl("https://bridge.test.example/shepherd/")).toBe(
      "https://bridge.test.example/shepherd",
    );
  });

  it("refuses http unless it is loopback and the caller allows it", () => {
    expect(acceptBridgeUrl("http://bridge.test.example")).toBeNull();
    expect(acceptBridgeUrl("http://127.0.0.1:8080")).toBeNull();
    expect(acceptBridgeUrl("http://127.0.0.1:8080", true)).toBe("http://127.0.0.1:8080");
    expect(acceptBridgeUrl("http://bridge.test.example", true)).toBeNull();
  });

  it.each([
    "https://user:pw@bridge.test.example",
    "https://bridge.test.example/?a=1",
    "https://bridge.test.example/#x",
    "ftp://bridge.test.example",
    "not a url",
    42,
  ])("refuses %s", (value) => {
    expect(acceptBridgeUrl(value)).toBeNull();
  });
});
