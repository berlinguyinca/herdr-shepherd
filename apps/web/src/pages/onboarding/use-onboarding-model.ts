import { useLingui } from "@lingui/react/macro";
import type { ThinkingLevel } from "@rakazo/contracts";
import {
  compatibleEndpointKeyRequired,
  compatibleEndpointPresets,
  MAX_MODEL_CONTEXT_WINDOW,
  MAX_MODEL_MAX_TOKENS,
  ModelHeaderRowsSchema,
  matchCompatibleEndpointPreset,
  modelHeadersInput,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  openAiCompatibleConnectReady,
  parseModelContextWindow,
  parseModelMaxImagesPerPrompt,
  parseModelMaxTokens,
} from "@rakazo/contracts";
import {
  clampCatalogThinkingLevel,
  compatibleThinkingLevels,
  connectionFormFields,
  pickCatalogModelId,
  popularModelProvidersFirst,
} from "@rakazo/core";
import { useEffect, useMemo, useState } from "react";
import { useCopyText } from "../../lib/copy-text";
import { providerDisplayName } from "../../lib/localized-provider-hint";
import type { ModelCatalogEntry } from "../../lib/model-auth";
import { rpc } from "../../lib/rpc";
import type { KeyAutosaveOutcome } from "../../lib/use-key-autosave";
import { useKeyAutosave } from "../../lib/use-key-autosave";
import { useModelOAuthSignIn } from "../../lib/use-model-oauth-signin";
import { errorText } from "../../lib/user-error";
import { useModelConnectionForm } from "../model-settings/use-model-connection-form";

/** Shepherd credits sit among the providers as the one choice that needs no account of its own. */
const CREDITS_OPTION = "__rakazo_credits__";
/** Select value for a hosted compatible service; the rest of the value is its base URL. */
const ENDPOINT_PRESET_OPTION = "endpoint-preset:";
/** A provider whose catalog entry offers both sign-in and a key appears once per way to connect. */
type ProviderAuth = "sign-in" | "key";

const MAIN_PROVIDER_OPTIONS: ReadonlyArray<{ provider: string; auth?: ProviderAuth }> = [
  { provider: "openai-codex" },
  { provider: "anthropic", auth: "sign-in" },
  { provider: "openai" },
  { provider: "anthropic", auth: "key" },
  { provider: "openrouter" },
  { provider: "google" },
];

function providerOptionValue(provider: string, auth?: ProviderAuth): string {
  return auth ? `${provider}:${auth}` : provider;
}

export type OnboardingModel = ReturnType<typeof useOnboardingModel>;

/**
 * The model step's connection form, sign-in, and provider choices. The page holds it for its
 * whole life because the bot step and signing out share its error.
 */
