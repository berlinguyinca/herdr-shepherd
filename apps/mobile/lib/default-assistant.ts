import type { Bot } from "@rakazo/contracts";

/** The assistant the app opens into: the live bot flagged default, else the first live bot, else none. */
export function pickDefaultBot(bots: readonly Bot[]): Bot | null {
  const live = bots.filter((bot) => !bot.archivedAt);
  return live.find((bot) => bot.isDefault) ?? live[0] ?? null;
}
