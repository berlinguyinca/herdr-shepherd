import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRow } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { parseTuiArgs } from "./args.js";
import {
  assertPasswordTransport,
  clientFilePath,
  insecureUrlWarning,
  normalizeServerUrl,
  readClientFile,
  resolveConnection,
  writeClientFile,
} from "./config.js";
import { TuiError } from "./errors.js";
import {
  applyListFrame,
  chatLineFor,
  formatAgentRow,
  formatAgentTable,
  oneLine,
  sanitize,
} from "./render.js";
import {
  chunkBytes,
  createDetachFilter,
  createInputSequencer,
  filterTerminalInput,
  filterTerminalOutput,
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

describe("saved token belongs to its server", () => {
  const file = { url: "http://127.0.0.1:3100", token: "saved", space: "sp" };

  it("uses the file token and space only for the same server", () => {
    expect(resolveConnection({}, {}, file)).toEqual({
      url: "http://127.0.0.1:3100",
      token: "saved",
      space: "sp",
    });
    expect(resolveConnection({ url: "http://127.0.0.1:3100/" }, {}, file).token).toBe("saved");
  });

  it("never sends it to another url from a flag or the environment", () => {
    expect(resolveConnection({ url: "http://evil.example" }, {}, file)).toEqual({
      url: "http://evil.example",
    });
    expect(resolveConnection({}, { SHEPHERD_URL: "http://evil.example" }, file)).toEqual({
      url: "http://evil.example",
    });
  });

  it("still lets a flag or env token go to any url", () => {
    expect(resolveConnection({ url: "http://b", token: "t" }, {}, file).token).toBe("t");
    expect(resolveConnection({ url: "http://b" }, { SHEPHERD_TOKEN: "e" }, file).token).toBe("e");
  });
});

describe("password transport", () => {
  it("allows https and loopback, refuses other plain http unless --insecure", () => {
    expect(() => assertPasswordTransport("https://example.com", false)).not.toThrow();
    expect(() => assertPasswordTransport("http://127.0.0.1:3100", false)).not.toThrow();
    expect(() => assertPasswordTransport("http://localhost:3100", false)).not.toThrow();
    expect(() => assertPasswordTransport("http://100.64.0.5:3100", false)).toThrow(/plain http/);
    expect(() => assertPasswordTransport("http://example.com", false)).toThrow(/--insecure/);
    expect(() => assertPasswordTransport("http://example.com", true)).not.toThrow();
  });

  it("does not warn for *.ts.net", () => {
    expect(insecureUrlWarning("http://box.tail1234.ts.net:3100")).toBeUndefined();
  });
});

describe("client file safety", () => {
  it("refuses a symlinked client file and tightens a loose directory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tui-link-"));
    try {
      const target = path.join(dir, "target.json");
      writeFileSync(target, "{}");
      const link = path.join(dir, "client.json");
      symlinkSync(target, link);
      expect(() => writeClientFile(link, { url: "http://x", token: "t" })).toThrow(/symlink/);
      expect(() => readClientFile(link)).toThrow(/symlink/);
      expect(readFileOf(target)).toBe("{}");
      const loose = path.join(dir, "loose");
      mkdirSync(loose);
      chmodSync(loose, 0o755);
      writeClientFile(path.join(loose, "client.json"), { url: "http://x" });
      expect(statSync(loose).mode & 0o777).toBe(0o700);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { readFileSync } from "node:fs";

const readFileOf = (file: string): string => readFileSync(file, "utf8");

describe("hostile text", () => {
  it("strips bidi overrides, zero-width and separators, and flattens single-line fields", () => {
    expect(sanitize("a\u202eb\u2066c\u200bd\u2028e\ufefff")).toBe("abcdef");
    expect(oneLine("x\ny\r\nz  w", 50)).toBe("x y z w");
    const line = formatAgentRow(
      row({ id: "i\nd", machine: "m\u001b[2Jx\ny", status: "\u001b[31mred" as never }),
    );
    expect(line.includes(String.fromCharCode(27)) || line.includes("\n")).toBe(false);
  });
});

describe("terminal output filter", () => {
  const ESC = "\u001b";
  const run = (text: string) => Buffer.from(filterTerminalOutput(Buffer.from(text))).toString();
  const blocked: [string, string][] = [
    ["OSC 52 clipboard (BEL)", `${ESC}]52;c;ZXZpbA==\u0007`],
    ["OSC 52 clipboard (ST)", `${ESC}]52;c;ZXZpbA==${ESC}\\`],
    ["OSC 1337", `${ESC}]1337;File=inline=1:AAAA\u0007`],
    ["OSC 50 font", `${ESC}]50;?\u0007`],
    ["OSC 7 cwd", `${ESC}]7;file:///etc\u0007`],
    ["OSC title", `${ESC}]0;title\u0007`],
    ["DCS DECRQSS", `${ESC}P$qm${ESC}\\`],
    ["APC", `${ESC}_Gf=100;AAAA${ESC}\\`],
    ["PM", `${ESC}^secret${ESC}\\`],
    ["SOS", `${ESC}Xsecret${ESC}\\`],
    ["window report CSI 21 t", `${ESC}[21t`],
    ["DSR CSI 6 n", `${ESC}[6n`],
    ["DSR CSI ? 6 n", `${ESC}[?6n`],
    ["primary DA", `${ESC}[c`],
    ["secondary DA", `${ESC}[>c`],
    ["DECRQM", `${ESC}[?2004$p`],
    ["XTVERSION", `${ESC}[>0q`],
    ["8-bit CSI", "\u009b6n"],
    ["ENQ", "\u0005"],
  ];
  it.each(blocked)("drops %s", (_name, sequence) => {
    expect(run(`a${sequence}b`)).toBe("ab");
  });

  it("swallows an unterminated string sequence to the end of the frame", () => {
    expect(run(`ok${ESC}]52;c;AAAA rest`)).toBe("ok");
  });

  const kept = [
    `${ESC}[31;1mred${ESC}[0m`,
    `${ESC}[2J${ESC}[H`,
    `${ESC}[10;20H`,
    `${ESC}[?1049h`,
    `${ESC}[?25l`,
    `${ESC}[1;24r`,
    `${ESC}[38;2;1;2;3m`,
    `${ESC}7${ESC}8`,
    `plain \u00e9\u4e2d text\r\n`,
  ];
  it.each(kept)("keeps %j", (sequence) => {
    expect(run(sequence)).toBe(sequence);
  });

  it("drops terminal replies from the keyboard stream but keeps keys", () => {
    const input = (text: string) =>
      Buffer.from(filterTerminalInput(Buffer.from(text, "latin1"))).toString("latin1");
    expect(input(`a${ESC}]52;c;AAAA\u0007b`)).toBe("ab");
    expect(input(`${ESC}[?62;c`)).toBe("");
    expect(input(`${ESC}P1$r0m${ESC}\\`)).toBe("");
    expect(input(`${ESC}[A${ESC}[1;5C`)).toBe(`${ESC}[A${ESC}[1;5C`);
    expect(input(`${ESC}Phello`)).toBe(`${ESC}Phello`);
  });
});
