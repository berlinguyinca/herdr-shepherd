// @vitest-environment jsdom

import type { Bot, ModelCatalogEntry, ModelCredential } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spaceQueries } from "../../lib/query";
import type { createSpaceRpc } from "../../lib/rpc";
import { ComposerModelChip } from "./composer-model-chip";

// Vitest does not run the Lingui macro transform; same stand-in the other web suites use.
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const catalog = [
  { provider: "anthropic", providerName: "Anthropic", id: "sonnet", label: "Sonnet", billing: "" },
  { provider: "anthropic", providerName: "Anthropic", id: "haiku", label: "Haiku", billing: "" },
] as unknown as ModelCatalogEntry[];
const anthropic = {
  provider: "anthropic",
  label: "Anthropic",
  isDefault: true,
} as unknown as ModelCredential;
const me = { defaultProvider: "anthropic", defaultModel: "sonnet" };
const bot = {
  id: "bot-1",
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
} as unknown as Bot;

type Update = (input: { botId: string } & Record<string, unknown>) => Promise<Bot>;

describe("ComposerModelChip", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    // cmdk needs these; jsdom has neither.
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    Element.prototype.scrollIntoView ??= () => {};
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(options: {
    credentials: ModelCredential[];
    update?: Update;
    onOpenModels?: () => void;
    openRequest?: number;
  }) {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    const queries = spaceQueries(null, null);
    client.setQueryData(queries.models.credentials.queryKey(), options.credentials);
    client.setQueryData(queries.models.list.queryKey(), catalog);
    client.setQueryData(queries.me.queryKey(), me as never);
    const rpc = { bots: { update: options.update ?? (async () => bot) } } as unknown as ReturnType<
      typeof createSpaceRpc
    >;
    let current = bot;
    const view = (openRequest: number) =>
      createElement(
        QueryClientProvider,
        { client },
        createElement(ComposerModelChip, {
          bot: current,
          rpc,
          openRequest,
          onBotUpdated: (next: Bot) => {
            current = next;
            void act(async () => root.render(view(openRequest)));
          },
          onOpenModels: options.onOpenModels ?? (() => {}),
        }),
      );
    await act(async () => root.render(view(options.openRequest ?? 0)));
    return (openRequest: number) => act(async () => root.render(view(openRequest)));
  }

  it("shows the main model with a default hint", async () => {
    await render({ credentials: [anthropic] });
    const text = container.textContent ?? "";
    expect(text).toContain("Sonnet");
    expect(text).toContain("default");
  });

  it("offers Connect a model, opening Settings > Models, when nothing is configured", async () => {
    let opened = 0;
    await render({ credentials: [], onOpenModels: () => opened++ });
    const button = container.querySelector("button");
    expect(button?.textContent).toContain("Connect a model");
    await act(async () => button?.click());
    expect(opened).toBe(1);
  });

  it("opens the list on a /model request and saves a pick", async () => {
    const saved: unknown[] = [];
    const updated = { ...bot, modelProvider: "anthropic", modelId: "haiku" } as Bot;
    const rerender = await render({
      credentials: [anthropic],
      update: async (input) => {
        saved.push(input);
        return updated;
      },
    });
    expect(document.body.querySelector('[role="listbox"], [cmdk-list]')).toBeNull();
    await rerender(1);
    const rows = [...document.body.querySelectorAll("[cmdk-item]")];
    expect(rows.map((row) => row.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Default"),
        expect.stringContaining("Haiku"),
      ]),
    );
    const haiku = rows.find((row) => row.textContent?.includes("Haiku")) as HTMLElement;
    await act(async () => haiku.click());
    expect(saved).toEqual([
      { botId: "bot-1", modelProvider: "anthropic", modelId: "haiku", thinkingLevel: null },
    ]);
    expect(container.textContent).toContain("Haiku");
    expect(container.textContent).not.toContain("default");
  });

  it("rolls back and shows an error when the save fails", async () => {
    const rerender = await render({
      credentials: [anthropic],
      update: async () => {
        throw new Error("Nope");
      },
    });
    await rerender(1);
    const haiku = [...document.body.querySelectorAll("[cmdk-item]")].find((row) =>
      row.textContent?.includes("Haiku"),
    ) as HTMLElement;
    await act(async () => haiku.click());
    expect(container.textContent).toContain("Sonnet");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Nope");
  });
});
