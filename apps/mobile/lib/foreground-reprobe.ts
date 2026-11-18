import type { AppStateStatus } from "react-native";

/**
 * Coming back to the app re-checks the connection once. Events that arrive while an attempt is
 * still running are ignored, so a flurry of `active` changes never starts a second open.
 */
export function reprobeOnActive({
  next,
  busy,
  retry,
}: {
  next: AppStateStatus;
  busy: { current: boolean };
  retry: () => void;
}): void {
  if (next !== "active" || busy.current) return;
  retry();
}
