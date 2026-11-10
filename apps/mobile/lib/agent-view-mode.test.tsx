// @vitest-environment jsdom
import { MAX_FONT_SCALE } from "@rakazo/ui-tokens";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewMode } from "./agent-view-mode";
import {
  AGENT_VIEW_MODES_KEY,
  createViewModeStore,
  defaultViewMode,
  MAX_REMEMBERED_AGENTS,
  modeSwitchWidth,
  rememberMode,
  terminalKeyboardOffset,
  useViewMode,
  viewModeLocked,
} from "./agent-view-mode";

const store = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (key: string) => store.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
  }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const memory = () => {
  const modes = new Map<string, ViewMode>();
  return {
    modes,
    read: vi.fn(async (id: string) => modes.get(id) ?? null),
    write: vi.fn(async (id: string, mode: ViewMode) => void modes.set(id, mode)),
  };
};

describe("defaultViewMode", () => {
  it.each([
    ["blocked", "terminal"],
    ["done", "chat"],
    ["working", "chat"],
    ["idle", "chat"],
    ["unknown", "chat"],
    ["closed", "chat"],
    ["something-new", "chat"],
    [undefined, "chat"],
  ] as const)("%s opens %s", (status, mode) => {
    expect(defaultViewMode(status)).toBe(mode);
  });
});

describe("viewModeLocked", () => {
  it("is true only for an agent with no live pane", () => {
    expect(viewModeLocked("closed")).toBe(true);
    expect(viewModeLocked("blocked")).toBe(false);
    expect(viewModeLocked("working")).toBe(false);
  });
});

describe("terminalKeyboardOffset", () => {
  it("is where the terminal sits in the window once measured, else the header inset", () => {
    expect(terminalKeyboardOffset(150, 96)).toBe(150);
    expect(terminalKeyboardOffset(0, 96)).toBe(0);
    expect(terminalKeyboardOffset(undefined, 96)).toBe(96);
    expect(terminalKeyboardOffset(Number.NaN, 96)).toBe(96);
  });
});

describe("rememberMode", () => {
  it("keeps only the most recently set agents", () => {
    let all: Record<string, unknown> = {};
    for (let i = 0; i < MAX_REMEMBERED_AGENTS + 10; i++) all = rememberMode(all, `a${i}`, "chat");
    expect(Object.keys(all)).toHaveLength(MAX_REMEMBERED_AGENTS);
    expect(all.a0).toBeUndefined();
    expect(all[`a${MAX_REMEMBERED_AGENTS + 9}`]).toBe("chat");
  });

  it("setting an agent again makes it the newest, and replaces its value", () => {
    let all: Record<string, unknown> = {};
    for (let i = 0; i < MAX_REMEMBERED_AGENTS; i++) all = rememberMode(all, `a${i}`, "chat");
    all = rememberMode(all, "a0", "terminal");
    all = rememberMode(all, "new", "chat");
    expect(all.a0).toBe("terminal");
    expect(all.a1).toBeUndefined();
  });

  it("drops entries that are not modes", () => {
    expect(rememberMode({ x: "banana", y: "chat" }, "z", "terminal")).toEqual({
      y: "chat",
      z: "terminal",
    });
  });
});

describe("modeSwitchWidth", () => {
  it("is the base width at normal text and grows with large text", () => {
    expect(modeSwitchWidth(1, 800)).toBe(180);
    expect(modeSwitchWidth(1.2, 800)).toBe(216);
    expect(modeSwitchWidth(0.8, 800)).toBe(180);
  });

  it("stops at the largest supported font scale and at the room there is", () => {
    expect(modeSwitchWidth(10, 2000)).toBe(Math.ceil(180 * MAX_FONT_SCALE));
    expect(modeSwitchWidth(10, 2000)).toBe(modeSwitchWidth(MAX_FONT_SCALE, 2000));
    expect(modeSwitchWidth(2, 220)).toBe(220);
    expect(modeSwitchWidth(1, 120)).toBe(120);
  });

  it("is never less than something that can be tapped when the room is unknown", () => {
    expect(modeSwitchWidth(1, Number.NaN)).toBe(180);
    expect(modeSwitchWidth(Number.NaN, 800)).toBe(180);
  });
});

