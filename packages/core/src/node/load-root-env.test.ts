import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRootEnv } from "./load-root-env.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "rakazo-env-test-"));
  writeFileSync(path.join(root, ".env"), "RAKAZO_TEST_ENV_SENTINEL=fixture\nDATA_DIR=./data\n");
  vi.spyOn(process, "cwd").mockReturnValue(root);
  vi.stubEnv("RAKAZO_TEST_ENV_SENTINEL", undefined);
  vi.stubEnv("DATA_DIR", undefined);
  vi.stubEnv("VERIFY_PROVIDERS", undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("root environment loading", () => {
  it("does not import local configuration into test processes", () => {
    vi.stubEnv("NODE_ENV", "test");
    loadRootEnv();
    expect(process.env.RAKAZO_TEST_ENV_SENTINEL).toBeUndefined();
    expect(process.env.DATA_DIR).toBeUndefined();
  });

  it("loads development configuration and anchors relative data paths to its directory", () => {
    vi.stubEnv("NODE_ENV", "development");
    loadRootEnv();
    expect(process.env.RAKAZO_TEST_ENV_SENTINEL).toBe("fixture");
    expect(process.env.DATA_DIR).toBe(path.join(root, "data"));
  });

  it("preserves configuration supplied by the caller", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("RAKAZO_TEST_ENV_SENTINEL", "caller");
    loadRootEnv();
    expect(process.env.RAKAZO_TEST_ENV_SENTINEL).toBe("caller");
  });

  it("fills what the environment and .env leave unset from shepherd.yaml", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("API_PORT", undefined);
    vi.stubEnv("WEB_ORIGIN", undefined);
    vi.stubEnv("RAKAZO_CONFIG", undefined);
    writeFileSync(path.join(root, ".env"), "API_PORT=4100\n");
    writeFileSync(
      path.join(root, "shepherd.yaml"),
      "server: { api_port: 4200, web_origin: 'http://127.0.0.1:5300' }\n",
      { mode: 0o600 },
    );
    loadRootEnv();
    expect(process.env.API_PORT).toBe("4100");
    expect(process.env.WEB_ORIGIN).toBe("http://127.0.0.1:5300");
  });

  it("loads configuration when a live verification explicitly opts in", () => {
    vi.stubEnv("NODE_ENV", "test");
    loadRootEnv({ allowInTests: true });
    expect(process.env.RAKAZO_TEST_ENV_SENTINEL).toBe("fixture");
  });
});
