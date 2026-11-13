import { setTimeout as sleep } from "node:timers/promises";
import { cleanup, render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTuiClient } from "../rpc.js";
import { fromBase64 } from "../terminal-io.js";
import { FixtureServer } from "../test-fixture.js";
import { App } from "./app.js";

const agentRow = (id: string, status: string, summary = "") => ({
  id,
  name: `Agent ${id}`,
  machine: "box",
  status,
  summary,
  updated_at: "2026-01-01T00:00:00Z",
  has_conversation: true,
});

const agentEvent = (seq: number, text: string) => ({
  seq,
  rev: seq,
  kind: "message",
  agent_id: "a1",
  parent_agent_id: null,
  ts: "2026-01-01T00:00:00Z",
  sensitive: false,
  redacted: false,
  truncated: false,
  size: text.length,
  data: { text },
});

const botMessage = (id: string, role: "user" | "bot", text: string) => ({
  id,
  threadId: "t1",
  seq: 1,
  role,
  blocks: [{ kind: "text", text }],
  createdAt: "2026-01-01T00:00:00Z",
});

let fixture: FixtureServer;
let aborted: () => boolean;

beforeEach(async () => {
  fixture = new FixtureServer();
  await fixture.start();
  fixture.json.set("agents/list", () => ({
    agents: [agentRow("a1", "working", "building"), agentRow("a2", "blocked")],
    hiddenCount: 0,
    cursor: 5,
  }));
  fixture.json.set("agents/messages", () => ({
    events: [agentEvent(2, "second thing"), agentEvent(1, "first thing")],
    hasMore: false,
    newestSeq: 2,
    rev: 2,
  }));
  fixture.json.set("bots/list", () => [{ id: "b1", name: "Helper" }]);
  fixture.json.set("threads/get", () => ({
    threadId: "t1",
    cursor: 3,
    messages: [botMessage("m1", "user", "hello bot"), botMessage("m2", "bot", "hello human")],
    olderCursor: null,
    run: null,
  }));
  fixture.json.set("threads/send", () => ({ ok: true }));
  fixture.json.set("terminal/open", () => ({ terminalId: "term1", seq: 1, rows: 24, cols: 80 }));
  fixture.json.set("terminal/input", () => ({ ok: true }));
  fixture.json.set("terminal/close", () => ({ ok: true }));
  for (const route of ["agents/subscribeList", "agents/subscribe", "threads/subscribe"]) {
    fixture.onStream.set(route, () => undefined);
  }
  // A client that hangs up leaves the server's response with a dead socket; `closed` is not always set.
  aborted = () =>
    (fixture.streams.get("agents/subscribeList") ?? []).every(
      (res) => res.destroyed || res.closed || !res.socket || res.socket.destroyed,
    );
});

afterEach(async () => {
  cleanup();
  await fixture.stop();
});

function start() {
  const client = createTuiClient({ url: fixture.origin, token: "tok-fixture-not-real" });
  const view = render(<App client={client} onAttach={async () => undefined} />);
  const type = async (text: string) => {
    for (const char of text) {
      view.stdin.write(char);
      await sleep(8);
    }
  };
  const screen = () => view.lastFrame() ?? "";
  const waitFor = async (check: (frame: string) => boolean, what: string) => {
    for (let n = 0; n < 500; n++) {
      if (check(screen())) return;
      await sleep(20);
    }
    throw new Error(`Timed out waiting for ${what}. Screen:\n${screen()}`);
  };
  const see = (text: string) => waitFor((frame) => frame.includes(text), `"${text}"`);
  return { view, type, screen, see };
}

const calls = (route: string) => fixture.seen.filter((seen) => seen.url === `/rpc/${route}`);

