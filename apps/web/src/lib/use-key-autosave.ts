import { useEffect, useRef, useState } from "react";

/**
 * `skipped` means the form was not ready to save (the draft stays); `failed` means the save
 * reported its own error through the form's error line.
 */
export type KeyAutosaveOutcome = "saved" | "skipped" | "failed";

export type KeyAutosaveStatus = {
  phase: "idle" | "saving" | "saved" | "finding";
};

export type KeyAutosave = {
  status: KeyAutosaveStatus;
  /** Call from the key field's change handler; `immediate` saves without waiting (paste). */
  onKeyChange: (key: string, options?: { immediate?: boolean }) => void;
  /** Call from the key field's blur handler; saves a pending edit now. */
  onKeyBlur: () => void;
};

const KEY_SAVE_DELAY_MS = 800;

/** True when a change event came from pasting, which saves without the typing delay. */
export function isPasteChange(event: { nativeEvent: Event }): boolean {
  return (event.nativeEvent as Partial<InputEvent>).inputType === "insertFromPaste";
}

/**
 * Saves an API key shortly after the person stops editing it, then refreshes the model list.
 * Only an edit starts work, never a state change, so a save or refresh cannot trigger itself.
 * A newer edit drops the older run's refresh, and saves run one at a time in edit order.
 */
export function useKeyAutosave({
  save,
  findModels,
  delayMs = KEY_SAVE_DELAY_MS,
}: {
  save: (key: string) => Promise<KeyAutosaveOutcome>;
  findModels: () => Promise<void>;
  delayMs?: number;
}): KeyAutosave {
  const [status, setStatus] = useState<KeyAutosaveStatus>({ phase: "idle" });
  // Read at fire time so a run uses the form as it is then, not as it was at the keystroke.
  const latest = useRef({ save, findModels });
  latest.current = { save, findModels };
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revision = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);

  function clearTimer() {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }

  function show(next: KeyAutosaveStatus["phase"], mine: number) {
    if (mounted.current && mine === revision.current) setStatus({ phase: next });
  }

  function run() {
    clearTimer();
    const key = pending.current;
    pending.current = null;
    if (key === null) return;
    const mine = revision.current;
    queue.current = queue.current.then(async () => {
      if (!mounted.current) return;
      show("saving", mine);
      let outcome: KeyAutosaveOutcome;
      try {
        outcome = await latest.current.save(key);
      } catch {
        outcome = "failed";
      }
      if (mine !== revision.current || !mounted.current) return;
      if (outcome === "failed") return show("idle", mine);
      show(outcome === "saved" ? "saved" : "idle", mine);
      show("finding", mine);
      try {
        await latest.current.findModels();
      } catch {
        // The probe reports its own failure through the form's notice.
      }
      show(outcome === "saved" ? "saved" : "idle", mine);
    });
  }

  function onKeyChange(key: string, options?: { immediate?: boolean }) {
    clearTimer();
    revision.current += 1;
    if (!key.trim()) {
      pending.current = null;
      setStatus({ phase: "idle" });
      return;
    }
    pending.current = key;
    setStatus({ phase: "idle" });
    // Even an immediate save waits a tick, so the form has rendered the key it will save.
    timer.current = setTimeout(run, options?.immediate ? 0 : delayMs);
  }

  function onKeyBlur() {
    if (pending.current !== null) run();
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimer();
      pending.current = null;
    };
  }, []);

  return { status, onKeyChange, onKeyBlur };
}
