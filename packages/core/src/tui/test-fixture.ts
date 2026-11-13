import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { PassThrough } from "node:stream";

export type Seen = {
  url: string;
  method: string;
  headers: IncomingMessage["headers"];
  body: unknown;
};
export type Handler = (input: unknown, seen: Seen) => unknown;

/** A real HTTP server speaking the oRPC RPCLink JSON/SSE wire for the routes a test registers. */
export class FixtureServer {
  readonly seen: Seen[] = [];
  readonly json = new Map<string, Handler>();
  readonly streams = new Map<string, ServerResponse[]>();
  readonly onStream = new Map<string, (input: unknown) => void>();
  private server: Server | undefined;
  origin = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const list of this.streams.values()) for (const res of list) res.destroy();
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  emit(route: string, data: unknown): void {
    for (const res of this.streams.get(route) ?? []) {
      res.write(`event: message\ndata: ${JSON.stringify({ json: data })}\n\n`);
    }
  }

  finish(route: string): void {
    for (const res of this.streams.get(route) ?? []) {
      res.write(`event: done\ndata: ${JSON.stringify({ json: null })}\n\n`);
      res.end();
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString();
    const parsed = text ? (JSON.parse(text) as { json?: unknown }) : {};
    const url = req.url ?? "";
    const seen: Seen = { url, method: req.method ?? "", headers: req.headers, body: parsed };
    this.seen.push(seen);
    const route = url.replace(/^\/rpc\//, "");
    const input = parsed.json;
    if (this.onStream.has(route)) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.flushHeaders();
      this.streams.set(route, [...(this.streams.get(route) ?? []), res]);
      this.onStream.get(route)?.(input);
      return;
    }
    const handler = this.json.get(url.startsWith("/rpc/") ? route : url);
    if (!handler) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          json: { defined: false, code: "NOT_FOUND", status: 404, message: "Not found", data: {} },
        }),
      );
      return;
    }
    const output = handler(input, seen);
    if (output instanceof Response) {
      res.writeHead(output.status, Object.fromEntries(output.headers));
      res.end(await output.text());
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(url.startsWith("/rpc/") ? { json: output } : output));
  }
}

export function collect(stream: PassThrough): () => string {
  const parts: string[] = [];
  stream.on("data", (chunk: Buffer) => parts.push(chunk.toString()));
  return () => parts.join("");
}