describe("full-screen view", () => {
  it("lists agents and bots in the sidebar, most urgent agent first", async () => {
    const { screen, see } = start();
    await see("Helper");
    const frame = screen();
    expect(frame).toContain("AGENTS");
    expect(frame).toContain("BOTS");
    expect(frame.indexOf("Agent a2")).toBeLessThan(frame.indexOf("Agent a1"));
    expect(frame).toContain("Enter write");
  });

  it("shows the selected agent's history and follows live events, ignoring keep-alives", async () => {
    const { type, screen, see } = start();
    await see("Agent a1");
    await type("j");
    await see("first thing");
    expect(screen().indexOf("first thing")).toBeLessThan(screen().indexOf("second thing"));
    await sleep(100);
    fixture.emit("agents/subscribe", { type: "heartbeat" });
    fixture.emit("agents/subscribe", { seq: 3, event: agentEvent(3, "live news") });
    await see("live news");
    expect(screen()).not.toContain("heartbeat");
  });

  it("shows a bot thread and sends a chat message without a confirm step", async () => {
    const { view, type, see, screen } = start();
    await see("Helper");
    await type("c");
    await see("hello human");
    expect(screen()).toContain("› hello bot");
    await type("hi there");
    view.stdin.write("\r");
    await until(() => calls("threads/send").length === 1);
    expect(calls("threads/send")[0]?.body).toMatchObject({
      json: { botId: "b1", text: "hi there" },
    });
    fixture.emit("threads/subscribe", { type: "heartbeat" });
    fixture.emit("threads/subscribe", {
      id: "ev9",
      spaceId: "s",
      threadId: "t1",
      botId: "b1",
      seq: 4,
      type: "thread.message.created",
      createdAt: "2026-01-01T00:00:00Z",
      payload: { role: "bot", blocks: [{ kind: "text", text: "live reply" }] },
    });
    await see("live reply");
  });

  it("types into an agent only after an explicit confirm", async () => {
    const { view, type, see } = start();
    await see("Agent a2");
    await type("n");
    await type("run the tests");
    view.stdin.write("\r");
    await see("Send to Agent a2: run the tests");
    expect(calls("terminal/open")).toHaveLength(0);
    view.stdin.write("\r");
    await until(() => calls("terminal/close").length === 1);
    expect(calls("terminal/open")[0]?.body).toMatchObject({ json: { id: "a2" } });
    const input = calls("terminal/input")[0]?.body as { json: { data: string; n: number } };
    expect(new TextDecoder().decode(fromBase64(input.json.data))).toBe("run the tests\r");
    expect(input.json.n).toBe(1);
    await see("Sent to Agent a2");
  });

  it("sends nothing when the confirm step is cancelled", async () => {
    const { view, type, see } = start();
    await see("Agent a2");
    await type("n");
    await type("rm -rf nothing");
    view.stdin.write("\r");
    await see("Send to Agent a2");
    view.stdin.write("\u001b");
    await see("Enter write");
    await sleep(100);
    expect(calls("terminal/open")).toHaveLength(0);
    expect(calls("terminal/input")).toHaveLength(0);
  });

  it("shows the key help and then the list again", async () => {
    const { type, see, screen } = start();
    await see("Agent a2");
    await type("?");
    await see("attach to the selected agent");
    await type("x");
    await see("Enter write");
    expect(screen()).not.toContain("attach to the selected agent");
  });

  it("shows a refused sign-in in the status line instead of crashing", async () => {
    fixture.json.set(
      "agents/list",
      () =>
        new Response(
          JSON.stringify({
            json: { defined: false, code: "UNAUTHORIZED", status: 401, message: "no", data: {} },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    );
    const { see } = start();
    await see("not signed in or not allowed");
  });

  it("quits on q and closes its streams", async () => {
    const { type, see } = start();
    await see("Agent a2");
    await until(() => (fixture.streams.get("agents/subscribeList") ?? []).length > 0);
    await type("q");
    await until(aborted);
  });
});

async function until(check: () => boolean): Promise<void> {
  for (let n = 0; n < 500; n++) {
    if (check()) return;
    await sleep(20);
  }
  throw new Error("Timed out");
}
