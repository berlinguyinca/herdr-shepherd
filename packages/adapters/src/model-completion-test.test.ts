import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { testModelCompletion } from "./model-completion-test.js";

const OWNER = { allowPrivate: true };

type Seen = { url: string; headers: IncomingMessage["headers"]; body: Record<string, unknown> };

/** A real local server speaking the OpenAI-compatible and Anthropic Messages shapes. */
async function startServer(
  respond: (seen: Seen) => { status: number; json: unknown; delayMs?: number },
) {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const entry: Seen = {
        url: request.url ?? "",
        headers: request.headers,
        body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {},
      };
      seen.push(entry);
      const reply = respond(entry);
      setTimeout(() => {
        response.writeHead(reply.status, { "content-type": "application/json" });
        response.end(JSON.stringify(reply.json));
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${port}/v1`, seen };
}

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

describe("testModelCompletion", () => {
  it("sends a tiny chat completion and returns the reply with latency", async () => {
    const { baseUrl, seen } = await startServer(() => ({
      status: 200,
      delayMs: 20,
      json: { choices: [{ message: { role: "assistant", content: " OK " } }] },
    }));
    const result = await testModelCompletion(
      { baseUrl, modelId: "tiny", apiKey: "k-1234567890" },
      undefined,
      undefined,
      OWNER,
    );
    expect(result.reply).toBe("OK");
    expect(result.latencyMs).toBeGreaterThanOrEqual(15);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("/v1/chat/completions");
    expect(seen[0]?.headers.authorization).toBe("Bearer k-1234567890");
    expect(seen[0]?.body.model).toBe("tiny");
    expect(seen[0]?.body.max_tokens).toBeLessThanOrEqual(64);
    expect(seen[0]?.body.stream).toBe(false);
  });

  it("uses the Responses wire shape", async () => {
    const { baseUrl, seen } = await startServer(() => ({
      status: 200,
      json: { output: [{ content: [{ type: "output_text", text: "OK" }] }] },
    }));
    const result = await testModelCompletion(
      { baseUrl, modelId: "m", apiProtocol: "responses" },
      undefined,
      undefined,
      OWNER,
    );
    expect(result.reply).toBe("OK");
    expect(seen[0]?.url).toBe("/v1/responses");
    expect(seen[0]?.body.max_output_tokens).toBeGreaterThanOrEqual(16);
  });

  it("uses the Anthropic Messages wire shape and headers", async () => {
    const { baseUrl, seen } = await startServer(() => ({
      status: 200,
      json: { content: [{ type: "text", text: "OK" }] },
    }));
    const result = await testModelCompletion(
      { baseUrl, modelId: "m", apiProtocol: "anthropic-messages", apiKey: "ak-1234567890" },
      undefined,
      undefined,
      OWNER,
    );
    expect(result.reply).toBe("OK");
    expect(seen[0]?.url).toBe("/v1/messages");
    expect(seen[0]?.headers["x-api-key"]).toBe("ak-1234567890");
    expect(seen[0]?.headers["anthropic-version"]).toBeTruthy();
  });

  it("reports a provider error without echoing the key", async () => {
    const key = "sk-secretsecret1234";
    const { baseUrl } = await startServer(() => ({
      status: 401,
      json: { error: { message: `Incorrect API key provided: ${key}` } },
    }));
    const failure = await testModelCompletion(
      { baseUrl, modelId: "m", apiKey: key },
      undefined,
      undefined,
      OWNER,
    ).then(
      () => null,
      (error: Error) => error,
    );
    expect(failure?.message).toMatch(/401/);
    expect(failure?.message).toMatch(/Incorrect API key/);
    expect(failure?.message).not.toContain(key);
  });

  it("succeeds with an empty reply when a reasoning model returns no text", async () => {
    const { baseUrl } = await startServer(() => ({
      status: 200,
      json: { choices: [{ message: { content: null }, finish_reason: "length" }] },
    }));
    const result = await testModelCompletion(
      { baseUrl, modelId: "m" },
      undefined,
      undefined,
      OWNER,
    );
    expect(result.reply).toBe("");
  });

  it("rejects private endpoints unless the deployment allows them", async () => {
    const { baseUrl, seen } = await startServer(() => ({ status: 200, json: {} }));
    await expect(testModelCompletion({ baseUrl, modelId: "m" })).rejects.toThrow(/private/i);
    expect(seen).toHaveLength(0);
  });

  it("stops when the caller cancels", async () => {
    const { baseUrl } = await startServer(() => ({ status: 200, json: {}, delayMs: 500 }));
    const controller = new AbortController();
    const pending = testModelCompletion(
      { baseUrl, modelId: "m" },
      undefined,
      controller.signal,
      OWNER,
    );
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});
