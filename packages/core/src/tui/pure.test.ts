import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRow } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { parseTuiArgs } from "./args.js";
import {
  clientFilePath,
  insecureUrlWarning,
  normalizeServerUrl,
  readClientFile,
  resolveConnection,
  writeClientFile,
} from "./config.js";
import { TuiError } from "./errors.js";
import { applyListFrame, chatLineFor, formatAgentTable, sanitize } from "./render.js";
import {
  chunkBytes,
  createDetachFilter,
  createInputSequencer,
  fromBase64,
  interpretFrame,
  toBase64,
} from "./terminal-io.js";

const row = (over: Partial<AgentRow>): AgentRow => ({
  id: "a1",
  name: "Alpha",
  machine: null,
  status: "idle",
  summary: "",
  updated_at: "2026-01-01T00:00:00Z",
  has_conversation: false,
  ...over,
});

describe("parseTuiArgs", () => {
  it("parses commands and connection flags", () => {
    expect(parseTuiArgs(["agents", "--all", "--url", "http://x", "--token", "t"])).toEqual({
      command: { kind: "agents", all: true, once: false },
      flags: { url: "http://x", token: "t" },
    });
    expect(parseTuiArgs(["attach", "abc"]).command).toEqual({ kind: "attach", id: "abc" });
    expect(parseTuiArgs(["chat", "--bot", "b"]).command).toEqual({ kind: "chat", botId: "b" });
    expect(parseTuiArgs([]).command).toEqual({ kind: "help" });
  });

  it("rejects unknown commands, missing ids and unknown flags", () => {
    expect(() => parseTuiArgs(["nope"])).toThrow(TuiError);
    expect(() => parseTuiArgs(["agent"])).toThrow(/exactly one agent id/);
    expect(() => parseTuiArgs(["agents", "--bogus"])).toThrow(TuiError);
  });
});

