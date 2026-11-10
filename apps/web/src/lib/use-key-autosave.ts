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
  /** Drops a pending edit and any run in flight; call when the form moves to another connection. */
  cancel: () => void;
};

const KEY_SAVE_DELAY_MS = 800;

/** A catalog provider's key shorter than this is treated as still being typed. */
export const MIN_AUTOSAVE_KEY_LENGTH = 8;

/** True when a change event came from pasting, which saves without the typing delay. */
export function isPasteChange(event: { nativeEvent: Event }): boolean {
  return (event.nativeEvent as Partial<InputEvent>).inputType === "insertFromPaste";
}

/**
 * Checks an API key shortly after the person stops editing it and saves it only if the check
 * passes, so a half-typed key never replaces a working saved one. The check is the model
 * lookup (`findModels` resolves true when the typed key worked); the draft stays either way.
 * Only an edit starts work, never a state change, so a save or lookup cannot trigger itself.
 * A newer edit drops the older run, and runs go one at a time in edit order.
 */
export function useKeyAutosave({
  save,
  findModels,
  delayMs = KEY_SAVE_DELAY_MS,
}: {
  save: (key: string) => Promise<KeyAutosaveOutcome>;
  findModels: () => Promise<boolean>;
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
      if (!mounted.current || mine !== revision.current) return;
      show("finding", mine);
      let verified = false;
      try {
        verified = await latest.current.findModels();
      } catch {
        // The lookup reports its own failure through the form's notice.
      }
      if (mine !== revision.current || !mounted.current) return;
      if (!verified) return show("idle", mine);
      // Let the form render what the lookup staged before the save reads it.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (mine !== revision.current || !mounted.current) return;
      show("saving", mine);
      let outcome: KeyAutosaveOutcome;
      try {
        outcome = await latest.current.save(key);
      } catch {
        outcome = "failed";
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

  function cancel() {
    clearTimer();
    revision.current += 1;
    pending.current = null;
    if (mounted.current) setStatus({ phase: "idle" });
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimer();
      pending.current = null;
    };
  }, []);

  return { status, onKeyChange, onKeyBlur, cancel };
}
