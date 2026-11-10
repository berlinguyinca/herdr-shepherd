import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

/**
 * The real `models.testCompletion` handler against a real local HTTP server. Only the database
 * and secret store are small in-memory stand-ins, because the handler needs rows to look up.
 */
type Seen = { headers: IncomingMessage["headers"]; url: string };
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

async function startModelServer() {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      seen.push({ headers: request.headers, url: request.url ?? "" });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, baseUrl: `http://127.0.0.1:${port}/v1`, seen };
}

const actor = {
  spaceId: "workspace-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: true,
} satisfies Actor;

type Row = { id: string; userId: string; provider: string; secretId: string; plaintext: string };

function build(options: { rows?: Row[]; allowPrivate?: boolean; catalogTarget?: string } = {}) {
  const rows = options.rows ?? [];
  const forwarded: string[] = [];
  const deps = {
    prisma: {
      userModelPreference: { findFirst: async () => null },
      userModelCredential: {
        findFirst: async ({ where }: { where: { userId: string; provider: string } }) =>
          rows.find((row) => row.userId === where.userId && row.provider === where.provider) ??
          null,
        findMany: async ({ where }: { where: { userId: string; provider: string } }) =>
          rows.filter((row) => row.userId === where.userId && row.provider === where.provider),
      },
      secret: {
        findMany: async ({ where }: { where: { userId: string; id: { in: string[] } } }) =>
          rows
            .filter((row) => row.userId === where.userId && where.id.in.includes(row.secretId))
            .map((row) => ({ id: row.secretId, ciphertext: row.secretId })),
      },
    },
    secrets: {
      load: async (ciphertext: string) =>
        rows.find((row) => row.secretId === ciphertext)?.plaintext ?? "",
    },
    // The catalog endpoint is public; a real transport forwards it to the local server.
    modelConnectionFetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      forwarded.push(url.href);
      return fetch(`${options.catalogTarget}${url.pathname}`, init);
    },
    env: { sandboxProvider: "fake", mcpAllowPrivateEndpoint: options.allowPrivate ?? true },
  } as unknown as RouterDeps;
  const client = createRouterClient(createRouter(deps), { context: { actor } as never });
  return { client, forwarded };
}

describe("models.testCompletion route", () => {
  it("never borrows another user's saved credential by id", async () => {
    const model = await startModelServer();
    const { client } = build({
      rows: [
        {
          id: "foreign",
          userId: "other-user",
          provider: "openai-compatible",
          secretId: "s-foreign",
          plaintext: JSON.stringify({
            kind: "openai_compatible",
            baseUrl: model.baseUrl,
            apiKey: "foreign-key",
          }),
        },
      ],
    });
    const result = await client.models.testCompletion({
      baseUrl: model.baseUrl,
      modelId: "m",
      credentialId: "foreign",
    });
    expect(result.reply).toBe("OK");
    expect(model.seen[0]?.headers.authorization).toBeUndefined();
  });

  it("borrows the caller's saved key for the same endpoint but never for another baseUrl", async () => {
    const saved = await startModelServer();
    const other = await startModelServer();
    const { client } = build({
      rows: [
        {
          id: "mine",
          userId: actor.userId,
          provider: "openai-compatible",
          secretId: "s-mine",
          plaintext: JSON.stringify({
            kind: "openai_compatible",
            baseUrl: saved.baseUrl,
            apiKey: "saved-key",
          }),
        },
      ],
    });
    await client.models.testCompletion({ baseUrl: saved.baseUrl, modelId: "m" });
    await client.models.testCompletion({ baseUrl: other.baseUrl, modelId: "m" });
    expect(saved.seen[0]?.headers.authorization).toBe("Bearer saved-key");
    expect(other.seen[0]?.headers.authorization).toBeUndefined();
  });

  it("rejects a private URL when private endpoints are not allowed", async () => {
    const model = await startModelServer();
    const { client } = build({ allowPrivate: false });
    await expect(
      client.models.testCompletion({ baseUrl: model.baseUrl, modelId: "m" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/private/i) });
    expect(model.seen).toHaveLength(0);
  });

  it("ignores headers and credentialId on the catalog branch and sends only the typed key", async () => {
    const target = await startModelServer();
    const { client, forwarded } = build({
      catalogTarget: target.origin,
      rows: [
        {
          id: "mine",
          userId: actor.userId,
          provider: "openai-compatible",
          secretId: "s-mine",
          plaintext: JSON.stringify({
            kind: "openai_compatible",
            baseUrl: "https://openrouter.ai/api/v1",
            apiKey: "saved-key",
            headers: { "x-saved": "saved-header" },
          }),
        },
      ],
    });
    const result = await client.models.testCompletion({
      provider: "openrouter",
      modelId: "m",
      apiKey: "typed-key",
      credentialId: "mine",
      headers: { "x-injected": "evil" },
    });
    expect(result.reply).toBe("OK");
    expect(forwarded[0]).toMatch(/^https:\/\/openrouter\.ai\//);
    const headers = target.seen[0]?.headers;
    expect(headers?.authorization).toBe("Bearer typed-key");
    expect(headers?.["x-injected"]).toBeUndefined();
    expect(headers?.["x-saved"]).toBeUndefined();
  });

  it("returns TOO_MANY_REQUESTS after ten tests in a minute", async () => {
    const model = await startModelServer();
    const { client } = build();
    for (let call = 0; call < 10; call += 1) {
      await client.models.testCompletion({ baseUrl: model.baseUrl, modelId: "m" });
    }
    await expect(
      client.models.testCompletion({ baseUrl: model.baseUrl, modelId: "m" }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(model.seen).toHaveLength(10);
  });
});
