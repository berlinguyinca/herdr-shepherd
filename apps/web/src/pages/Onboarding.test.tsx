// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const account = vi.hoisted(() => ({ load: (_me: unknown) => {} }));

vi.mock("../lib/rpc", () => ({
  selectedSpaceId: () => null,
  rpc: {
    me: vi.fn(
      () =>
        new Promise((resolve) => {
          account.load = resolve;
        }),
    ),
    models: {
      list: vi.fn(async () => [
        {
          provider: "openai-compatible",
          providerName: "OpenAI-compatible",
          id: "",
          label: "Custom",
          billing: "API key",
          endpointPresets: [
            {
              name: "Hosted Featured",
              baseUrl: "https://featured.example.test/v1",
              keyRequired: false,
              featured: true,
            },
            { name: "Hosted Keyed", baseUrl: "https://keyed.example.test/v1" },
          ],
        },
      ]),
      probeOpenAiCompatible: vi.fn(async () => ({
        models: Array.from({ length: 11 }, (_, index) => `found-${index}`),
      })),
    },
  },
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values);
  return {
    useLingui: () => ({ t }),
    Trans: ({ children }: { children?: ReactNode }) => children,
    Plural: ({ one, other, value }: { one: string; other: string; value: number }) =>
      value === 1 ? one : other,
  };
});

import { rpc } from "../lib/rpc";
import { OnboardingPage } from "./Onboarding";

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
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

it("marks onboarding as usable for the desktop only once a step shows", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  // The shell sends a new account to /onboarding, which loads before it picks a step.
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/onboarding"]}>
        <Routes>
          <Route path="/onboarding/:step?" element={<OnboardingPage />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  const marked = () => host.querySelector('[data-rakazo-surface="onboarding"]');
  expect(marked()).toBeNull();

  await act(async () =>
    account.load({ needsModel: true, needsSignupSurvey: false, billingEnabled: false }),
  );
  expect(host.querySelector("h1")?.textContent).toBe("Connect a model");
  expect(marked()).not.toBeNull();
  act(() => root.unmount());
});

it("finds and searches a long custom endpoint list during onboarding", async () => {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/onboarding"]}>
        <Routes>
          <Route path="/onboarding/:step?" element={<OnboardingPage />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  await act(async () =>
    account.load({ needsModel: true, needsSignupSurvey: false, billingEnabled: false }),
  );
  await act(async () => document.querySelector<HTMLElement>('[aria-label="Provider"]')!.click());
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent === "Custom OpenAI-compatible server")!
      .click(),
  );
  const change = async (label: string, value: string) => {
    const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  await change("OpenAI-compatible server URL", "https://models.example.test/v1");
  await act(async () =>
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "Find models")!
      .click(),
  );
  // Onboarding probes the endpoint the same way model settings does.
  expect(rpc.models.probeOpenAiCompatible).toHaveBeenCalledWith(
    expect.objectContaining({
      baseUrl: "https://models.example.test/v1",
      apiProtocol: "chat-completions",
    }),
  );
  await act(async () =>
    document.querySelector<HTMLElement>('[aria-label="Models from server"]')!.click(),
  );
  await change("Search models", "found-10");
  expect([...document.querySelectorAll("[cmdk-item]")].map((row) => row.textContent)).toEqual([
    "found-10",
    "Other model…",
  ]);
  await act(async () => document.querySelector<HTMLElement>("[cmdk-item]")!.click());
  expect(document.querySelector('[aria-label="Models from server"]')?.textContent).toBe("found-10");
  await act(async () => root.unmount());
});

it("preselects the featured hosted preset and lists the custom server in the main group", async () => {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/onboarding"]}>
        <Routes>
          <Route path="/onboarding/:step?" element={<OnboardingPage />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  await act(async () =>
    account.load({ needsModel: true, needsSignupSurvey: false, billingEnabled: false }),
  );
  const trigger = document.querySelector<HTMLElement>('[aria-label="Provider"]')!;
  expect(trigger.textContent).toContain("Hosted Featured");
  expect(
    document.querySelector<HTMLInputElement>('input[aria-label="OpenAI-compatible server URL"]')
      ?.value,
  ).toBe("https://featured.example.test/v1");
  // The featured preset needs no key.
  expect(document.querySelector<HTMLInputElement>('input[aria-label="API key"]')?.required).toBe(
    false,
  );
  await act(async () => trigger.click());
  const labels = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent);
  expect(labels.slice(0, 2)).toEqual(["Hosted Featured", "Custom OpenAI-compatible server"]);
  expect(labels.filter((label) => label === "Hosted Featured")).toHaveLength(1);
  expect(labels).toContain("Hosted Keyed");
  act(() => root.unmount());
});
