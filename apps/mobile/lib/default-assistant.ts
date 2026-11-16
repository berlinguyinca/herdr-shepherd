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
 * A minimal Bot for one known only from a run: the thread route needs just its id and name, so
 * every other required field gets a safe, inert default (never default, archived or spawned).
 */
function runOnlyBot(run: RunActivityRow): Bot {
  return {
    id: run.botId,
    spaceId: "",
    name: run.botName,
    title: "",
    description: "",
    instructions: "",
    color: "",
    notifyOnFinish: false,
    pinned: false,
    sectionId: null,
    archivedAt: null,
    unread: false,
    parentBotId: null,
    memoryScope: null,
    threadId: run.threadId,
    preview: "",
    status: "",
    runErrorId: null,
    computerMode: "team",
    updatedAt: run.updatedAt,
    createdAt: run.updatedAt,
    voiceId: null,
    autoSpeak: false,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    teamChatAmbientEnabled: false,
    teamChatRules: "",
    fleetManagement: false,
    isDefault: false,
    disabledBuiltinTools: [],
    webhookConfigured: false,
    spawnKey: null,
  };
}

/**
 * Assistant bots plus bots known only from recent runs (e.g. one absent from bots/list), by botId.
 * A run-only bot is a minimal Bot: the thread route needs just its id and name.
 */
export function assistantCandidates(
  bots: readonly Bot[],
  runs: readonly RunActivityRow[] = [],
): Bot[] {
  const out = bots.filter(isAssistantBot);
  const known = new Set(bots.map((b) => b.id));
  for (const run of runs) {
    if (known.has(run.botId)) continue;
    known.add(run.botId);
    out.push(runOnlyBot(run));
  }
  return out;
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
  const candidates = assistantCandidates(bots, runs);
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