describe("view mode store", () => {
  it("a remembered choice overrides the default", async () => {
    const storage = memory();
    storage.modes.set("a1", "chat");
    const modes = createViewModeStore(storage);
    expect(await modes.load("a1")).toBe("chat");
    expect(modes.resolve("a1", "chat", "blocked")).toBe("chat");
  });

  it("follows the default when nothing is remembered, and computes it once per agent", () => {
    const modes = createViewModeStore(memory());
    expect(modes.resolve("a1", null, "blocked")).toBe("terminal");
    expect(modes.resolve("a1", null, "working")).toBe("terminal");
    expect(modes.resolve("a2", null, "working")).toBe("chat");
  });

  it("keeps agents apart when saving", async () => {
    const storage = memory();
    const modes = createViewModeStore(storage);
    await modes.save("a1", "terminal");
    expect(await modes.load("a1")).toBe("terminal");
    expect(await modes.load("a2")).toBeNull();
  });

  it("falls back silently when reading or writing fails", async () => {
    const modes = createViewModeStore({
      read: async () => {
        throw new Error("locked");
      },
      write: async () => {
        throw new Error("locked");
      },
    });
    expect(await modes.load("a1")).toBeNull();
    await expect(modes.save("a1", "chat")).resolves.toBeUndefined();
  });

  it("ignores a stored value that is not a mode", async () => {
    const modes = createViewModeStore({
      read: async () => "banana" as never,
      write: async () => {},
    });
    expect(await modes.load("a1")).toBeNull();
  });
});

describe("useViewMode", () => {
  beforeEach(() => store.clear());

  function mount(initial: { id: string; status: string | undefined }) {
    const host = document.createElement("div");
    const root = createRoot(host);
    const seen: { mode: ViewMode; set: (m: ViewMode) => void } = {
      mode: "chat",
      set: () => {},
    };
    const Probe = ({ id, status }: { id: string; status: string | undefined }) => {
      const [mode, set] = useViewMode(id, status);
      seen.mode = mode;
      seen.set = set;
      return null;
    };
    const render = async (props: { id: string; status: string | undefined }) => {
      await act(async () => root.render(<Probe {...props} />));
    };
    return { seen, render, initial };
  }

  it("does not flip when the status changes after the first view", async () => {
    const view = mount({ id: "a1", status: "blocked" });
    await view.render({ id: "a1", status: "blocked" });
    expect(view.seen.mode).toBe("terminal");
    await view.render({ id: "a1", status: "working" });
    expect(view.seen.mode).toBe("terminal");
  });

  it("waits for a status before it picks the default", async () => {
    const view = mount({ id: "a1", status: undefined });
    await view.render({ id: "a1", status: undefined });
    expect(view.seen.mode).toBe("chat");
    await view.render({ id: "a1", status: "blocked" });
    expect(view.seen.mode).toBe("terminal");
  });

  it("remembers an explicit choice across mounts", async () => {
    const first = mount({ id: "a1", status: "blocked" });
    await first.render({ id: "a1", status: "blocked" });
    await act(async () => first.seen.set("chat"));
    expect(JSON.parse(store.get(AGENT_VIEW_MODES_KEY) ?? "{}")).toEqual({ a1: "chat" });
    const second = mount({ id: "a1", status: "blocked" });
    await second.render({ id: "a1", status: "blocked" });
    expect(second.seen.mode).toBe("chat");
  });

  it("a closed agent shows chat whatever was remembered", async () => {
    store.set(AGENT_VIEW_MODES_KEY, JSON.stringify({ a1: "terminal" }));
    const view = mount({ id: "a1", status: "closed" });
    await view.render({ id: "a1", status: "closed" });
    expect(view.seen.mode).toBe("chat");
  });

  it("a session that ends while in Terminal stays there to show Session ended", async () => {
    const view = mount({ id: "a1", status: "blocked" });
    await view.render({ id: "a1", status: "blocked" });
    await view.render({ id: "a1", status: "closed" });
    expect(view.seen.mode).toBe("terminal");
  });

  it("reports loading until the stored choice has been read, and shows no terminal meanwhile", async () => {
    store.set(AGENT_VIEW_MODES_KEY, JSON.stringify({ a1: "chat" }));
    const host = document.createElement("div");
    const root = createRoot(host);
    const seen: Array<[ViewMode, boolean]> = [];
    const Probe = () => {
      const [mode, , loading] = useViewMode("a1", "blocked");
      seen.push([mode, loading]);
      return null;
    };
    await act(async () => root.render(<Probe />));
    expect(seen[0]).toEqual(["chat", true]);
    expect(seen.at(-1)).toEqual(["chat", false]);
    expect(seen.some(([mode]) => mode === "terminal")).toBe(false);
  });

  it("a blocked agent with nothing stored opens in Terminal once loaded", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    const seen: Array<[ViewMode, boolean]> = [];
    const Probe = () => {
      const [mode, , loading] = useViewMode("a1", "blocked");
      seen.push([mode, loading]);
      return null;
    };
    await act(async () => root.render(<Probe />));
    expect(seen[0]).toEqual(["chat", true]);
    expect(seen.at(-1)).toEqual(["terminal", false]);
  });
});
