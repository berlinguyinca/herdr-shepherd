import type { Bot } from "@rakazo/contracts";
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

export type BotsOutcome =
  | { kind: "pending" }
  | { kind: "loaded"; bots: readonly Bot[] }
  | { kind: "failed" };

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
  const bot = pickDefaultBot(bots.bots);
  return bot ? { kind: "ready", bot } : { kind: "empty" };
}