export function useOnboardingModel({
  catalog,
  billingEnabled,
  onConnected,
}: {
  catalog: ModelCatalogEntry[];
  billingEnabled: boolean;
  onConnected: () => void;
}) {
  const { t } = useLingui();
  const [providerAuth, setProviderAuth] = useState<ProviderAuth | undefined>();
  const [credits, setCredits] = useState(false);
  const [manualModelId, setManualModelId] = useState(false);
  const form = useModelConnectionForm({
    rpc,
    catalog,
    // Stay in manual entry across re-probes so a typed id that matches a
    // discovered model cannot yank the freeform field back to the Select.
    onModelsFound: (models, typedModelId) =>
      setManualModelId(
        (wasManual) => wasManual || (Boolean(typedModelId) && !models.includes(typedModelId)),
      ),
  });
  const {
    accountId,
    apiKey,
    apiProtocol,
    baseUrl,
    routingReady,
    contextWindow,
    gatewayId,
    headerRows,
    needsRouting,
    isOpenAiCompatible,
    maxImagesPerPrompt,
    maxTokens,
    modelId,
    modelsForProvider,
    openConnection,
    provider,
    reasoning,
    selected,
    setError,
    setProvider,
    supportsImages,
    thinkingLevel,
  } = form;
  const [codeCopied, copyOAuthCode] = useCopyText();

  const signIn = useModelOAuthSignIn({
    onClearError: () => setError(null),
    onError: setError,
    onFinished: async () => {
      onConnected();
    },
  });
  const { oauthPending, cancelOAuthAttempt, startSubscriptionSignIn } = signIn;

  const providers = useMemo(() => {
    const seen = new Map<string, ModelCatalogEntry>();
    for (const entry of catalog) {
      if (!seen.has(entry.provider)) seen.set(entry.provider, entry);
    }
    return popularModelProvidersFirst(
      [...seen.values()],
      (entry) => entry.provider,
      (entry) => entry.providerName ?? entry.provider,
    );
  }, [catalog]);

  const subscriptionSignIn = selected?.signIn !== undefined && providerAuth !== "key";
  const acceptsKey = selected?.auth !== "oauth" && providerAuth !== "sign-in";
  const signInLabel = selected?.oauthLabel ?? t`Sign in`;
  const endpointPresets = useMemo(() => compatibleEndpointPresets(catalog), [catalog]);
  const endpointPreset = isOpenAiCompatible
    ? matchCompatibleEndpointPreset(endpointPresets, baseUrl)
    : undefined;
  const featuredPresets = useMemo(
    () => endpointPresets.filter((preset) => preset.featured),
    [endpointPresets],
  );
  const openAiCompatibleReady = openAiCompatibleConnectReady({
    apiKey,
    baseUrl,
    modelId:
      headerRows !== null && !ModelHeaderRowsSchema.safeParse(headerRows).success ? "" : modelId,
    keyRequired: compatibleEndpointKeyRequired(endpointPreset),
  });
  const canSaveModel = Boolean(
    selected &&
      modelId.trim() &&
      !oauthPending &&
      routingReady &&
      (isOpenAiCompatible ? openAiCompatibleReady : acceptsKey && apiKey.trim()),
  );
  // Subscriptions and the common API providers first; every other provider follows by name.
  const providerOptions = useMemo(() => {
    const byId = new Map(providers.map((entry) => [entry.provider, entry]));
    // Beside the subscriptions, the key-based options say API.
    const optionLabel = (id: string, auth?: ProviderAuth) => {
      if (id === "anthropic" && auth === "key") return t`Anthropic API`;
      if (id === "openai") return t`OpenAI API`;
      return providerDisplayName(id, byId.get(id)?.providerName ?? id, auth);
    };
    const featured = featuredPresets.map((preset) => ({
      value: `${ENDPOINT_PRESET_OPTION}${preset.baseUrl}`,
      label: preset.name,
    }));
    const custom = byId.has(OPENAI_COMPATIBLE_PROVIDER_ID)
      ? [{ value: OPENAI_COMPATIBLE_PROVIDER_ID, label: t`Custom OpenAI-compatible server` }]
      : [];
    const main = [
      ...featured,
      ...custom,
      ...(billingEnabled ? [{ value: CREDITS_OPTION, label: t`Shepherd credits` }] : []),
      ...MAIN_PROVIDER_OPTIONS.filter((option) => byId.has(option.provider)).map((option) => ({
        value: providerOptionValue(option.provider, option.auth),
        label: optionLabel(option.provider, option.auth),
      })),
    ];
    const rest = popularModelProvidersFirst(
      providers
        .filter(
          (entry) => !MAIN_PROVIDER_OPTIONS.some((option) => option.provider === entry.provider),
        )
        .flatMap((entry) => {
          // The custom server and featured presets already lead the main group.
          const item = { value: entry.provider, label: entry.providerName ?? entry.provider };
          return [
            ...(entry.provider === OPENAI_COMPATIBLE_PROVIDER_ID ? [] : [item]),
            ...(entry.endpointPresets ?? [])
              .filter((preset) => !preset.featured)
              .map((preset) => ({
                value: `${ENDPOINT_PRESET_OPTION}${preset.baseUrl}`,
                label: preset.name,
              })),
          ];
        }),
      (option) => option.value,
      (option) => option.label,
    );
    return { main, rest };
  }, [billingEnabled, featuredPresets, providers, t]);
  // Base UI Select.Value only resolves labels when Root gets `items`.
  const providerItems = useMemo(
    () => [...providerOptions.main, ...providerOptions.rest],
    [providerOptions],
  );
  const modelItems = useMemo(
    () => modelsForProvider.map((entry) => ({ value: entry.id, label: entry.label })),
    [modelsForProvider],
  );

  const providerValue = credits
    ? CREDITS_OPTION
    : endpointPreset
      ? `${ENDPOINT_PRESET_OPTION}${endpointPreset.baseUrl}`
      : provider
        ? providerOptionValue(provider, providerAuth)
        : null;

  function chooseProvider(value: string) {
    if (value === CREDITS_OPTION) {
      cancelOAuthAttempt();
      setProvider("");
      setProviderAuth(undefined);
      setCredits(true);
      setError(null);
      return;
    }
    setCredits(false);
    if (value.startsWith(ENDPOINT_PRESET_OPTION))
      selectProvider(OPENAI_COMPATIBLE_PROVIDER_ID, value.slice(ENDPOINT_PRESET_OPTION.length));
    else selectProvider(value);
  }

  function selectProvider(option: string, presetBaseUrl?: string) {
    if (option === providerOptionValue(provider, providerAuth) && !presetBaseUrl && !endpointPreset)
      return;
    const [nextProvider = option, auth] = option.split(":") as [string, ProviderAuth?];
    cancelOAuthAttempt();
    setProviderAuth(auth);
    setManualModelId(false);
    const nextModelId =
      nextProvider === OPENAI_COMPATIBLE_PROVIDER_ID
        ? ""
        : pickCatalogModelId(catalog, nextProvider);
    openConnection(
      nextProvider,
      nextModelId,
      connectionFormFields({
        catalog,
        provider: nextProvider,
        modelId: nextModelId,
        presetBaseUrl,
      }),
    );
  }

  // With nothing chosen yet, start on the featured preset.
  const defaultPreset = featuredPresets[0];
  useEffect(() => {
    if (!defaultPreset || provider || credits) return;
    selectProvider(OPENAI_COMPATIBLE_PROVIDER_ID, defaultPreset.baseUrl);
  }, [defaultPreset?.baseUrl, provider, credits]);

  function stagedThinkingLevel(): ThinkingLevel | null {
    return clampCatalogThinkingLevel(
      thinkingLevel,
      reasoning ? compatibleThinkingLevels(apiProtocol) : [],
    ) as ThinkingLevel | null;
  }

  /**
   * Saves the staged connection. Returns false after reporting a problem with the form's own
   * error line; a failed request throws for the caller to report.
   */
  async function persistConnection(): Promise<boolean> {
    if (isOpenAiCompatible) {
      const parsedMaxImagesPerPrompt = parseModelMaxImagesPerPrompt(
        maxImagesPerPrompt,
        supportsImages,
      );
      if (supportsImages && maxImagesPerPrompt.trim() && parsedMaxImagesPerPrompt === undefined) {
        setError(t`Enter a whole number from 1 to 1000 for the image limit.`);
        return false;
      }
      const maxImagesPerPromptInput =
        supportsImages && !maxImagesPerPrompt.trim() ? null : parsedMaxImagesPerPrompt;

      const parsedMaxTokens = parseModelMaxTokens(maxTokens);
      if (parsedMaxTokens === undefined) {
        setError(
          t`Enter a whole number from 1 to ${MAX_MODEL_MAX_TOKENS} for maximum output tokens.`,
        );
        return false;
      }
      const parsedContextWindow = parseModelContextWindow(contextWindow);
      if (parsedContextWindow === undefined) {
        setError(
          t`Enter a whole number from 1 to ${MAX_MODEL_CONTEXT_WINDOW} for the context limit.`,
        );
        return false;
      }
      await rpc.models.connect({
        provider,
        baseUrl: baseUrl.trim(),
        apiProtocol,
        headers: modelHeadersInput(headerRows),
        modelId: modelId.trim(),
        reasoning,
        thinkingLevel: stagedThinkingLevel(),
        maxTokens: parsedMaxTokens,
        contextWindow: parsedContextWindow,
        supportsImages,
        maxImagesPerPrompt: maxImagesPerPromptInput,
        apiKey: apiKey.trim() || undefined,
        label: selected?.providerName ?? provider,
      });
    } else if (apiKey) {
      await rpc.models.connect({
        provider,
        apiKey,
        ...(needsRouting ? { accountId: accountId.trim(), gatewayId: gatewayId.trim() } : {}),
        modelId,
        label: selected?.providerName ?? provider,
      });
    }
    return true;
  }

  async function saveModel() {
    if (!canSaveModel) return;
    setError(null);
    try {
      if (await persistConnection()) onConnected();
    } catch (err) {
      setError(errorText(err, t`Could not save model`));
    }
  }

  /**
   * Saves the connection as soon as a key is entered, without moving on. A form that is not yet
   * complete (no model chosen) keeps its draft; the model probe below still runs with the typed key.
   */
  async function autosaveKey(): Promise<KeyAutosaveOutcome> {
    if (!canSaveModel) return "skipped";
    setError(null);
    try {
      return (await persistConnection()) ? "saved" : "failed";
    } catch (err) {
      setError(errorText(err, t`Could not save model`));
      return "failed";
    }
  }

  /** Refreshes what the key unlocks: a custom server's model list, or a catalog provider's check. */
  async function refreshAfterKey() {
    if (isOpenAiCompatible) await form.probeServerModels();
    else if (selected?.catalogProbe) await form.testApiKeyConnection();
  }

  const keyAutosave = useKeyAutosave({ save: autosaveKey, findModels: refreshAfterKey });

  async function fundWithCredits() {
    setError(null);
    try {
      await rpc.billing.selectFunding({ funding: "credits" });
      window.location.assign("/onboarding");
    } catch {
      setError(t`Could not open billing`);
    }
  }

  function beginSelectedSubscriptionSignIn() {
    if (!selected?.id) return;
    void startSubscriptionSignIn({
      provider: selected.provider,
      modelId: selected.id,
      label: selected.providerName ?? selected.provider,
    });
  }

  return {
    ...form,
    ...signIn,
    codeCopied,
    copyOAuthCode,
    credits,
    manualModelId,
    setManualModelId,
    subscriptionSignIn,
    acceptsKey,
    signInLabel,
    endpointPreset,
    canSaveModel,
    providerOptions,
    providerItems,
    modelItems,
    providerValue,
    chooseProvider,
    saveModel,
    keyAutosave,
    updateApiKey: (value: string, options?: { immediate?: boolean }) => {
      form.updateApiKey(value);
      keyAutosave.onKeyChange(value, options);
    },
    fundWithCredits,
    beginSelectedSubscriptionSignIn,
  };
}
