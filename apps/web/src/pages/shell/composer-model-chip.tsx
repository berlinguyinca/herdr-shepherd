import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { groupModelChoices, modelChoiceSearchText } from "@rakazo/core";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  ListSearchInput,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { CheckIcon, ChevronDownIcon, PlugIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { TextOnlyMark } from "../../components/TextOnlyMark";
import { useSpaceQueries } from "../../lib/query";
import type { createSpaceRpc } from "../../lib/rpc";
import { useListSearch } from "../../lib/use-list-search";
import { errorText } from "../../lib/user-error";
import { composerModelState, modelPickPatch } from "./composer-model";

type ModelFields = Pick<Bot, "modelProvider" | "modelId" | "thinkingLevel">;

const NO_CREDENTIALS: never[] = [];
const NO_CATALOG: never[] = [];

/**
 * The model the current assistant runs next, in the composer: click to switch it from the
 * configured models. `openRequest` opens the list (the `/model` command); a change saves through
 * `bots.update`, shows at once, and rolls back with a notice if the save fails.
 */
export function ComposerModelChip({
  bot,
  rpc,
  openRequest = 0,
  onBotUpdated,
  onOpenModels,
}: {
  bot: Bot;
  rpc: ReturnType<typeof createSpaceRpc>;
  openRequest?: number;
  onBotUpdated: (bot: Bot) => void;
  /** Opens Settings > Models, for when nothing is connected. */
  onOpenModels: () => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const credentialsData = useQuery(queries.models.credentials.queryOptions()).data;
  const catalogData = useQuery(queries.models.list.queryOptions()).data;
  const credentials = credentialsData ?? NO_CREDENTIALS;
  const catalog = catalogData ?? NO_CATALOG;
  const loaded = credentialsData !== undefined && catalogData !== undefined;
  const me = useQuery(queries.me.queryOptions()).data ?? null;
  const [pending, setPending] = useState<ModelFields | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const saveSeq = useRef(0);
  // A request made before this chip mounted (another chat's `/model`) must not open it.
  const handledRequest = useRef(openRequest);
  const shown: ModelFields = pending ?? bot;
  const state = composerModelState({
    bot: shown,
    me,
    credentials,
    catalog,
    defaultLabel: t`Default`,
  });
  const { query, setQuery, showSearch, visible } = useListSearch(state.choices, {
    text: modelChoiceSearchText,
  });
  const sections = useMemo(() => groupModelChoices(visible, ""), [visible]);

  const connect = loaded && !state.connected;
  useEffect(() => {
    if (openRequest === handledRequest.current) return;
    handledRequest.current = openRequest;
    if (connect) onOpenModels();
    else if (loaded) setOpen(true);
  }, [openRequest]);

  if (!loaded) return null;

  async function pick(key: string) {
    setOpen(false);
    setQuery("");
    if (key === state.selectedKey) return;
    const patch = modelPickPatch(key, shown, credentials, catalog);
    const seq = ++saveSeq.current;
    setError(null);
    setPending(patch);
    try {
      const updated = await rpc.bots.update({ botId: bot.id, ...patch });
      onBotUpdated(updated);
    } catch (err) {
      if (seq === saveSeq.current) setError(errorText(err));
    } finally {
      if (seq === saveSeq.current) setPending(null);
    }
  }

  const chipClass =
    "inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-border bg-muted px-2.5 text-body-sm text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

  if (connect) {
    return (
      <div className="flex min-w-0 items-center gap-2" data-testid="composer-model-chip">
        <button type="button" className={chipClass} onClick={onOpenModels}>
          <PlugIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">
            <Trans>Connect a model</Trans>
          </span>
        </button>
      </div>
    );
  }

  const chipLabel = state.chipLabel ?? t`Default`;
  const own = state.choices.find((choice) => choice.key === state.selectedKey);
  const textOnly = (own ?? state.choices[0])?.images === false;
  return (
    <div className="flex min-w-0 items-center gap-2" data-testid="composer-model-chip">
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
      >
        <PopoverTrigger
          aria-label={t`Model: ${chipLabel}`}
          data-testid="composer-model-trigger"
          className={chipClass}
        >
          <span dir="auto" className="min-w-0 truncate">
            {chipLabel}
          </span>
          {state.usingDefault ? (
            <span className="shrink-0 text-muted-foreground/70">
              <Trans>default</Trans>
            </span>
          ) : null}
          {textOnly ? <TextOnlyMark /> : null}
          <ChevronDownIcon className="size-3.5 shrink-0" aria-hidden="true" />
        </PopoverTrigger>
        {open ? (
          <PopoverContent
            align="start"
            side="top"
            collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "none" }}
            className="w-72 max-w-[calc(100vw-1.5rem)] max-h-(--available-height) gap-0 overflow-hidden bg-popover p-0 opacity-100 animate-none! backdrop-filter-none"
          >
            <Command
              shouldFilter={false}
              className="h-auto min-h-0 max-h-(--available-height) rounded-none bg-popover *:data-[slot=command-input-wrapper]:shrink-0"
            >
              {showSearch ? (
                <ListSearchInput
                  command
                  query={query}
                  setQuery={setQuery}
                  label={t`Search models`}
                  placeholder={t`Search`}
                />
              ) : null}
              <CommandList className="min-h-0 max-h-80 flex-1 overflow-y-auto">
                <CommandEmpty>
                  <Trans>No matching models</Trans>
                </CommandEmpty>
                {sections.map((section) => (
                  <CommandGroup key={section.key} heading={section.heading}>
                    {section.data.map((choice) => (
                      <CommandItem
                        key={choice.key}
                        aria-label={choice.label}
                        value={choice.key || "space-default"}
                        data-checked={choice.key === state.selectedKey}
                        onSelect={() => void pick(choice.key)}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {choice.title ?? choice.label}
                        </span>
                        {choice.images === false ? (
                          <span className="shrink-0 text-muted-foreground">
                            <TextOnlyMark />
                          </span>
                        ) : null}
                        {choice.key === state.selectedKey ? (
                          <CheckIcon className="size-4 shrink-0" aria-hidden="true" />
                        ) : null}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ))}
              </CommandList>
            </Command>
          </PopoverContent>
        ) : null}
      </Popover>
      {error ? (
        <span role="alert" className="min-w-0 truncate text-body-sm text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}
