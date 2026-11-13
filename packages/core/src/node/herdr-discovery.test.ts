import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { discoverHerdrUrl, peerAddresses } from "./herdr-discovery.js";

const servers: Server[] = [];

async function serve(body: unknown, status = 200): Promise<number> {
  const server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

const herdrCapabilities = {
  sso: null,
  passwordAuth: true,
  nativePasskeys: { ios: false, android: false },
};

describe("peerAddresses", () => {
  it("lists the online peers' IPv4 addresses", () => {
    const status = JSON.stringify({
      Self: { TailscaleIPs: ["100.84.185.100"] },
      Peer: {
        a: { Online: true, TailscaleIPs: ["fd7a:115c:a1e0::1", "100.104.39.6"] },
        b: { Online: false, TailscaleIPs: ["100.96.156.65"] },
        c: { Online: true },
      },
    });
    expect(peerAddresses(status)).toEqual(["100.104.39.6"]);
  });

  it("is empty for anything that is not a status document", () => {
    expect(peerAddresses("not json")).toEqual([]);
    expect(peerAddresses("{}")).toEqual([]);
  });
});

describe("discoverHerdrUrl", () => {
  it("picks the peer that answers like herdr and skips the rest", async () => {
    const other = await serve({ hello: "world" });
    const notFound = await serve({ error: "nope" }, 404);
    const herdr = await serve(herdrCapabilities);
    // Each "peer" is one local port; the probe port is the only difference between them.
    const ports = [other, notFound, herdr];
    const fetchImpl: typeof fetch = (input, init) => {
      const url = new URL(String(input));
      const index = Number(url.hostname.split(".")[3]);
      return fetch(`http://127.0.0.1:${ports[index]}${url.pathname}`, init);
    };
    const found = await discoverHerdrUrl({
      peers: async () => ["10.0.0.0", "10.0.0.1", "10.0.0.2"],
      fetchImpl,
    });
    expect(found).toBe("http://10.0.0.2");
  });

  it("finds nothing without peers or when none is herdr", async () => {
    expect(await discoverHerdrUrl({ peers: async () => [] })).toBeUndefined();
    const other = await serve({ hello: "world" });
    const found = await discoverHerdrUrl({
      peers: async () => ["127.0.0.1"],
      port: other,
    });
    expect(found).toBeUndefined();
  });

  it("finds a herdr dashboard on a given port", async () => {
    const port = await serve(herdrCapabilities);
    expect(await discoverHerdrUrl({ peers: async () => ["127.0.0.1"], port })).toBe(
      `http://127.0.0.1:${port}`,
    );
  });
});
