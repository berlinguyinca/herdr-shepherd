import type { Bot, ModelCatalogEntry, ModelCredential, ThinkingLevel } from "@rakazo/contracts";
import type { ChatModelChoice } from "@rakazo/core";
import {
  chatModelChoices,
  connectedModelChoices,
  credentialForModel,
  modelOptionKey,
  parseModelOptionKey,
  resolveSelectableModelId,
} from "@rakazo/core";

type BotModelFields = Pick<Bot, "modelProvider" | "modelId" | "thinkingLevel">;

export type ComposerModelInput = {
  bot: BotModelFields;
  me: { defaultProvider?: string | null; defaultModel?: string | null } | null;
  credentials: readonly ModelCredential[];
  catalog: readonly ModelCatalogEntry[];
  /** The first option's label, which clears the bot's own model. */
  defaultLabel: string;
};

export type ComposerModelState = {
  /** Nothing is configured to run: the chip offers to connect a model instead. */
  connected: boolean;
  /** Configured-provider models only, the default option first. */
  choices: ChatModelChoice[];
  /** The bot's own model key; empty when it follows the default. */
  selectedKey: string;
  /** The model the next run uses, named for the chip. */
  chipLabel: string | null;
  /** True when no bot override is set and the chip shows the main model. */
  usingDefault: boolean;
};

function choiceName(choice: ChatModelChoice): string {
  return choice.modelLabel ?? choice.title ?? choice.label;
}

/** What the composer's model chip shows and offers, from the same sources as the bot panel. */
export function composerModelState(input: ComposerModelInput): ComposerModelState {
  const { bot, me, credentials, catalog, defaultLabel } = input;
  const connectedOptions = connectedModelChoices(credentials, catalog);
  const selectedKey =
    bot.modelProvider && bot.modelId ? modelOptionKey(bot.modelProvider, bot.modelId) : "";
  const defaultEntry = me?.defaultModel
    ? catalog.find((entry) => entry.provider === me.defaultProvider && entry.id === me.defaultModel)
    : undefined;
  const choices = chatModelChoices(
    connectedOptions,
    selectedKey,
    defaultLabel,
    defaultEntry?.images,
  );
  const connected = connectedOptions.length > 0;
  if (selectedKey) {
    const own = choices.find((choice) => choice.key === selectedKey);
    return {
      connected,
      choices,
      selectedKey,
      chipLabel: own ? choiceName(own) : selectedKey,
      usingDefault: false,
    };
  }
  let chipLabel: string | null = null;
  if (me?.defaultProvider && me.defaultModel) {
    const key = modelOptionKey(
      me.defaultProvider,
      resolveSelectableModelId(catalog, me.defaultProvider, me.defaultModel),
    );
    const match = connectedOptions.find((choice) => choice.key === key);
    chipLabel = match ? choiceName(match) : (defaultEntry?.label ?? me.defaultModel);
  }
  return { connected, choices, selectedKey: "", chipLabel, usingDefault: true };
}

/**
 * The bot fields a model pick saves. An empty key clears the override. A thinking level stays
 * only when the new model offers it; otherwise it is cleared so a stale level cannot linger.
 */
export function modelPickPatch(
  key: string,
  bot: BotModelFields,
  credentials: readonly ModelCredential[],
  catalog: readonly ModelCatalogEntry[],
): { modelProvider: string | null; modelId: string | null; thinkingLevel: ThinkingLevel | null } {
  const parsed = key ? parseModelOptionKey(key) : null;
  if (!parsed) return { modelProvider: null, modelId: null, thinkingLevel: null };
  const modelId = resolveSelectableModelId(catalog, parsed.provider, parsed.modelId);
  const entry = catalog.find(
    (candidate) =>
      candidate.provider === parsed.provider &&
      resolveSelectableModelId(catalog, candidate.provider, candidate.id) === modelId,
  );
  const levels =
    credentialForModel(credentials, parsed.provider, modelId)?.thinkingLevels ??
    entry?.thinkingLevels ??
    [];
  const keep = bot.thinkingLevel && levels.includes(bot.thinkingLevel) ? bot.thinkingLevel : null;
  return { modelProvider: parsed.provider, modelId, thinkingLevel: keep };
}
