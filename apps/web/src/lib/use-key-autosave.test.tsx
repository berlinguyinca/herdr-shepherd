// @vitest-environment jsdom

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { KeyAutosave, KeyAutosaveOutcome } from "./use-key-autosave";
import { useKeyAutosave } from "./use-key-autosave";

const DELAY = 40;
let root: Root;
let autosave: KeyAutosave;
let log: string[];
let saveOutcome: KeyAutosaveOutcome;
let saveGate: Promise<void> | null;

function Host() {
  autosave = useKeyAutosave({
    delayMs: DELAY,
    save: async (key) => {
      log.push(`save:${key}`);
      await saveGate;
      return saveOutcome;
    },
    findModels: async () => {
      log.push("find");
    },
  });
  return <p data-phase>{autosave.status.phase}</p>;
}

const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  log = [];
  saveOutcome = "saved";
  saveGate = null;
  root = createRoot(document.body.appendChild(document.createElement("div")));
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

async function mount() {
  await act(async () => root.render(<Host />));
}

it("saves once after typing stops, then refreshes the model list", async () => {
  await mount();
  act(() => autosave.onKeyChange("sk-a"));
  act(() => autosave.onKeyChange("sk-ab"));
  act(() => autosave.onKeyChange("sk-abc"));
  expect(log).toEqual([]);
  await wait(DELAY * 3);
  expect(log).toEqual(["save:sk-abc", "find"]);
  expect(autosave.status.phase).toBe("saved");
});

it("never saves an empty or blank key", async () => {
  await mount();
  act(() => autosave.onKeyChange("   "));
  act(() => autosave.onKeyBlur());
  await wait(DELAY * 3);
  expect(log).toEqual([]);
  expect(autosave.status.phase).toBe("idle");
});

it("a key cleared before the timer fires cancels the pending save", async () => {
  await mount();
  act(() => autosave.onKeyChange("sk-abc"));
  act(() => autosave.onKeyChange(""));
  await wait(DELAY * 3);
  expect(log).toEqual([]);
});

it("saves right away on blur and on paste", async () => {
  await mount();
  act(() => autosave.onKeyChange("sk-blur"));
  await act(async () => autosave.onKeyBlur());
  await wait(10);
  expect(log).toEqual(["save:sk-blur", "find"]);
  act(() => autosave.onKeyChange("sk-paste", { immediate: true }));
  await wait(10);
  expect(log).toEqual(["save:sk-blur", "find", "save:sk-paste", "find"]);
});

it("blur without a pending edit does nothing, so nothing loops", async () => {
  await mount();
  act(() => autosave.onKeyChange("sk-once"));
  await wait(DELAY * 3);
  await act(async () => autosave.onKeyBlur());
  await wait(DELAY * 3);
  expect(log).toEqual(["save:sk-once", "find"]);
});

it("a newer edit during a save drops the stale refresh and saves the newer key after it", async () => {
  let release: () => void = () => {};
  saveGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await mount();
  act(() => autosave.onKeyChange("sk-old"));
  await wait(DELAY * 2);
  expect(log).toEqual(["save:sk-old"]);
  expect(autosave.status.phase).toBe("saving");
  act(() => autosave.onKeyChange("sk-new"));
  saveGate = null;
  release();
  await wait(DELAY * 4);
  expect(log).toEqual(["save:sk-old", "save:sk-new", "find"]);
  expect(autosave.status.phase).toBe("saved");
});

it("still refreshes models when the form is not ready to save", async () => {
  saveOutcome = "skipped";
  await mount();
  act(() => autosave.onKeyChange("sk-draft"));
  await wait(DELAY * 3);
  expect(log).toEqual(["save:sk-draft", "find"]);
  expect(autosave.status.phase).toBe("idle");
});

it("does not refresh models after a failed save", async () => {
  saveOutcome = "failed";
  await mount();
  act(() => autosave.onKeyChange("sk-bad"));
  await wait(DELAY * 3);
  expect(log).toEqual(["save:sk-bad"]);
  expect(autosave.status.phase).toBe("idle");
});

it("drops pending work when unmounted", async () => {
  await mount();
  act(() => autosave.onKeyChange("sk-gone"));
  await act(async () => root.unmount());
  await new Promise((r) => setTimeout(r, DELAY * 3));
  expect(log).toEqual([]);
  root = createRoot(document.body.appendChild(document.createElement("div")));
});
