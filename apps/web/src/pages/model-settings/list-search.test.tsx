// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FoundModelPicker } from "../../components/FoundModelPicker";
import { ProvidersSection } from "./providers-section";
import { RoleModelPicker } from "./role-model-picker";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = () => {};
  root = createRoot(document.body.appendChild(document.createElement("div")));
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
const providers = Array.from({ length: 11 }, (_, index) => ({
  id: `provider-${index}`,
  name: index === 0 ? "Café provider" : `Provider ${index}`,
}));
const input = () => document.querySelector<HTMLInputElement>("input")!;
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(label: string) {
  await act(async () =>
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent === label)!
      .click(),
  );
}
const options = () => [...document.querySelectorAll("[cmdk-item]")].map((row) => row.textContent);

it("uses the shared matcher in Add provider and keeps an active search after the list shrinks", async () => {
  const render = (rows: typeof providers) =>
    root.render(
      <ProvidersSection
        credentials={[]}
        providers={rows}
        name={() => ""}
        onAdd={() => {}}
        onOpen={() => {}}
      />,
    );
  await act(async () => render(providers.slice(0, 10)));
  await click("Add provider");
  expect(input()).toBeNull();
  await act(async () => render(providers));
  expect(input()).not.toBeNull();
  await type(" CAFÉ ");
  expect(options()).toEqual(["Café provider"]);
  await act(async () => render(providers.slice(0, 1)));
  expect(input().value).toBe(" CAFÉ ");
  await type("");
  expect(input()).toBeNull();
});

it("searches role models by provider name and model id, and lists no provider rows", async () => {
  const onPick = vi.fn();
  const models = Array.from({ length: 11 }, (_, index) => ({
    id: `model-${index}`,
    label: `Model ${index}`,
    provider: "fixture",
    providerName: index === 0 ? "Café" : "Fixture",
    billing: "API key",
  }));
  await act(async () =>
    root.render(
      <RoleModelPicker
        trigger={<button type="button">Choose</button>}
        label="Choose"
        options={models}
        onPick={onPick}
      />,
    ),
  );
  await click("Choose");
  await type(" CAFÉ ");
  expect(options()).toEqual(["Model 0"]);
  await type("model-0");
  expect(options()).toEqual(["Model 0"]);
  await act(async () => document.querySelector<HTMLElement>("[cmdk-item]")!.click());
  expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "model-0" }));
});

it("searches Onboarding's discovered models and keeps manual model entry available", async () => {
  const onChange = vi.fn();
  await act(async () =>
    root.render(
      <FoundModelPicker
        models={providers.map((row) => row.name)}
        value="Café provider"
        otherValue="manual"
        onChange={onChange}
      />,
    ),
  );
  await click("Café provider");
  await type(" CAFÉ ");
  expect(options()).toEqual(["Café provider", "Other model…"]);
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>("[cmdk-item]")]
      .find((row) => row.textContent === "Other model…")!
      .click(),
  );
  expect(onChange).toHaveBeenCalledWith("manual");
});

it("keeps a short role list usable from the keyboard without search", async () => {
  const onPick = vi.fn();
  const option = {
    id: "model-a",
    label: "Model A",
    provider: "fixture",
    providerName: "Fixture",
    billing: "API key",
  };
  await act(async () =>
    root.render(
      <RoleModelPicker
        trigger={<button type="button">Choose</button>}
        label="Choose"
        options={[option]}
        onPick={onPick}
      />,
    ),
  );
  await click("Choose");
  expect(input()).toBeNull();
  const command = document.querySelector<HTMLElement>("[cmdk-root]")!;
  expect(command.tabIndex).toBe(0);
  await act(async () =>
    command.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "model-a" }));
});
