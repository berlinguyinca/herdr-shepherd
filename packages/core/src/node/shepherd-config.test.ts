import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyShepherdConfig,
  parseShepherdConfig,
  ShepherdConfigError,
  shepherdConfigEnv,
} from "./shepherd-config.js";

const SECRET = "sk-fixture-not-a-real-key";

const LOCAL = `
access:
  mode: open-owner
  signups: true
owner:
  email: me@example.test
  name: Me
server:
  api_host: 127.0.0.1
  api_port: 3200
  web_origin: http://127.0.0.1:5200
llm:
  provider: local
  base_url: http://127.0.0.1:11434/v1
  api_key: ${SECRET}
  models: [qwen3:4b, qwen3-vl]
  default_model: qwen3-vl
  context_window: 32768
  max_tokens: 4096
  vision_models: [qwen3-vl]
  reasoning_models: [qwen3:4b]
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "rakazo-shepherd-config-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(text: string, mode = 0o600) {
  const file = path.join(dir, "shepherd.yaml");
  writeFileSync(file, text, { mode });
  chmodSync(file, mode);
  return file;
}

describe("shepherd config mapping", () => {
  it("maps a local provider onto the existing environment variables", () => {
    expect(shepherdConfigEnv(parseShepherdConfig(LOCAL, "shepherd.yaml"))).toEqual({
      RAKAZO_ACCESS_MODE: "open-owner",
      SIGNUPS_ENABLED: "true",
      RAKAZO_OWNER_EMAIL: "me@example.test",
      RAKAZO_OWNER_NAME: "Me",
      API_HOST: "127.0.0.1",
      API_PORT: "3200",
      WEB_ORIGIN: "http://127.0.0.1:5200",
      PI_DEFAULT_PROVIDER: "local",
      PI_DEFAULT_MODEL: "qwen3-vl",
      PI_DEFAULT_CREDENTIALS: "host",
      RAKAZO_LOCAL_MODELS: "qwen3:4b,qwen3-vl",
      RAKAZO_LOCAL_MODELS_URL: "http://127.0.0.1:11434/v1",
      RAKAZO_LOCAL_MODELS_API_KEY: SECRET,
      RAKAZO_LOCAL_CONTEXT_WINDOW: "32768",
      RAKAZO_LOCAL_MAX_TOKENS: "4096",
      RAKAZO_LOCAL_VISION_MODELS: "qwen3-vl",
      RAKAZO_LOCAL_REASONING_MODELS: "qwen3:4b",
    });
  });

  it("defaults the local deployment model to the first listed model", () => {
    const env = shepherdConfigEnv(
      parseShepherdConfig("llm: { provider: local, models: [a, b] }", "shepherd.yaml"),
    );
    expect(env.PI_DEFAULT_MODEL).toBe("a");
  });

  it("maps a hosted provider's key to that provider's key variable", () => {
    const env = shepherdConfigEnv(
      parseShepherdConfig(
        `llm: { provider: anthropic, api_key: ${SECRET}, default_model: claude-sonnet-5 }`,
        "shepherd.yaml",
      ),
    );
    expect(env).toEqual({
      PI_DEFAULT_PROVIDER: "anthropic",
      PI_DEFAULT_MODEL: "claude-sonnet-5",
      ANTHROPIC_API_KEY: SECRET,
    });
  });

  it("maps openrouter and deepseek keys", () => {
    const cases: Array<[string, string]> = [
      ["openrouter", "OPENROUTER_API_KEY"],
      ["deepseek", "DEEPSEEK_API_KEY"],
    ];
    for (const [provider, name] of cases) {
      const env = shepherdConfigEnv(
        parseShepherdConfig(`llm: { provider: ${provider}, api_key: k }`, "shepherd.yaml"),
      );
      expect(env[name]).toBe("k");
    }
  });
});

describe("shepherd config validation", () => {
  it("accepts the committed example file", () => {
    const example = new URL("../../../../shepherd.example.yaml", import.meta.url);
    expect(() => parseShepherdConfig(readFileSync(example, "utf8"), "example")).not.toThrow();
  });

  it("rejects an unknown key by path without echoing any value", () => {
    const text = `${LOCAL}\n  api_kee: ${SECRET}\n`;
    let message = "";
    try {
      parseShepherdConfig(text, "shepherd.yaml");
    } catch (error) {
      expect(error).toBeInstanceOf(ShepherdConfigError);
      message = (error as Error).message;
    }
    expect(message).toContain("llm");
    expect(message).toContain("api_kee");
    expect(message).not.toContain(SECRET);
  });

  it("rejects an unknown top-level key", () => {
    expect(() => parseShepherdConfig("bogus: 1", "shepherd.yaml")).toThrow(/bogus/);
  });

  it("does not echo a wrongly typed secret", () => {
    let message = "";
    try {
      parseShepherdConfig(`llm: { provider: local, api_key: [${SECRET}] }`, "shepherd.yaml");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("llm.api_key");
    expect(message).not.toContain(SECRET);
  });

  it("rejects an unknown access mode and an out-of-range port", () => {
    expect(() => parseShepherdConfig("access: { mode: public }", "shepherd.yaml")).toThrow(
      /access\.mode/,
    );
    expect(() => parseShepherdConfig("server: { api_port: 70000 }", "shepherd.yaml")).toThrow(
      /server\.api_port/,
    );
  });

  it("rejects local-only fields on a hosted provider and a default model that is not listed", () => {
    expect(() =>
      parseShepherdConfig("llm: { provider: anthropic, models: [a] }", "shepherd.yaml"),
    ).toThrow(/llm\.models/);
    expect(() =>
      parseShepherdConfig("llm: { provider: local, models: [a], default_model: b }", "x.yaml"),
    ).toThrow(/llm\.default_model/);
  });

  it("reports bad YAML with the file and line but not the line's content", () => {
    let message = "";
    try {
      parseShepherdConfig(`llm:\n  api_key: ${SECRET}\n  api_key: again\n  : [`, "shepherd.yaml");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/shepherd\.yaml/);
    expect(message).toMatch(/line \d+/);
    expect(message).not.toContain(SECRET);
  });
});

describe("applying the config file", () => {
  it("is a no-op when the file is missing", () => {
    const env: NodeJS.ProcessEnv = { RAKAZO_CONFIG: path.join(dir, "absent.yaml") };
    const before = { ...env };
    expect(applyShepherdConfig({ env, cwd: dir })).toEqual([]);
    expect(env).toEqual(before);
  });

  it("fills only what the environment leaves unset", () => {
    write(LOCAL);
    const env: NodeJS.ProcessEnv = {
      API_PORT: "9999",
      RAKAZO_LOCAL_MODELS_API_KEY: "from-env",
      OWNER_BLANK: "",
      RAKAZO_OWNER_NAME: "  ",
    };
    const applied = applyShepherdConfig({ env, cwd: dir, warn: () => undefined });
    expect(env.API_PORT).toBe("9999");
    expect(env.RAKAZO_LOCAL_MODELS_API_KEY).toBe("from-env");
    expect(env.RAKAZO_OWNER_NAME).toBe("Me");
    expect(env.RAKAZO_LOCAL_MODELS).toBe("qwen3:4b,qwen3-vl");
    expect(applied).not.toContain("API_PORT");
    expect(applied).toContain("RAKAZO_LOCAL_MODELS");
  });

  it("never lets the file override a blank access, signup or owner variable", () => {
    write(LOCAL);
    const env: NodeJS.ProcessEnv = {
      RAKAZO_ACCESS_MODE: "",
      SIGNUPS_ENABLED: " ",
      RAKAZO_OWNER_EMAIL: "",
    };
    const applied = applyShepherdConfig({ env, cwd: dir, warn: () => undefined });
    expect(env.RAKAZO_ACCESS_MODE).toBe("");
    expect(env.SIGNUPS_ENABLED).toBe(" ");
    expect(env.RAKAZO_OWNER_EMAIL).toBe("");
    expect(applied).not.toContain("RAKAZO_ACCESS_MODE");
  });

  it("warns about permissions only when the file holds a key", () => {
    write("server: { api_port: 3500 }", 0o644);
    const warnings: string[] = [];
    applyShepherdConfig({ env: {}, cwd: dir, warn: (text) => warnings.push(text) });
    expect(warnings).toEqual([]);
  });

  it("finds the file through RAKAZO_CONFIG, relative to the working directory", () => {
    write("server: { api_port: 3300 }");
    const env: NodeJS.ProcessEnv = { RAKAZO_CONFIG: "shepherd.yaml" };
    applyShepherdConfig({ env, cwd: dir, warn: () => undefined });
    expect(env.API_PORT).toBe("3300");
  });

  it("finds shepherd.yaml in a parent directory of the working directory", () => {
    write("server: { api_port: 3400 }");
    const nested = path.join(dir, "apps", "api");
    const env: NodeJS.ProcessEnv = {};
    applyShepherdConfig({ env, cwd: nested, warn: () => undefined });
    expect(env.API_PORT).toBe("3400");
  });

  it("warns once, without values, when group or others can read the file", () => {
    write(LOCAL, 0o644);
    const warnings: string[] = [];
    const env: NodeJS.ProcessEnv = {};
    applyShepherdConfig({ env, cwd: dir, warn: (text) => warnings.push(text) });
    applyShepherdConfig({ env: {}, cwd: dir, warn: (text) => warnings.push(text) });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("chmod 600");
    expect(warnings[0]).not.toContain(SECRET);
  });

  it("does not warn for an owner-only file", () => {
    write(LOCAL, 0o600);
    const warnings: string[] = [];
    applyShepherdConfig({ env: {}, cwd: dir, warn: (text) => warnings.push(text) });
    expect(warnings).toEqual([]);
  });
});

describe("herdr block", () => {
  const HERDR = "herdr:\n  url: http://100.64.0.10:8787\n  token: fixture-bridge-token\n";

  it("maps onto the herdr variables", () => {
    const env = shepherdConfigEnv(parseShepherdConfig(HERDR, "t"));
    expect(env).toEqual({
      RAKAZO_HERDR_URL: "http://100.64.0.10:8787",
      RAKAZO_HERDR_TOKEN: "fixture-bridge-token",
    });
  });

  it("lets the environment win and never echoes the token on a bad block", () => {
    write(HERDR);
    const env: NodeJS.ProcessEnv = { RAKAZO_HERDR_URL: "http://100.64.0.99:1" };
    applyShepherdConfig({ env, cwd: dir, warn: () => undefined });
    expect(env.RAKAZO_HERDR_URL).toBe("http://100.64.0.99:1");
    expect(env.RAKAZO_HERDR_TOKEN).toBe("fixture-bridge-token");
    const bad = "herdr:\n  url: http://x.test\n  token: fixture-bridge-token\n  extra: 1\n";
    let message = "";
    try {
      parseShepherdConfig(bad, "t");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("unknown key");
    expect(message).not.toContain("fixture-bridge-token");
  });

  it("requires both url and token", () => {
    expect(() => parseShepherdConfig("herdr:\n  url: http://x.test\n", "t")).toThrow(
      ShepherdConfigError,
    );
  });

  it("warns about permissions when the file holds the token", () => {
    write(HERDR, 0o644);
    const warnings: string[] = [];
    applyShepherdConfig({ env: {}, cwd: dir, warn: (text) => warnings.push(text) });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain("fixture-bridge-token");
  });
});
