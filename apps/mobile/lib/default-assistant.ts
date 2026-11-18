import type { Bot, RunActivityRow } from "@rakazo/contracts";

/** A real assistant: live, and not an agent-spawned (spawnKey) or child (parentBotId) bot. */
export function isAssistantBot(bot: Bot): boolean {
  return !bot.archivedAt && !bot.spawnKey && !bot.parentBotId;
}

function time(iso: string | undefined): number {
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * The live assistant bots. bots/list lists every named assistant, so a bot seen only in a run
 * (an offline agent) is not an assistant and is never added.
 */
export function assistantCandidates(bots: readonly Bot[]): Bot[] {
  return bots.filter(isAssistantBot);
}

/**
 * The assistant the app opens into: the one flagged default, else the one with the most recent
 * run activity, else the first assistant bot, else none (the empty state offers Create assistant).
 * Spawned, child and archived bots are never picked.
 */
export function pickDefaultBot(
  bots: readonly Bot[],
  runs: readonly RunActivityRow[] = [],
): Bot | null {
  const candidates = assistantCandidates(bots);
  const flagged = candidates.find((bot) => bot.isDefault);
  if (flagged) return flagged;
  const last = new Map<string, number>();
  for (const run of runs)
    last.set(run.botId, Math.max(last.get(run.botId) ?? 0, time(run.updatedAt)));
  let best: Bot | null = null;
  let bestAt = 0;
  for (const bot of candidates) {
    const at = Math.max(last.get(bot.id) ?? 0, time(bot.updatedAt));
    if (at > bestAt) {
      best = bot;
      bestAt = at;
    }
  }
  return best ?? candidates[0] ?? null;
}
