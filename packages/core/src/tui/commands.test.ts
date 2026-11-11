import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TuiRunOptions } from "./commands.js";
import { runTui } from "./commands.js";
import { TuiError } from "./errors.js";
import { toBase64 } from "./terminal-io.js";

const TOKEN = "tok-fixture-not-real";
const PASSWORD = "pw-fixture-not-real";

type Seen = { url: string; method: string; headers: IncomingMessage["headers"]; body: unknown };
type Handler = (input: unknown, seen: Seen) => unknown;

/** A real HTTP server speaking the oRPC RPCLink JSON/SSE wire for the routes a test registers. */
class FixtureServer {
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

function collect(stream: PassThrough): () => string {
  const parts: string[] = [];
  stream.on("data", (chunk: Buffer) => parts.push(chunk.toString()));
  return () => parts.join("");
}

const agentRow = (id: string, status: string, summary = "") => ({
  id,
  name: `Agent ${id}`,
  machine: "box",
  status,
  summary,
  updated_at: "2026-01-01T00:00:00Z",
  has_conversation: true,
});

let fixture: FixtureServer;
let dir: string;

beforeEach(async () => {
  fixture = new FixtureServer();
  await fixture.start();
  dir = mkdtempSync(path.join(tmpdir(), "tui-cmd-"));
});

afterEach(async () => {
  await fixture.stop();
  rmSync(dir, { recursive: true, force: true });
});

function run(argv: string[], extra: Partial<TuiRunOptions> = {}) {
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  const input = new PassThrough();
  const stdout = collect(output);
  const stderr = collect(errorOutput);
  const done = runTui({
    argv,
    env: { SHEPHERD_CLIENT_FILE: path.join(dir, "client.json") },
    input,
    output,
    errorOutput,
    interactive: false,
    ...extra,
  });
  return { done, input, stdout, stderr };
}

const withServer = (...rest: string[]) => ["--url", fixture.origin, "--token", TOKEN, ...rest];

describe("tui agents", () => {
  it("lists agents with the bearer token and follows live changes", async () => {
    fixture.json.set("agents/list", () => ({
      agents: [agentRow("a1", "idle"), agentRow("a2", "working")],
      hiddenCount: 0,
      cursor: 7,
    }));
    fixture.onStream.set("agents/subscribeList", () => {
      fixture.emit("agents/subscribeList", { seq: 8, row: agentRow("a1", "blocked", "needs you") });
      fixture.finish("agents/subscribeList");
    });
    const { done, stdout } = run(["agents", ...withServer("--space", "sp1")]);
    await done;
    const text = stdout();
    expect(text).toMatch(/working\s+a2/);
    expect(text).toMatch(/blocked\s+a1.*needs you/);
    const list = fixture.seen.find((s) => s.url === "/rpc/agents/list");
    expect(list?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(list?.headers["x-rakazo-space-id"]).toBe("sp1");
    const sub = fixture.seen.find((s) => s.url === "/rpc/agents/subscribeList");
    expect(sub?.headers.accept).toBe("text/event-stream");
    expect(sub?.body).toEqual({ json: { cursor: 7 } });
    expect(text).not.toContain(TOKEN);
  });

  it("says plainly that a Shepherd server does not serve agents", async () => {
    const { done } = run(["agents", "--once", ...withServer()]);
    await expect(done).rejects.toThrow(/not served by this server.*bridge/);
    await expect(done).rejects.toBeInstanceOf(TuiError);
  });

  it("reports an expired token without echoing it", async () => {
    fixture.json.set("agents/list", () => new Response("{}", { status: 401 }));
    const { done } = run(["agents", "--once", ...withServer()]);
    const error = await done.then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toMatch(/not signed in/);
    expect(error?.message).not.toContain(TOKEN);
  });
});

describe("tui agent", () => {
  it("prints history oldest first, then live events", async () => {
    const event = (seq: number, text: string) => ({
      seq,
      rev: seq,
      kind: "assistant",
      agent_id: "a1",
      parent_agent_id: null,
      ts: `t${seq}`,
      sensitive: false,
      redacted: false,
      truncated: false,
      size: 1,
      data: { text },
    });
    fixture.json.set("agents/get", () => ({
      agent: agentRow("a1", "working"),
      hasConversation: true,
    }));
    fixture.json.set("agents/messages", () => ({
      events: [event(2, "second"), event(1, "first")],
      hasMore: false,
      newestSeq: 2,
      rev: 2,
    }));
    fixture.onStream.set("agents/subscribe", () => {
      fixture.emit("agents/subscribe", { seq: 3, event: event(3, "live one") });
      fixture.finish("agents/subscribe");
    });
    const { done, stdout } = run(["agent", "a1", ...withServer()]);
    await done;
    const text = stdout();
    expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"));
    expect(text).toContain("live one");
    expect(fixture.seen.find((s) => s.url === "/rpc/agents/subscribe")?.body).toEqual({
      json: { id: "a1", cursor: 2 },
    });
  });
});

describe("tui attach", () => {
  const opened = { terminalId: "term-1", seq: 4, rows: 24, cols: 80 };

  it("repaints frames, types numbered input in order and closes the terminal", async () => {
    fixture.json.set("terminal/open", () => opened);
    fixture.json.set("terminal/input", () => ({ ok: true }));
    fixture.json.set("terminal/close", () => ({ ok: true }));
    fixture.onStream.set("terminal/subscribe", () => {
      fixture.emit("terminal/subscribe", { seq: 4, data: toBase64(Buffer.from("old")) });
      fixture.emit("terminal/subscribe", {
        seq: 5,
        data: toBase64(Buffer.from("$ ")),
        reset: true,
      });
    });
    const { done, input, stdout } = run(["attach", "a1", ...withServer()]);
    await waitFor(() => stdout().includes("$ "));
    input.write("ls");
    input.write("\r");
    await waitFor(() => fixture.seen.filter((s) => s.url === "/rpc/terminal/input").length === 2);
    fixture.emit("terminal/subscribe", { seq: 6, ended: true, exit: 0, reason: "pane_closed" });
    await done;
    expect(stdout()).toContain("\u001b[H\u001b[2J$ ");
    expect(stdout()).toContain("Terminal ended exit 0 (pane_closed).");
    const calls = fixture.seen.filter((s) => s.url === "/rpc/terminal/input").map((s) => s.body);
    expect(calls).toEqual([
      { json: { terminalId: "term-1", data: toBase64(Buffer.from("ls")), n: 1 } },
      { json: { terminalId: "term-1", data: toBase64(Buffer.from("\r")), n: 2 } },
    ]);
    expect(fixture.seen.some((s) => s.url === "/rpc/terminal/close")).toBe(true);
    expect(fixture.seen.find((s) => s.url === "/rpc/terminal/subscribe")?.body).toEqual({
      json: { terminalId: "term-1", cursor: 4 },
    });
  });

  it("detaches on Ctrl-] q without typing it", async () => {
    fixture.json.set("terminal/open", () => opened);
    fixture.json.set("terminal/close", () => ({ ok: true }));
    fixture.onStream.set("terminal/subscribe", () => undefined);
    const { done, input, stdout } = run(["attach", "a1", ...withServer()]);
    await waitFor(() => fixture.streams.has("terminal/subscribe"));
    input.write(Buffer.from([0x1d, 0x71]));
    await done;
    expect(stdout()).toContain("[Detached.]");
    expect(fixture.seen.some((s) => s.url === "/rpc/terminal/input")).toBe(false);
    expect(fixture.seen.some((s) => s.url === "/rpc/terminal/close")).toBe(true);
  });

  it("explains that terminal needs the bridge on a Shepherd server", async () => {
    const { done } = run(["attach", "a1", ...withServer()]);
    await expect(done).rejects.toThrow(/terminal\/open is not served/);
  });
});

describe("tui chat", () => {
  it("sends a line and prints the bot's reply until the run completes", async () => {
    fixture.json.set("threads/head", () => ({ threadId: "t1", cursor: 10 }));
    fixture.json.set("threads/send", (input) => {
      const text = (input as { text: string }).text;
      setTimeout(() => {
        const base = { id: "e", spaceId: "s", threadId: "t1", botId: "b1", createdAt: "now" };
        fixture.emit("threads/subscribe", {
          ...base,
          seq: 11,
          type: "thread.message.created",
          payload: { role: "bot", blocks: [{ kind: "text", text: `echo: ${text}` }] },
        });
        fixture.emit("threads/subscribe", { ...base, seq: 12, type: "run.completed", payload: {} });
      }, 10);
      return { taskId: "k", runId: "r", seq: 11 };
    });
    fixture.onStream.set("threads/subscribe", () => undefined);
    const { done, input, stdout } = run(["chat", "--bot", "b1", ...withServer()]);
    input.end("hello there\n");
    await done;
    expect(stdout()).toContain("echo: hello there");
    const send = fixture.seen.find((s) => s.url === "/rpc/threads/send");
    expect(send?.body).toMatchObject({ json: { botId: "b1", text: "hello there" } });
    expect(fixture.seen.find((s) => s.url === "/rpc/threads/subscribe")?.body).toEqual({
      json: { botId: "b1", cursor: 10 },
    });
  });

  it("needs --bot when there is no terminal to pick from", async () => {
    fixture.json.set("bots/list", () => [{ id: "b1", name: "Bee" }]);
    const { done } = run(["chat", ...withServer()]);
    await expect(done).rejects.toThrow(/--bot/);
  });
});

describe("tui login and sign-in", () => {
  it("saves url and token owner-only, never printing the token", async () => {
    fixture.json.set("health", () => ({ ok: true }));
    const { done, stdout, stderr } = run(["login", ...withServer()]);
    await done;
    const file = path.join(dir, "client.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ url: fixture.origin, token: TOKEN });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(stdout() + stderr()).not.toContain(TOKEN);
  });

  it("uses the saved file when no flags are given", async () => {
    fixture.json.set("health", () => ({ ok: true }));
    await run(["login", ...withServer()]).done;
    fixture.json.set("agents/list", () => ({ agents: [], hiddenCount: 0, cursor: 0 }));
    const { done, stdout } = run(["agents", "--once"]);
    await done;
    expect(stdout()).toContain("No agents.");
    expect(fixture.seen.at(-1)?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("opens the owner session on an open-owner server with the server's own origin", async () => {
    fixture.json.set("/api/auth/capabilities", () => ({ openOwner: true, passwordAuth: false }));
    fixture.json.set(
      "/api/auth/open",
      () => new Response("{}", { status: 200, headers: { "set-auth-token": "owner-token" } }),
    );
    fixture.json.set("agents/list", () => ({ agents: [], hiddenCount: 0, cursor: 0 }));
    const { done } = run(["agents", "--once", "--url", fixture.origin]);
    await done;
    const open = fixture.seen.find((s) => s.url === "/api/auth/open");
    expect(open?.headers.origin).toBe(fixture.origin);
    expect(fixture.seen.find((s) => s.url === "/rpc/agents/list")?.headers.authorization).toBe(
      "Bearer owner-token",
    );
  });

  it("asks for a sign-in on an accounts server without a token", async () => {
    fixture.json.set("/api/auth/capabilities", () => ({ openOwner: false, passwordAuth: true }));
    const { done } = run(["agents", "--once", "--url", fixture.origin]);
    await expect(done).rejects.toThrow(/Not signed in/);
  });

  it("signs in with a prompted password that is never echoed", async () => {
    fixture.json.set("/api/auth/sign-in/email", (_input, seen) => {
      expect(seen.method).toBe("POST");
      return { token: "session-token", user: { id: "u" } };
    });
    fixture.json.set("agents/list", () => ({ agents: [], hiddenCount: 0, cursor: 0 }));
    const { done, input, stdout } = run(
      ["agents", "--once", "--url", fixture.origin, "--email", "me@example.com"],
      { interactive: true },
    );
    await waitFor(() => stdout().includes("Password for me@example.com"));
    input.write(`${PASSWORD}\n`);
    await done;
    const signIn = fixture.seen.find((s) => s.url === "/api/auth/sign-in/email");
    expect(signIn?.body).toEqual({ email: "me@example.com", password: PASSWORD });
    expect(stdout()).not.toContain(PASSWORD);
    expect(fixture.seen.find((s) => s.url === "/rpc/agents/list")?.headers.authorization).toBe(
      "Bearer session-token",
    );
  });

  it("refuses password sign-in without a terminal", async () => {
    const { done } = run([
      "agents",
      "--once",
      "--url",
      fixture.origin,
      "--email",
      "me@example.com",
    ]);
    await expect(done).rejects.toThrow(/needs a terminal/);
  });
});

async function waitFor(condition: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
