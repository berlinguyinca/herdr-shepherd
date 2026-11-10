import type { ModelCatalogEntry, ModelCredential } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { composerModelState, modelPickPatch } from "./composer-model";

const catalog = [
  {
    provider: "anthropic",
    providerName: "Anthropic",
    id: "sonnet",
    label: "Sonnet",
    billing: "",
    thinkingLevels: ["off", "low", "high"],
  },
  { provider: "anthropic", providerName: "Anthropic", id: "haiku", label: "Haiku", billing: "" },
  { provider: "openai", providerName: "OpenAI", id: "gpt", label: "GPT", billing: "" },
] as unknown as ModelCatalogEntry[];
const anthropic = {
  provider: "anthropic",
  label: "Anthropic",
  isDefault: true,
} as unknown as ModelCredential;
const base = { catalog, defaultLabel: "Default" };
const me = { defaultProvider: "anthropic", defaultModel: "sonnet" };
const noModel = { modelProvider: null, modelId: null, thinkingLevel: null };

describe("composerModelState", () => {
  it("names the main model as the default when the bot has no override", () => {
    const state = composerModelState({ ...base, bot: noModel, me, credentials: [anthropic] });
    expect(state.usingDefault).toBe(true);
    expect(state.chipLabel).toContain("Sonnet");
    expect(state.choices[0]).toMatchObject({ key: "", label: "Default" });
  });

  it("offers only models of configured providers", () => {
    const state = composerModelState({ ...base, bot: noModel, me, credentials: [anthropic] });
    const providers = state.choices.slice(1).map((choice) => choice.provider);
    expect(providers.length).toBeGreaterThan(0);
    expect(new Set(providers)).toEqual(new Set(["anthropic"]));
  });

  it("shows the bot's own model when one is set", () => {
    const state = composerModelState({
      ...base,
      bot: { modelProvider: "anthropic", modelId: "haiku", thinkingLevel: null },
      me,
      credentials: [anthropic],
    });
    expect(state.usingDefault).toBe(false);
    expect(state.chipLabel).toContain("Haiku");
    expect(state.selectedKey).not.toBe("");
  });

  it("reports nothing connected when no provider is configured", () => {
    const state = composerModelState({ ...base, bot: noModel, me: null, credentials: [] });
    expect(state.connected).toBe(false);
    expect(state.choices.map((choice) => choice.key)).toEqual([""]);
  });
});

describe("modelPickPatch", () => {
  it("clears the override for the default option", () => {
    expect(
      modelPickPatch(
        "",
        { modelProvider: "anthropic", modelId: "haiku", thinkingLevel: "low" },
        [anthropic],
        catalog,
      ),
    ).toEqual({ modelProvider: null, modelId: null, thinkingLevel: null });
  });

  it("keeps a thinking level the new model offers and drops one it does not", () => {
    const bot = { modelProvider: null, modelId: null, thinkingLevel: "low" as const };
    const sonnet = composerModelState({
      ...base,
      bot: noModel,
      me,
      credentials: [anthropic],
    }).choices.find((choice) => choice.modelId === "sonnet")!;
    const haiku = composerModelState({
      ...base,
      bot: noModel,
      me,
      credentials: [anthropic],
    }).choices.find((choice) => choice.modelId === "haiku")!;
    expect(modelPickPatch(sonnet.key, bot, [anthropic], catalog)).toMatchObject({
      modelId: "sonnet",
      thinkingLevel: "low",
    });
    expect(modelPickPatch(haiku.key, bot, [anthropic], catalog)).toMatchObject({
      modelId: "haiku",
      thinkingLevel: null,
    });
  });
});
