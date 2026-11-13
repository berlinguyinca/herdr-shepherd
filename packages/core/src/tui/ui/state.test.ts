import { describe, expect, it } from "vitest";
import type { Press, SidebarItem, UiState } from "./state.js";
import {
  buildSidebar,
  hintsFor,
  initialState,
  itemKey,
  reduce,
  selectedItem,
  truncate,
} from "./state.js";

const row = (id: string, status: "blocked" | "working" | "idle", updated = "2026-01-01") => ({
  id,
  name: `Agent ${id}`,
  machine: null,
  status,
  summary: "",
  updated_at: updated,
  has_conversation: true,
});

const items: SidebarItem[] = buildSidebar(
  [row("a1", "idle"), row("a2", "blocked")],
  [{ id: "b1", name: "Helper" }],
);
const press = (input: string, extra: Partial<Press> = {}): Press => ({ input, ...extra });
const feed = (state: UiState, ...presses: Press[]) =>
  presses.reduce((s, p) => reduce(s, p, items).state, state);

describe("buildSidebar", () => {
  it("lists agents most urgent first, then bots", () => {
    expect(items.map(itemKey)).toEqual(["agent:a2", "agent:a1", "bot:b1"]);
    expect(items[0]).toMatchObject({ kind: "agent", status: "blocked", label: "Agent a2" });
  });
});

describe("truncate", () => {
  it("cuts to the width with an ellipsis and flattens whitespace", () => {
    expect(truncate("hello world", 8)).toBe("hello w…");
    expect(truncate("a\n\nb", 10)).toBe("a b");
    expect(truncate("x", 0)).toBe("");
  });
  it("strips terminal escape sequences", () => {
    expect(truncate("\u001b]52;c;AAAA\u0007hi", 10)).toBe("hi");
  });
});

describe("browse keys", () => {
  it("moves the selection by key and stops at both ends", () => {
    const s0 = initialState();
    expect(selectedItem(items, s0)).toBe(items[0]);
    const s1 = feed(s0, press("j"));
    expect(s1.selected).toBe("agent:a1");
    const end = feed(s1, press("", { down: true }), press("", { down: true }));
    expect(end.selected).toBe("bot:b1");
    expect(feed(s0, press("k")).selected).toBe("agent:a2");
  });

  it("Tab moves focus and arrows then scroll the main pane", () => {
    const s = feed(initialState(), press("", { tab: true }), press("", { up: true }));
    expect(s.focus).toBe("main");
    expect(s.scroll).toBe(1);
    expect(feed(s, press("", { down: true }), press("", { down: true })).scroll).toBe(0);
    expect(feed(s, press("", { escape: true })).focus).toBe("sidebar");
  });

  it("emits quit, refresh and attach effects", () => {
    expect(reduce(initialState(), press("q"), items).effect).toEqual({ kind: "quit" });
    expect(reduce(initialState(), press("c", { ctrl: true }), items).effect).toEqual({
      kind: "quit",
    });
    expect(reduce(initialState(), press("r"), items).effect).toEqual({ kind: "refresh" });
    expect(reduce(initialState(), press("a"), items).effect).toEqual({ kind: "attach", id: "a2" });
  });

  it("does not attach to a bot", () => {
    const s = feed(initialState(), press("j"), press("j"));
    expect(reduce(s, press("a"), items).effect).toBeUndefined();
  });

  it("c jumps to the first bot and opens the input", () => {
    const s = feed(initialState(), press("c"));
    expect(s).toMatchObject({ selected: "bot:b1", mode: "compose" });
  });

  it("? opens help and any key closes it", () => {
    const s = feed(initialState(), press("?"));
    expect(s.mode).toBe("help");
    expect(feed(s, press("x")).mode).toBe("browse");
  });
});

describe("compose and confirm", () => {
  it("sending to an agent needs a confirm step; Esc cancels", () => {
    let s = feed(initialState(), press("n"), ...[..."fix it"].map((c) => press(c)));
    expect(s).toMatchObject({ mode: "compose", draft: "fix it" });
    const step = reduce(s, press("", { enter: true }), items);
    expect(step.effect).toBeUndefined();
    expect(step.state).toMatchObject({ mode: "confirm", draft: "fix it" });
    s = step.state;
    expect(feed(s, press("", { escape: true }))).toMatchObject({ mode: "browse", draft: "" });
    const sent = reduce(s, press("", { enter: true }), items);
    expect(sent.effect).toEqual({ kind: "send", text: "fix it", to: items[0] });
    expect(sent.state).toMatchObject({ mode: "browse", draft: "" });
  });

  it("sending to a bot goes straight out", () => {
    const s = feed(initialState(), press("c"), press("h"), press("i"));
    const step = reduce(s, press("", { enter: true }), items);
    expect(step.effect).toEqual({ kind: "send", text: "hi", to: items[2] });
  });

  it("typed letters are text, not commands, and backspace edits", () => {
    const s = feed(
      initialState(),
      press("n"),
      press("q"),
      press("r"),
      press("", { backspace: true }),
    );
    expect(s).toMatchObject({ mode: "compose", draft: "q" });
  });

  it("drops escape sequences from pasted text and ignores empty input", () => {
    let s = feed(initialState(), press("n"), press("\u001b[31mok\u001b[0m\r\nnext"));
    expect(s.draft).toBe("ok next");
    s = feed(initialState(), press("n"), press("  "));
    expect(reduce(s, press("", { enter: true }), items).effect).toBeUndefined();
  });
});

describe("hintsFor", () => {
  it("only offers keys that apply", () => {
    expect(hintsFor(initialState(), items[0])).toContain("a attach");
    expect(hintsFor(initialState(), items[2])).not.toContain("a attach");
    expect(hintsFor({ ...initialState(), mode: "confirm" }, items[0])).toBe(
      "Enter confirm  Esc cancel",
    );
    expect(hintsFor({ ...initialState(), mode: "compose" }, items[0])).toBe(
      "Enter review  Esc cancel",
    );
    expect(hintsFor({ ...initialState(), mode: "compose" }, items[2])).toBe(
      "Enter send  Esc cancel",
    );
  });
});
