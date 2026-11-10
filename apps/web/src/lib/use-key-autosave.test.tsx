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
let findGate: Promise<void> | null;
let verified: boolean;

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
      await findGate;
      return verified;
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
  findGate = null;
  verified = true;
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

it("checks the key once after typing stops, then saves it", async () => {
  await mount();
  act(() => autosave.onKeyChange("sk-a"));
  act(() => autosave.onKeyChange("sk-ab"));
  act(() => autosave.onKeyChange("sk-abc"));
  expect(log).toEqual([]);
  await wait(DELAY * 3);
  expect(log).toEqual(["find", "save:sk-abc"]);
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

it("runs right away on blur and on paste", async () => {
  await mount();
  act(() => autosave.onKeyChange("sk-blur"));
  await act(async () => autosave.onKeyBlur());
  await wait(20);
  expect(log).toEqual(["find", "save:sk-blur"]);
  act(() => autosave.onKeyChange("sk-paste", { immediate: true }));
  await wait(20);
  expect(log).toEqual(["find", "save:sk-blur", "find", "save:sk-paste"]);
});

it("blur without a pending edit does nothing, so nothing loops", async () => {
  await mount();
  act(() => autosave.onKeyChange("sk-once"));
  await wait(DELAY * 3);
  await act(async () => autosave.onKeyBlur());
  await wait(DELAY * 3);
  expect(log).toEqual(["find", "save:sk-once"]);
});

it("a newer edit during the check drops the stale run and saves only the newer key", async () => {
  let release: () => void = () => {};
  findGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await mount();
  act(() => autosave.onKeyChange("sk-old"));
  await wait(DELAY * 2);
  expect(log).toEqual(["find"]);
  expect(autosave.status.phase).toBe("finding");
  act(() => autosave.onKeyChange("sk-new"));
  findGate = null;
  release();
  await wait(DELAY * 4);
  expect(log).toEqual(["find", "find", "save:sk-new"]);
  expect(autosave.status.phase).toBe("saved");
});

it("keeps the saved key when the typed key fails its check", async () => {
  verified = false;
  await mount();
  act(() => autosave.onKeyChange("sk-partial"));
  await wait(DELAY * 3);
  expect(log).toEqual(["find"]);
  expect(autosave.status.phase).toBe("idle");
});

it("stays idle when the form is not ready to save", async () => {
  saveOutcome = "skipped";
  await mount();
  act(() => autosave.onKeyChange("sk-draft"));
  await wait(DELAY * 3);
  expect(log).toEqual(["find", "save:sk-draft"]);
  expect(autosave.status.phase).toBe("idle");
});

it("cancel drops a pending edit so a connection switch cannot save it", async () => {
  await mount();
  act(() => autosave.onKeyChange("sk-switch"));
  act(() => autosave.cancel());
  await wait(DELAY * 3);
  expect(log).toEqual([]);
  expect(autosave.status.phase).toBe("idle");
});

it("cancel during the check drops the run before it saves", async () => {
  let release: () => void = () => {};
  findGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await mount();
  act(() => autosave.onKeyChange("sk-run"));
  await wait(DELAY * 2);
  act(() => autosave.cancel());
  findGate = null;
  release();
  await wait(DELAY * 3);
  expect(log).toEqual(["find"]);
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
