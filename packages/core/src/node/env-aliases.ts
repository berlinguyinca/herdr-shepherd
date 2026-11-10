const PREFERRED_PREFIX = "SHEPHERD_";
const LEGACY_PREFIX = "RAKAZO_";

/**
 * Every `SHEPHERD_<name>` setting also answers to `RAKAZO_<name>`, the name the code reads.
 * The preferred name wins when both are set; an empty one counts as unset.
 */
export function applyEnvAliases(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(PREFERRED_PREFIX) || !value?.trim()) continue;
    env[LEGACY_PREFIX + key.slice(PREFERRED_PREFIX.length)] = value;
  }
}
