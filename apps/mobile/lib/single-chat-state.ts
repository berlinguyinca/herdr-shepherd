import type { Bot, RunActivityRow } from "@rakazo/contracts";
import { pickDefaultBot } from "./default-assistant";

/** What the single-chat home shows. */
export type SingleChatState =
  | { kind: "connecting" }
  | { kind: "offline"; retry: () => void }
  | { kind: "empty" }
  | { kind: "ready"; bot: Bot };

/** The outcome of the silent session open. `idle` means it was not needed or not started. */
export type OpenOutcome =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "ok" }
  | { kind: "failed"; reason: "network" | "refused" };

/** `auth` is a rejected session (401); anything else is unreachable or a server fault. */
export type FailureReason = "auth" | "other";

export type BotsOutcome =
  | { kind: "pending" }
  | { kind: "loaded"; bots: readonly Bot[]; runs?: readonly RunActivityRow[] }
  | { kind: "failed"; reason: FailureReason };

export type SingleChatInputs = {
  /** null until the saved session has been read. */
  hasSession: boolean | null;
  open: OpenOutcome;
  bots: BotsOutcome;
  retry: () => void;
};

/**
 * Derives the screen from what the glue has learned so far. A failed or refused open is offline,
 * never a sign-in form: the app has no sign-in in this mode.
 */
export function resolveSingleChat({
  hasSession,
  open,
  bots,
  retry,
}: SingleChatInputs): SingleChatState {
  if (hasSession === null) return { kind: "connecting" };
  if (open.kind === "failed" || bots.kind === "failed") return { kind: "offline", retry };
  if (bots.kind === "pending") return { kind: "connecting" };
  const bot = pickDefaultBot(bots.bots, bots.runs);
  return bot ? { kind: "ready", bot } : { kind: "empty" };
}

/**
 * Whether to open the owner session now: when none is saved, or when the saved one was refused,
 * which means it is stale. At most once per attempt, so a server that refuses both stays offline.
 */
export function shouldOpenSession(input: {
  hasSession: boolean;
  openedThisAttempt: boolean;
  lastFailure: FailureReason | null;
}): boolean {
  if (input.openedThisAttempt) return false;
  return !input.hasSession || input.lastFailure === "auth";
}
