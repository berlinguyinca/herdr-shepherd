import type { AgentRow } from "@rakazo/contracts";
import { oneLine, sanitize, sortAgents } from "../render.js";

export type SidebarItem =
  | { kind: "room"; id: string; label: string }
  | { kind: "agent"; id: string; label: string; status: AgentRow["status"] }
  | { kind: "bot"; id: string; label: string };

export type Mode = "browse" | "compose" | "confirm" | "help";
export type Focus = "sidebar" | "main";

export type UiState = {
  /** Key of the selected item, so a reordered list keeps the same row selected. */
  selected: string | undefined;
  focus: Focus;
  mode: Mode;
  /** Text being typed; in confirm mode, the exact text that will be sent. */
  draft: string;
  /** What the typed text is for: a message, or the answer to a room's open question. */
  answering: boolean;
  /** Lines scrolled up from the newest. */
  scroll: number;
};

export type Press = {
  input: string;
  up?: boolean;
  down?: boolean;
  tab?: boolean;
  enter?: boolean;
  escape?: boolean;
  backspace?: boolean;
  ctrl?: boolean;
};

export type Effect =
  | { kind: "quit" }
  | { kind: "refresh" }
  | { kind: "attach"; id: string }
  | { kind: "send"; text: string; to: SidebarItem }
  | { kind: "answer"; text: string; to: SidebarItem };

export type Step = { state: UiState; effect?: Effect };

export const itemKey = (item: SidebarItem): string => `${item.kind}:${item.id}`;

export const initialState = (): UiState => ({
  selected: undefined,
  focus: "sidebar",
  mode: "browse",
  draft: "",
  answering: false,
  scroll: 0,
});

/** Rooms, then agents most urgent first, then bots. The bridge also lists every agent as a bot; those are left out. */
export function buildSidebar(
  rooms: readonly { id: string; name: string }[],
  agents: Iterable<AgentRow>,
  bots: readonly { id: string; name: string }[],
): SidebarItem[] {
  const rows = sortAgents(agents);
  const agentIds = new Set(rows.map((row) => row.id));
  return [
    ...rooms.map((room): SidebarItem => ({ kind: "room", id: room.id, label: room.name })),
    ...rows.map(
      (row): SidebarItem => ({ kind: "agent", id: row.id, label: row.name, status: row.status }),
    ),
    ...bots
      .filter((bot) => !agentIds.has(bot.id))
      .map((bot): SidebarItem => ({ kind: "bot", id: bot.id, label: bot.name })),
  ];
}

export const selectedItem = (
  items: readonly SidebarItem[],
  state: UiState,
): SidebarItem | undefined => items.find((item) => itemKey(item) === state.selected) ?? items[0];

/** Single line, no terminal control sequences, at most `width` columns. */
export const truncate = (text: string, width: number): string =>
  width <= 0 ? "" : oneLine(text, width);

const idle = (state: UiState): UiState => ({
  ...state,
  mode: "browse",
  draft: "",
  answering: false,
});

function move(state: UiState, items: readonly SidebarItem[], delta: number): UiState {
  const current = items.indexOf(selectedItem(items, state) as SidebarItem);
  const next = items[Math.min(items.length - 1, Math.max(0, current + delta))];
  return next ? { ...state, selected: itemKey(next), scroll: 0 } : state;
}

function browse(state: UiState, press: Press, items: readonly SidebarItem[]): Step {
  const item = selectedItem(items, state);
  const down = press.down || press.input === "j";
  const up = press.up || press.input === "k";
  if (up || down) {
    if (state.focus === "main") {
      return { state: { ...state, scroll: Math.max(0, state.scroll + (up ? 1 : -1)) } };
    }
    return { state: move(state, items, up ? -1 : 1) };
  }
  if (press.tab)
    return { state: { ...state, focus: state.focus === "sidebar" ? "main" : "sidebar" } };
  if (press.escape) return { state: { ...state, focus: "sidebar" } };
  if ((press.enter || press.input === "n") && item) {
    return { state: { ...state, mode: "compose", draft: "", answering: false } };
  }
  if (press.input === "a" && item?.kind === "room") {
    return { state: { ...state, mode: "compose", draft: "", answering: true } };
  }
  if (press.input === "a" && item?.kind === "agent")
    return { state, effect: { kind: "attach", id: item.id } };
  if (press.input === "c") {
    const bot = items.find((candidate) => candidate.kind === "bot");
    if (bot)
      return {
        state: {
          ...state,
          selected: itemKey(bot),
          scroll: 0,
          mode: "compose",
          draft: "",
          answering: false,
        },
      };
  }
  if (press.input === "r") return { state, effect: { kind: "refresh" } };
  if (press.input === "?") return { state: { ...state, mode: "help" } };
  if (press.input === "q") return { state, effect: { kind: "quit" } };
  return { state };
}

function compose(state: UiState, press: Press, item: SidebarItem | undefined): Step {
  if (press.escape) return { state: idle(state) };
  if (press.enter) {
    const text = state.draft.trim();
    if (!text || !item) return { state };
    // Text typed into a live agent is only sent after a second, explicit Enter.
    if (item.kind === "agent") return { state: { ...state, mode: "confirm", draft: text } };
    const kind = state.answering ? "answer" : "send";
    return { state: idle(state), effect: { kind, text, to: item } };
  }
  if (press.backspace) return { state: { ...state, draft: state.draft.slice(0, -1) } };
  if (press.ctrl || press.tab || press.up || press.down || !press.input) return { state };
  const typed = sanitize(press.input).replace(/\s+/g, " ");
  return { state: { ...state, draft: state.draft + typed } };
}

/** Pure key handling: next state plus at most one thing for the caller to do. */
export function reduce(state: UiState, press: Press, items: readonly SidebarItem[]): Step {
  if (press.ctrl && press.input === "c") return { state, effect: { kind: "quit" } };
  const item = selectedItem(items, state);
  switch (state.mode) {
    case "help":
      return { state: { ...state, mode: "browse" } };
    case "confirm":
      if (press.enter && item) {
        return { state: idle(state), effect: { kind: "send", text: state.draft, to: item } };
      }
      return { state: press.escape ? idle(state) : state };
    case "compose":
      return compose(state, press, item);
    case "browse":
      return browse(state, press, items);
  }
}

/** Only the keys that do something right now. */
export function hintsFor(state: UiState, item: SidebarItem | undefined): string {
  if (state.mode === "confirm") return "Enter confirm  Esc cancel";
  if (state.mode === "compose") {
    const enter = item?.kind === "agent" ? "review" : state.answering ? "answer" : "send";
    return `Enter ${enter}  Esc cancel`;
  }
  if (state.mode === "help") return "any key closes";
  const keys = ["↑↓ move", "Tab pane"];
  if (item) keys.push("Enter write");
  if (item?.kind === "agent") keys.push("a attach");
  if (item?.kind === "room") keys.push("a answer");
  keys.push("c chat", "r refresh", "? help", "q quit");
  return keys.join("  ");
}
