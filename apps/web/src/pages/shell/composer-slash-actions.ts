import type { SlashActionId } from "@rakazo/core";
import { SLASH_ACTIONS } from "@rakazo/core";

/** `/model` is web-only: it focuses the composer's model chip, which mobile has no counterpart for. */
export const MODEL_SLASH_ACTION = { id: "model" as const, label: "Model" };

export const COMPOSER_SLASH_ACTIONS = [...SLASH_ACTIONS, MODEL_SLASH_ACTION] as const;

export type ComposerSlashActionId = SlashActionId | typeof MODEL_SLASH_ACTION.id;
