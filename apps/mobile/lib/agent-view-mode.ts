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
          JSON.stringify({ ...all, [agentId]: mode }),
        );
      });
    writing = next.catch(() => undefined);
    return next;
  },
};

/** The agent screen's view and a setter that remembers the choice for that agent. */
export function useViewMode(
  agentId: string,
  status: string | undefined,
): [ViewMode, (mode: ViewMode) => void] {
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
  const stored = choice?.agentId === agentId ? choice.mode : null;
  const mode = store.current?.resolve(agentId, stored, status) ?? "chat";
  const set = useCallback(
    (next: ViewMode) => {
      setChoice({ agentId, mode: next });
      void store.current?.save(agentId, next);
    },
    [agentId],
  );
  return [mode, set];
}
