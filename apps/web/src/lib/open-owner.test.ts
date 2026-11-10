import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { requestOwnerSession } from "./open-owner";

let server: Server | undefined;
afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
});

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

it("posts to the open endpoint and reports success", async () => {
  const seen: string[] = [];
  const base = await serve((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  expect(await requestOwnerSession(base)).toBe(true);
  expect(seen).toEqual(["POST /api/auth/open"]);
});

it("reports a refusal, and an unreachable server, as false", async () => {
  const base = await serve((_req, res) => res.writeHead(403).end());
  expect(await requestOwnerSession(base)).toBe(false);
  await new Promise((resolve) => server!.close(resolve));
  expect(await requestOwnerSession(base)).toBe(false);
});
