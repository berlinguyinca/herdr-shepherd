import { Trans, useLingui } from "@lingui/react/macro";
import { modelCatalogSearchText } from "@rakazo/core";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandShortcut,
  ListSearchInput,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@rakazo/ui-web";
import type { ReactElement } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelCatalogEntry } from "../../lib/model-auth";
import { useListSearch } from "../../lib/use-list-search";

/** A provider that can be added; it is offered by the connect flow, never by a model list. */
export type ConnectableProvider = {
  id: string;
  name: string;
  baseUrl?: string;
  /** Leads the list of providers to add. */
  featured?: boolean;
};

/** A model on one connection; `providerName` is that connection's name. */
export type RoleModelOption = ModelCatalogEntry & { credentialId?: string };

const optionValue = (option: RoleModelOption) =>
  `${option.provider}:${option.id}:${option.credentialId ?? ""}`;

/**
 * One picker for the models a role can use. It lists only models of connected providers;
 * adding a provider is a separate flow.
 */
export function RoleModelPicker({
  trigger,
  label,
  options,
  defaultOption,
  disabled,
  onPick,
}: {
  trigger: ReactElement;
  label: string;
  options: RoleModelOption[];
  /** The deployment's model, offered to clear the slot back to it. */
  defaultOption?: string;
  disabled?: boolean;
  onPick: (option: RoleModelOption | null) => void;
}) {
  const { t } = useLingui();
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const { query, setQuery, showSearch, visible } = useListSearch(options, {
    text: modelCatalogSearchText,
  });
  const groups = useMemo(() => {
    const grouped = new Map<string, RoleModelOption[]>();
    for (const option of visible) {
      const name = option.providerName ?? option.provider;
      grouped.set(name, [...(grouped.get(name) ?? []), option]);
    }
    return [...grouped];
  }, [visible]);
  const needle = query.trim();
  const values = [
    ...(defaultOption && !needle ? ["default"] : []),
    ...groups.flatMap(([, entries]) => entries.map(optionValue)),
  ];
  // The first row is active whenever the list changes, so Enter always picks something.
  const [activeValue, setActiveValue] = useState("");
  const firstValue = values[0] ?? "";
  useEffect(() => {
    setActiveValue(firstValue);
  }, [firstValue]);
  const close = () => setOpen(false);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) return close();
        setQuery("");
        setOpen(true);
      }}
    >
      <PopoverTrigger render={trigger} aria-label={label} disabled={disabled} />
      <PopoverContent
        align="start"
        sideOffset={6}
        initialFocus={showSearch ? searchRef : undefined}
        className="w-[min(360px,var(--available-width))] gap-0 overflow-hidden p-0 motion-reduce:animate-none"
      >
        <Command
          tabIndex={showSearch ? undefined : 0}
          ref={(command) => {
            if (!command || !searchRef.current) return;
            // cmdk can keep a stale selected item when the controlled value changes before
            // filtered rows commit, so the input names the committed active row itself.
            const active = [...command.querySelectorAll<HTMLElement>("[cmdk-item]")].find(
              (item) => item.dataset.value === activeValue,
            );
            if (active) searchRef.current.setAttribute("aria-activedescendant", active.id);
            else searchRef.current.removeAttribute("aria-activedescendant");
          }}
          label={t`Search models`}
          shouldFilter={false}
          loop
          value={activeValue}
          onValueChange={setActiveValue}
        >
          {showSearch ? (
            <ListSearchInput
              command
              inputRef={searchRef}
              query={query}
              setQuery={setQuery}
              label={t`Search models`}
              placeholder={t`Search`}
            />
          ) : null}
          <CommandList label={t`Model options`} className="rk-scroll max-h-80">
            <CommandEmpty>
              <Trans>No matching models</Trans>
            </CommandEmpty>
            {defaultOption && !needle ? (
              <CommandGroup>
                <CommandItem
                  value="default"
                  onSelect={() => {
                    onPick(null);
                    close();
                  }}
                >
                  <span className="min-w-0 truncate">{defaultOption}</span>
                  <CommandShortcut className="text-body-sm tracking-normal">
                    <Trans>Default</Trans>
                  </CommandShortcut>
                </CommandItem>
              </CommandGroup>
            ) : null}
            {groups.map(([name, entries]) => (
              <CommandGroup key={name} heading={name}>
                {entries.map((option) => (
                  <CommandItem
                    key={optionValue(option)}
                    value={optionValue(option)}
                    onSelect={() => {
                      onPick(option);
                      close();
                    }}
                  >
                    <span className="min-w-0 truncate">{option.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