describe("config", () => {
  it("lets flags win over env and env over the file", () => {
    const file = { url: "http://file:1", token: "ft" };
    expect(resolveConnection({}, {}, file)).toEqual({ url: "http://file:1", token: "ft" });
    expect(
      resolveConnection({}, { SHEPHERD_URL: "http://env:2", SHEPHERD_TOKEN: "et" }, file),
    ).toEqual({ url: "http://env:2", token: "et" });
    expect(
      resolveConnection(
        { url: "http://flag:3/", token: "gt" },
        { SHEPHERD_URL: "http://env:2" },
        file,
      ),
    ).toEqual({
      url: "http://flag:3",
      token: "gt",
    });
  });

  it("refuses a missing url and non-http urls and embedded logins", () => {
    expect(() => resolveConnection({}, {}, {})).toThrow(/No server URL/);
    expect(() => normalizeServerUrl("ftp://x")).toThrow(/http/);
    expect(() => normalizeServerUrl("http://u:p@x")).toThrow(/credentials/);
    expect(() => normalizeServerUrl("not a url")).toThrow(TuiError);
  });

  it("warns on plain http outside loopback and Tailscale only", () => {
    expect(insecureUrlWarning("http://127.0.0.1:3100")).toBeUndefined();
    expect(insecureUrlWarning("http://localhost:3100")).toBeUndefined();
    expect(insecureUrlWarning("http://100.101.102.103:3100")).toBeUndefined();
    expect(insecureUrlWarning("https://example.com")).toBeUndefined();
    expect(insecureUrlWarning("http://example.com")).toMatch(/plain http/);
  });

  it("writes the client file owner-only and reads it back", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tui-config-"));
    try {
      const file = clientFilePath({ XDG_CONFIG_HOME: dir });
      writeClientFile(file, { url: "http://x", token: "secret" });
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readClientFile(file)).toEqual({ url: "http://x", token: "secret" });
      expect(readClientFile(path.join(dir, "missing.json"))).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("terminal io", () => {
  it("numbers input calls from 1 and splits at 32 KB", () => {
    const sequencer = createInputSequencer();
    expect(sequencer.next(new Uint8Array([104, 105]))).toEqual([{ data: "aGk=", n: 1 }]);
    const big = sequencer.next(new Uint8Array(70 * 1024));
    expect(big.map((call) => call.n)).toEqual([2, 3, 4]);
    expect(fromBase64(big[0]!.data)).toHaveLength(32 * 1024);
    expect(chunkBytes(new Uint8Array(0))).toEqual([]);
    expect(toBase64(fromBase64("AAEC"))).toBe("AAEC");
  });

  it("detaches on Ctrl-] q, even split across chunks, and escapes a literal Ctrl-]", () => {
    const filter = createDetachFilter();
    expect(filter.feed(Uint8Array.from([97, 0x1d]))).toEqual({
      forward: Uint8Array.from([97]),
      detach: false,
    });
    expect(filter.feed(Uint8Array.from([0x71, 98]))).toMatchObject({ detach: true });
    const other = createDetachFilter();
    expect(other.feed(Uint8Array.from([0x1d, 0x1d, 0x1d, 120]))).toEqual({
      forward: Uint8Array.from([0x1d, 120]),
      detach: false,
    });
  });

  it("repaints each whole-screen frame after a clear and skips seen ones", () => {
    const frame = { seq: 5, data: toBase64(Buffer.from("hello")), rows: 10, cols: 20 };
    const action = interpretFrame(frame, 4);
    expect(action.kind).toBe("paint");
    if (action.kind !== "paint") return;
    expect(Buffer.from(action.bytes).toString()).toBe("\u001b[H\u001b[2Jhello");
    expect(action).toMatchObject({ rows: 10, cols: 20 });
    expect(interpretFrame(frame, 5)).toEqual({ kind: "skip" });
    expect(interpretFrame({ seq: 6 }, 5)).toEqual({ kind: "skip" });
  });

  it("ends on ended and taken_over frames with a reason", () => {
    expect(interpretFrame({ seq: 2, ended: true, exit: 0, reason: "pane_closed" }, 1)).toEqual({
      kind: "end",
      seq: 2,
      message: "Terminal ended exit 0 (pane_closed).",
    });
    expect(interpretFrame({ seq: 2, taken_over: true }, 1)).toMatchObject({ kind: "end" });
  });
});

describe("render", () => {
  it("strips escape sequences and control characters from remote text", () => {
    expect(sanitize("a\u001b[31mred\u001b[0m\u001b]0;title\u0007b\u0007c\td")).toBe("aredbc\td");
  });

  it("sorts blocked first and drops closed agents from the live list", () => {
    const rows = new Map<string, AgentRow>();
    applyListFrame(rows, row({ id: "a", status: "idle" }));
    applyListFrame(rows, row({ id: "b", status: "blocked", summary: "needs\u001b[2Jinput" }));
    const lines = formatAgentTable(rows.values()).split("\n");
    expect(lines[0]).toMatch(/^blocked\s+b/);
    expect(lines[0]).not.toContain("\u001b");
    applyListFrame(rows, row({ id: "b", status: "closed" }));
    expect(formatAgentTable(rows.values())).toMatch(/^idle\s+a/);
    expect(formatAgentTable([])).toBe("No agents.");
  });

  it("turns bot messages into chat text and run ends into status", () => {
    const base = {
      id: "e",
      spaceId: "s",
      threadId: "t",
      botId: "b",
      seq: 1,
      createdAt: "now",
    };
    expect(
      chatLineFor({
        ...base,
        type: "thread.message.created",
        payload: { role: "bot", blocks: [{ kind: "text", text: "hi" }] },
      }),
    ).toEqual({ kind: "bot", text: "hi" });
    expect(chatLineFor({ ...base, type: "run.failed", payload: {} })).toEqual({
      kind: "end",
      text: "[run failed]",
    });
    expect(chatLineFor({ ...base, type: "thread.progress", payload: {} })).toEqual({
      kind: "ignore",
    });
  });
});
