import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { discoverModels, normalizeBaseUrl, OnboardError, runOnboard } from "./onboard.js";
import { applyShepherdConfig } from "./shepherd-config.js";

const KEY = "sk-fixture-not-a-real-key";
const MODELS = ["zeta-7b", "alpha-3b", "qwen3-vl"];

type Behavior = { status?: number; body?: string; needKey?: boolean };
const routes = new Map<string, Behavior>();
let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const route = routes.get(req.url ?? "");
    if (!route) {
      res.writeHead(404).end("nope");
      return;
    }
    if (route.needKey && req.headers.authorization !== `Bearer ${KEY}`) {
      res.writeHead(401).end("{}");
      return;
    }
    res.writeHead(route.status ?? 200, { "content-type": "application/json" });
    res.end(route.body ?? JSON.stringify({ data: MODELS.map((id) => ({ id })) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

let dir: string;
let file: string;
beforeEach(() => {
  routes.clear();
  routes.set("/v1/models", {});
  dir = mkdtempSync(path.join(tmpdir(), "rakazo-onboard-"));
  file = path.join(dir, "shepherd.yaml");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function closedUrl() {
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const port = (closed.address() as AddressInfo).port;
  await new Promise((resolve) => closed.close(resolve));
  return `http://127.0.0.1:${port}`;
}

async function run(argv: string[], answers?: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = "";
  output.on("data", (chunk) => {
    out += chunk;
  });
  const env = { RAKAZO_CONFIG: file, ...extraEnv };
  for (const line of answers ?? []) input.write(`${line}\n`);
  input.end();
  try {
    await runOnboard({ argv, env, cwd: dir, input, output, interactive: answers !== undefined });
    return { out, error: undefined as unknown };
  } catch (error) {
    return { out, error };
  }
}

describe("normalizeBaseUrl", () => {
  it("drops trailing slashes and rejects non-http URLs and embedded logins", () => {
    expect(normalizeBaseUrl(" http://h:1/v1// ")).toBe("http://h:1/v1");
    expect(() => normalizeBaseUrl("ftp://h")).toThrow(OnboardError);
    expect(() => normalizeBaseUrl(`http://u:${KEY}@h`)).toThrow(/Leave the key out/);
    expect(() => normalizeBaseUrl("nonsense")).toThrow(OnboardError);
  });
});

describe("discoverModels", () => {
  it("sorts the advertised ids and sends the key only when given", async () => {
    routes.set("/v1/models", { needKey: true });
    expect((await discoverModels(`${origin}/v1`, KEY)).models).toEqual([
      "alpha-3b",
      "qwen3-vl",
      "zeta-7b",
    ]);
    await expect(discoverModels(`${origin}/v1`, undefined)).rejects.toThrow(/rejected the key/);
    await expect(discoverModels(`${origin}/v1`, "wrong")).rejects.toThrow(/rejected the key/);
  });

  it("falls back from <url>/models to <url>/v1/models and reports the base that answered", async () => {
    expect(await discoverModels(origin, undefined)).toMatchObject({ baseUrl: `${origin}/v1` });
  });

  it("reports non-JSON, an empty list and a refused connection specifically", async () => {
    routes.set("/v1/models", { body: "<html>" });
    await expect(discoverModels(origin, undefined)).rejects.toThrow(/did not return JSON/);
    routes.set("/v1/models", { body: JSON.stringify({ data: [] }) });
    await expect(discoverModels(origin, undefined)).rejects.toThrow(/lists no models/);
    routes.set("/v1/models", { body: JSON.stringify({ models: [] }) });
    await expect(discoverModels(origin, undefined)).rejects.toThrow(/not an OpenAI-style/);
    await expect(discoverModels(await closedUrl(), undefined)).rejects.toThrow(
      /Connection refused/,
    );
  });
});

describe("runOnboard non-interactive", () => {
  it("writes a config the loader accepts and maps to the right environment", async () => {
    routes.set("/v1/models", { needKey: true });
    const { out, error } = await run(
      [
        "--url",
        `${origin}/v1/`,
        "--model",
        "qwen3-vl",
        "--access",
        "accounts",
        "--key-env",
        "MY_KEY",
      ],
      undefined,
      { MY_KEY: KEY },
    );
    expect(error).toBeUndefined();
    expect(out).toContain("key: set");
    expect(out).not.toContain(KEY);
    const env: NodeJS.ProcessEnv = {};
    applyShepherdConfig({ env, cwd: dir });
    expect(env).toMatchObject({
      PI_DEFAULT_PROVIDER: "local",
      PI_DEFAULT_MODEL: "qwen3-vl",
      RAKAZO_LOCAL_MODELS: "alpha-3b,qwen3-vl,zeta-7b",
      RAKAZO_LOCAL_MODELS_URL: `${origin}/v1`,
      RAKAZO_LOCAL_MODELS_API_KEY: KEY,
      RAKAZO_ACCESS_MODE: "accounts",
    });
  });

  it("writes the file with mode 0600 and no key line when none is given", async () => {
    const { error, out } = await run([
      "--url",
      origin,
      "--model",
      "alpha-3b",
      "--access",
      "open-owner",
    ]);
    expect(error).toBeUndefined();
    expect(out).toContain("key: none");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toContain("api_key");
    expect(readFileSync(file, "utf8")).toContain("mode: open-owner");
    expect(readdirSync(dir)).toEqual(["shepherd.yaml"]);
  });

  it("takes the key from SHEPHERD_LLM_KEY", async () => {
    routes.set("/v1/models", { needKey: true });
    const { error } = await run(
      ["--url", origin, "--model", "alpha-3b", "--access", "accounts"],
      undefined,
      {
        SHEPHERD_LLM_KEY: KEY,
      },
    );
    expect(error).toBeUndefined();
    expect(readFileSync(file, "utf8")).toContain(KEY);
  });

  it("never puts the key in a failure message or output", async () => {
    routes.set("/v1/models", { needKey: true });
    const { out, error } = await run(["--url", origin, "--key-env", "K", "--yes"], undefined, {
      K: "wrong-secret-value",
    });
    expect(String((error as Error).message)).not.toContain("wrong-secret-value");
    expect(out).not.toContain("wrong-secret-value");
    expect(existsSync(file)).toBe(false);
  });

  it("with --yes and no --model fails with the list unless exactly one model is advertised", async () => {
    const many = await run(["--url", origin, "--yes"]);
    expect((many.error as Error).message).toContain("alpha-3b, qwen3-vl, zeta-7b");
    expect(existsSync(file)).toBe(false);
    routes.set("/v1/models", { body: JSON.stringify({ data: [{ id: "only" }] }) });
    expect((await run(["--url", origin, "--yes"])).error).toBeUndefined();
    expect(readFileSync(file, "utf8")).toContain("default_model: only");
  });

  it("rejects a model the server does not list, so default_model stays within models", async () => {
    const { error } = await run(["--url", origin, "--model", "ghost", "--access", "accounts"]);
    expect((error as Error).message).toContain("does not list");
    expect(existsSync(file)).toBe(false);
  });

  it("fails instead of waiting when there is no terminal and values are missing", async () => {
    expect(((await run([])).error as Error).message).toContain("--url");
    expect(
      ((await run(["--url", origin, "--model", "alpha-3b"])).error as Error).message,
    ).toContain("--access");
  });

  it("with --yes picks accounts unless --access says open-owner", async () => {
    await run(["--url", origin, "--model", "alpha-3b", "--yes"]);
    expect(readFileSync(file, "utf8")).toContain("mode: accounts");
    rmSync(file);
    await run(["--url", origin, "--model", "alpha-3b", "--yes", "--access", "open-owner"]);
    expect(readFileSync(file, "utf8")).toContain("mode: open-owner");
  });

  it("keeps the old file intact when the final document is invalid", async () => {
    const original = "bogus_key: 1\n";
    writeFileSync(file, original, { mode: 0o600 });
    const { error } = await run(["--url", origin, "--model", "alpha-3b", "--access", "accounts"]);
    expect((error as Error).message).toContain("unknown key");
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(readdirSync(dir)).toEqual(["shepherd.yaml"]);
  });
});

describe("runOnboard idempotence and preservation", () => {
  const EXISTING = `# my notes
access:
  mode: accounts # keep me
  signups: false
server:
  api_port: 3300 # custom port
llm:
  provider: local
  base_url: ${"BASE"}
  api_key: ${KEY}
  models: [old] # stale
  default_model: old
  context_window: 8192
`;

  it("preserves unrelated keys and comments and leaves access alone", async () => {
    routes.set("/v1/models", { needKey: true });
    writeFileSync(file, EXISTING.replace("BASE", `${origin}/v1`), { mode: 0o644 });
    chmodSync(file, 0o644);
    const { error, out } = await run(["--url", origin, "--model", "zeta-7b"], undefined, {
      SHEPHERD_LLM_KEY: KEY,
    });
    expect(error).toBeUndefined();
    const text = readFileSync(file, "utf8");
    expect(text).toContain("# my notes");
    expect(text).toContain("mode: accounts # keep me");
    expect(text).toContain("signups: false");
    expect(text).toContain("api_port: 3300 # custom port");
    expect(text).toContain("context_window: 8192");
    expect(text).toContain("default_model: zeta-7b");
    expect(text).toMatch(/models: \[alpha-3b, qwen3-vl, zeta-7b\] # stale/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(out).not.toContain(KEY);
  });

  it("shows the current values as defaults and accepts them on Enter, key shown only as set", async () => {
    routes.set("/v1/models", { needKey: true });
    writeFileSync(file, EXISTING.replace("BASE", `${origin}/v1`).replaceAll("old", "zeta-7b"), {
      mode: 0o600,
    });
    const before = readFileSync(file, "utf8");
    const { out, error } = await run([], ["", "", "", ""]);
    expect(error).toBeUndefined();
    expect(out).toContain(`[${origin}/v1]`);
    expect(out).toContain("Enter keeps the current key");
    expect(out).toContain("key: set");
    expect(out).not.toContain(KEY);
    const text = readFileSync(file, "utf8");
    expect(text).toContain(KEY);
    expect(text).toContain("default_model: zeta-7b");
    expect(text).toContain("mode: accounts # keep me");
    expect(before).toContain("mode: accounts");
  });

  it("does not send a stored key to a different server", async () => {
    routes.set("/v1/models", { needKey: true });
    writeFileSync(file, EXISTING.replace("BASE", `${await closedUrl()}/v1`), { mode: 0o600 });
    const { out } = await run([], [`${origin}/v1`, "", "1", "y"]);
    expect(out).toContain("rejected the key");
  });
});

describe("runOnboard keeps what it does not replace", () => {
  const HOSTED = `llm:
  provider: anthropic
  api_key: ${KEY}
  default_model: some-hosted-model
`;
  const flags = () => ["--url", origin, "--model", "alpha-3b", "--access", "accounts"];

  it("refuses to replace a hosted provider and its key without a terminal", async () => {
    writeFileSync(file, HOSTED, { mode: 0o600 });
    const { error } = await run([...flags(), "--yes"]);
    expect((error as Error).message).toContain("anthropic");
    expect(readFileSync(file, "utf8")).toBe(HOSTED);
  });

  it("asks before replacing a hosted provider; no leaves the file alone, yes replaces it", async () => {
    writeFileSync(file, HOSTED, { mode: 0o600 });
    expect((await run([], ["n"])).error).toBeInstanceOf(OnboardError);
    expect(readFileSync(file, "utf8")).toBe(HOSTED);
    const { error, out } = await run([], ["y", origin, "", "1", "n"]);
    expect(error).toBeUndefined();
    expect(readFileSync(file, "utf8")).toContain("provider: local");
    expect(out).toContain("key: removed");
  });

  it("says so when a stored key is dropped for a different server", async () => {
    writeFileSync(
      file,
      `llm:\n  provider: local\n  base_url: ${await closedUrl()}/v1\n  api_key: ${KEY}\n`,
      { mode: 0o600 },
    );
    const { out } = await run(flags());
    expect(out).toContain("key: removed");
    expect(readFileSync(file, "utf8")).not.toContain(KEY);
  });

  it("drops per-model and per-server settings that no longer apply", async () => {
    writeFileSync(
      file,
      `llm:
  provider: local
  base_url: ${await closedUrl()}/v1
  models: [old]
  default_model: old
  context_window: 8192
  vision_models: [old, qwen3-vl]
  reasoning_models: [old]
`,
      { mode: 0o600 },
    );
    await run(flags());
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("context_window");
    expect(text).not.toContain("reasoning_models");
    expect(text).toMatch(/vision_models: \[qwen3-vl\]/);
  });
});

describe("runOnboard prompts", () => {
  it("re-prompts after an unreachable URL and hides the typed key", async () => {
    routes.set("/v1/models", { needKey: true });
    const { out, error } = await run([], [await closedUrl(), "", `${origin}/v1`, KEY, "qwen", "n"]);
    expect(error).toBeUndefined();
    expect(out).toContain("Connection refused");
    expect(out).not.toContain(KEY);
    expect(out).toContain("1. alpha-3b");
    const env: NodeJS.ProcessEnv = {};
    applyShepherdConfig({ env, cwd: dir });
    expect(env).toMatchObject({
      PI_DEFAULT_MODEL: "qwen3-vl",
      RAKAZO_LOCAL_MODELS_API_KEY: KEY,
      RAKAZO_ACCESS_MODE: "accounts",
    });
  });

  it("re-prompts after a rejected key, filters by text and picks by number", async () => {
    routes.set("/v1/models", { needKey: true });
    const { out, error } = await run(
      [],
      [`${origin}/v1`, "bad", `${origin}/v1`, KEY, "nomatch", "a", "2", "yes"],
    );
    expect(error).toBeUndefined();
    expect(out).toContain("rejected the key");
    expect(out).toContain("No model matches.");
    const text = readFileSync(file, "utf8");
    expect(text).toContain("default_model: zeta-7b");
    expect(text).toContain("mode: open-owner");
  });

  it("reports an ended input instead of hanging", async () => {
    const { error } = await run([], [`${origin}/v1`]);
    expect((error as Error).message).toContain("Input ended");
  });
});
