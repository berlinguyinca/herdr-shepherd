import { MAX_FONT_SCALE } from "@rakazo/ui-tokens";
import * as SecureStore from "expo-secure-store";
import { useCallback, useEffect, useRef, useState } from "react";

export type ViewMode = "chat" | "terminal";

/** Each agent's explicit Chat or Terminal choice, as one JSON map. */
export const AGENT_VIEW_MODES_KEY = "rakazo.agent-view-modes";

const isMode = (value: unknown): value is ViewMode => value === "chat" || value === "terminal";

/** Terminal when the agent waits on a prompt, otherwise the conversation. */
export function defaultViewMode(status: string | undefined): ViewMode {
  return status === "blocked" ? "terminal" : "chat";
}

/** A closed agent has no live pane to attach to, so only Chat is on offer. */
export function viewModeLocked(status: string | undefined): boolean {
  return status === "closed";
}

/** Only this many agents' choices are kept; the least recently set go first. */
export const MAX_REMEMBERED_AGENTS = 50;

/** The remembered map with one choice set: newest last, bounded, entries that are no mode gone. */
export function rememberMode(
  all: Record<string, unknown>,
  agentId: string,
  mode: ViewMode,
): Record<string, ViewMode> {
  const kept = Object.entries(all).filter(
    (entry): entry is [string, ViewMode] => entry[0] !== agentId && isMode(entry[1]),
  );
  return Object.fromEntries([...kept, [agentId, mode]].slice(-MAX_REMEMBERED_AGENTS));
}

const SWITCH_WIDTH = 180;

/**
 * The Chat | Terminal control's width: wide enough for its labels at the user's text size, never
 * more than the room there is. An unknown scale or room falls back to the base width.
 */
export function modeSwitchWidth(fontScale: number, available: number): number {
  const scale = Number.isFinite(fontScale) ? Math.min(MAX_FONT_SCALE, Math.max(1, fontScale)) : 1;
  const wanted = Math.ceil(SWITCH_WIDTH * scale);
  return Number.isFinite(available) && available > 0 ? Math.min(wanted, available) : wanted;
}

/** Where the terminal starts in the window; the keyboard must also clear that much. */
export function terminalKeyboardOffset(measuredY: number | undefined, headerInset: number): number {
  return measuredY !== undefined && Number.isFinite(measuredY) ? measuredY : headerInset;
}

export type ViewModeStorage = {
  read(agentId: string): Promise<ViewMode | null>;
  write(agentId: string, mode: ViewMode): Promise<void>;
};

/**
 * Remembered choices behind a small async store, plus the smart default, which is computed once
 * per agent so a status change never flips the view under the user. Storage failures read as
 * "nothing remembered" and writes are dropped.
 */
export function createViewModeStore(storage: ViewModeStorage) {
  const defaults = new Map<string, ViewMode>();
  const lockedAtEntry = new Map<string, boolean>();
  return {
    async load(agentId: string): Promise<ViewMode | null> {
      try {
        const mode = await storage.read(agentId);
        return isMode(mode) ? mode : null;
      } catch {
        return null;
      }
    },
    async save(agentId: string, mode: ViewMode): Promise<void> {
      try {
        await storage.write(agentId, mode);
      } catch {
        // The choice still holds for this visit.
      }
    },
    /**
     * The remembered choice, else the default; that waits for a status and then sticks. An agent
     * with no live pane when first shown opens in Chat; one that closes while in Terminal stays
     * there, so its "Session ended" is seen.
     */
    resolve(agentId: string, stored: ViewMode | null, status: string | undefined): ViewMode {
      if (status !== undefined && !lockedAtEntry.has(agentId)) {
        lockedAtEntry.set(agentId, viewModeLocked(status));
      }
      if (lockedAtEntry.get(agentId)) return "chat";
      if (stored) return stored;
      const known = defaults.get(agentId);
      if (known) return known;
      if (status === undefined) return "chat";
      const mode = defaultViewMode(status);
      defaults.set(agentId, mode);
      return mode;
    },
  };
}

async function readAll(): Promise<Record<string, unknown>> {
  const parsed = JSON.parse((await SecureStore.getItemAsync(AGENT_VIEW_MODES_KEY)) ?? "{}");
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
}

let writing: Promise<unknown> = Promise.resolve();

const secureStorage: ViewModeStorage = {
  async read(agentId) {
    await writing;
    const mode = (await readAll())[agentId];
    return isMode(mode) ? mode : null;
  },
  /** One at a time, so concurrent choices for different agents do not drop each other. */
  write(agentId, mode) {
    const next = writing
      .catch(() => undefined)
      .then(async () => {
        const all = await readAll().catch(() => ({}));
        await SecureStore.setItemAsync(
          AGENT_VIEW_MODES_KEY,
          JSON.stringify(rememberMode(all, agentId, mode)),
        );
      });
    writing = next.catch(() => undefined);
    return next;
  },
};

/**
 * The agent screen's view, a setter that remembers the choice for that agent, and whether the
 * stored choice is still being read.
 */
export function useViewMode(
  agentId: string,
  status: string | undefined,
): [ViewMode, (mode: ViewMode) => void, boolean] {
  const store = useRef<ReturnType<typeof createViewModeStore>>(null);
  store.current ??= createViewModeStore(secureStorage);
  const [choice, setChoice] = useState<{ agentId: string; mode: ViewMode | null } | null>(null);
  useEffect(() => {
    let current = true;
    void store.current?.load(agentId).then((mode) => {
      // A choice made while this was loading wins over what was stored.
      if (current)
        setChoice((was) => (was?.agentId === agentId && was.mode ? was : { agentId, mode }));
    });
    return () => {
      current = false;
    };
  }, [agentId]);
  // Until the stored choice is read nothing is decided: Chat, with no default taken yet.
  const loading = choice?.agentId !== agentId;
  const stored = choice?.agentId === agentId ? choice.mode : null;
  const mode = loading ? "chat" : (store.current?.resolve(agentId, stored, status) ?? "chat");
  const set = useCallback(
    (next: ViewMode) => {
      setChoice({ agentId, mode: next });
      void store.current?.save(agentId, next);
    },
    [agentId],
  );
  return [mode, set, loading];
}
