vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));

import * as SecureStore from "expo-secure-store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentApiBase, loadApiBase, saveApiBase, signUp } from "./api.js";
import { defaultApiBase } from "./endpoint.js";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("./live-notifications.js", () => ({
  resumeLiveNotifications: vi.fn(async () => undefined),
  stopLiveNotifications: vi.fn(async () => undefined),
}));
vi.mock("./network-cache.js", () => ({ clearNetworkCache: vi.fn() }));

const OTHER = "https://hosted.example.test";
let store: Map<string, string>;

beforeEach(() => {
  delete process.env.EXPO_PUBLIC_PERSONAL_SERVER_ONLY;
  store = new Map();
  vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => store.get(key) ?? null);
  vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
    store.set(key, value);
  });
  vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
    store.delete(key);
  });
});

describe("personal-server fork", () => {
  it("refuses to save any server but the personal one", async () => {
    await loadApiBase();
    const before = currentApiBase();
    await expect(saveApiBase(OTHER)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("personal dashboard"),
    });
    expect(currentApiBase()).toBe(before);
    expect(store.size).toBe(0);
  });

  it("drops a custom server saved by an earlier build and keeps the personal one", async () => {
    store.set("rakazo.api_base", OTHER);
    await expect(loadApiBase()).resolves.toBe(defaultApiBase());
    expect(currentApiBase()).toBe(defaultApiBase());
    expect(store.has("rakazo.api_base")).toBe(false);
  });

  it("registers only against the personal server", async () => {
    process.env.EXPO_PUBLIC_PERSONAL_SERVER_ONLY = "false";
    await saveApiBase(OTHER);
    expect(currentApiBase()).toBe(OTHER);
    delete process.env.EXPO_PUBLIC_PERSONAL_SERVER_ONLY;
    await expect(signUp("a@b.co", "pw-12345678", "A")).rejects.toThrow("personal dashboard");
  });

  it("lets the lock be switched off for upstream behavior", async () => {
    process.env.EXPO_PUBLIC_PERSONAL_SERVER_ONLY = "false";
    await expect(saveApiBase(OTHER)).resolves.toMatchObject({ ok: true, url: OTHER });
  });
});
