import { describe, expect, it } from "vitest";
import { applyEnvAliases } from "./env-aliases.js";

describe("environment aliases", () => {
  it("answers to the RAKAZO_ name for a SHEPHERD_ setting", () => {
    const env: NodeJS.ProcessEnv = { SHEPHERD_CONFIG: "/etc/shepherd.yaml" };
    applyEnvAliases(env);
    expect(env.RAKAZO_CONFIG).toBe("/etc/shepherd.yaml");
    expect(env.SHEPHERD_CONFIG).toBe("/etc/shepherd.yaml");
  });

  it("leaves a RAKAZO_ setting working on its own", () => {
    const env: NodeJS.ProcessEnv = { RAKAZO_CONFIG: "/old.yaml" };
    applyEnvAliases(env);
    expect(env).toEqual({ RAKAZO_CONFIG: "/old.yaml" });
  });

  it("prefers the SHEPHERD_ value when both are set", () => {
    const env: NodeJS.ProcessEnv = { SHEPHERD_CONFIG: "/new.yaml", RAKAZO_CONFIG: "/old.yaml" };
    applyEnvAliases(env);
    expect(env.RAKAZO_CONFIG).toBe("/new.yaml");
  });

  it("ignores an empty SHEPHERD_ value", () => {
    const env: NodeJS.ProcessEnv = { SHEPHERD_CONFIG: "  ", RAKAZO_CONFIG: "/old.yaml" };
    applyEnvAliases(env);
    expect(env.RAKAZO_CONFIG).toBe("/old.yaml");
  });
});
