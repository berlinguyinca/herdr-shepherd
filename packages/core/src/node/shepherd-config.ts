import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";

/** The settings file at the repository root; `RAKAZO_CONFIG` names another path. */
export const SHEPHERD_CONFIG_FILE = "shepherd.yaml";

/** Hosted providers and the existing environment variable that carries each one's key. */
const HOSTED_KEY_VARIABLES = {
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
} as const;

const LOCAL_ONLY_FIELDS = [
  "base_url",
  "models",
  "context_window",
  "max_tokens",
  "vision_models",
  "reasoning_models",
] as const;

const modelIds = z.array(z.string().min(1)).min(1);

const llmSchema = z
  .strictObject({
    provider: z.enum([
      "local",
      ...(Object.keys(HOSTED_KEY_VARIABLES) as [keyof typeof HOSTED_KEY_VARIABLES]),
    ]),
    base_url: z.url(),
    api_key: z.string().min(1),
    models: modelIds,
    default_model: z.string().min(1),
    context_window: z.number().int().positive(),
    max_tokens: z.number().int().positive(),
    vision_models: modelIds,
    reasoning_models: modelIds,
  })
  .partial({
    base_url: true,
    api_key: true,
    models: true,
    default_model: true,
    context_window: true,
    max_tokens: true,
    vision_models: true,
    reasoning_models: true,
  })
  .superRefine((llm, context) => {
    if (llm.provider !== "local") {
      for (const field of LOCAL_ONLY_FIELDS) {
        if (llm[field] !== undefined) {
          context.addIssue({
            code: "custom",
            path: [field],
            message: "only applies to provider local",
          });
        }
      }
    } else if (llm.default_model && !llm.models?.includes(llm.default_model)) {
      context.addIssue({
        code: "custom",
        path: ["default_model"],
        message: "must be one of models",
      });
    }
  });

export const shepherdConfigSchema = z.strictObject({
  access: z
    .strictObject({
      mode: z.enum(["accounts", "open-owner"]).optional(),
      signups: z.boolean().optional(),
    })
    .optional(),
  owner: z
    .strictObject({ email: z.email().optional(), name: z.string().min(1).optional() })
    .optional(),
  server: z
    .strictObject({
      api_host: z.string().min(1).optional(),
      api_port: z.number().int().min(1).max(65535).optional(),
      web_origin: z.url().optional(),
    })
    .optional(),
  llm: llmSchema.optional(),
});
export type ShepherdConfig = z.infer<typeof shepherdConfigSchema>;

/** Names the file and the key or line at fault; never a value, since the file holds a key. */
export class ShepherdConfigError extends Error {
  override name = "ShepherdConfigError";
}

export function parseShepherdConfig(text: string, source: string): ShepherdConfig {
  const document = parseDocument(text, { prettyErrors: false });
  if (document.errors.length > 0) {
    const problems = document.errors.map(
      (error) => `${source}: invalid YAML at line ${error.linePos?.[0].line ?? 1} (${error.code})`,
    );
    throw new ShepherdConfigError(problems.join("\n"));
  }
  const parsed = shepherdConfigSchema.safeParse(document.toJS() ?? {});
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.map((issue) => {
    const where = issue.path.join(".");
    if (issue.code === "unrecognized_keys") {
      const keys = issue.keys.map((key) => `"${key}"`).join(", ");
      return `${source}: ${where ? `${where}: ` : ""}unknown key ${keys}`;
    }
    return `${source}: ${where || "(root)"}: ${issue.message}`;
  });
  throw new ShepherdConfigError(problems.join("\n"));
}

/** The environment variables a config file stands for. */
export function shepherdConfigEnv(config: ShepherdConfig): Record<string, string> {
  const env: Record<string, string> = {};
  const set = (name: string, value: string | number | boolean | string[] | undefined) => {
    if (value === undefined) return;
    env[name] = Array.isArray(value) ? value.join(",") : String(value);
  };
  set("RAKAZO_ACCESS_MODE", config.access?.mode);
  set("SIGNUPS_ENABLED", config.access?.signups);
  set("RAKAZO_OWNER_EMAIL", config.owner?.email);
  set("RAKAZO_OWNER_NAME", config.owner?.name);
  set("API_HOST", config.server?.api_host);
  set("API_PORT", config.server?.api_port);
  set("WEB_ORIGIN", config.server?.web_origin);
  const llm = config.llm;
  if (!llm) return env;
  set("PI_DEFAULT_PROVIDER", llm.provider);
  if (llm.provider === "local") {
    set("PI_DEFAULT_MODEL", llm.default_model ?? llm.models?.[0]);
    env.PI_DEFAULT_CREDENTIALS = "host";
    set("RAKAZO_LOCAL_MODELS", llm.models);
    set("RAKAZO_LOCAL_MODELS_URL", llm.base_url);
    set("RAKAZO_LOCAL_MODELS_API_KEY", llm.api_key);
    set("RAKAZO_LOCAL_CONTEXT_WINDOW", llm.context_window);
    set("RAKAZO_LOCAL_MAX_TOKENS", llm.max_tokens);
    set("RAKAZO_LOCAL_VISION_MODELS", llm.vision_models);
    set("RAKAZO_LOCAL_REASONING_MODELS", llm.reasoning_models);
  } else {
    set("PI_DEFAULT_MODEL", llm.default_model);
    set(HOSTED_KEY_VARIABLES[llm.provider], llm.api_key);
  }
  return env;
}

/** The file the loader reads: `RAKAZO_CONFIG`, else the nearest `shepherd.yaml` upward from `cwd`. */
export function configPath(env: NodeJS.ProcessEnv, cwd: string): string | undefined {
  const explicit = env.RAKAZO_CONFIG?.trim();
  if (explicit) return path.resolve(cwd, explicit);
  let dir = cwd;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, SHEPHERD_CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const warned = new Set<string>();

type ReadOptions = { env?: NodeJS.ProcessEnv; cwd?: string; warn?: (message: string) => void };

/** The variables the config file stands for; empty when there is no file. */
export function readShepherdConfigEnv(options: ReadOptions = {}): Record<string, string> {
  const { env = process.env, cwd = process.cwd() } = options;
  const warn = options.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
  const file = configPath(env, cwd);
  if (!file || !existsSync(file)) return {};
  const config = parseShepherdConfig(readFileSync(file, "utf8"), file);
  if (
    config.llm?.api_key &&
    process.platform !== "win32" &&
    statSync(file).mode & 0o077 &&
    !warned.has(file)
  ) {
    warned.add(file);
    warn(
      `${SHEPHERD_CONFIG_FILE} holds a key and is readable by other users; run chmod 600 on it.`,
    );
  }
  return shepherdConfigEnv(config);
}

/** Variables where a blank value in the environment is still a choice the file must not override. */
const SECURITY_VARIABLES = new Set(["RAKAZO_ACCESS_MODE", "SIGNUPS_ENABLED", "RAKAZO_OWNER_EMAIL"]);

/**
 * Fills variables the environment leaves unset (or blank) from the config file. Real environment
 * variables and `.env` always win. A blank access or owner variable counts as set, so the file
 * cannot switch it on (a blank access mode means `accounts`). Returns the names it set. A missing
 * file changes nothing.
 */
export function applyShepherdConfig(options: ReadOptions = {}): string[] {
  const env = options.env ?? process.env;
  const applied: string[] = [];
  for (const [name, value] of Object.entries(readShepherdConfigEnv({ ...options, env }))) {
    if (env[name]?.trim() || (SECURITY_VARIABLES.has(name) && env[name] !== undefined)) continue;
    env[name] = value;
    applied.push(name);
  }
  return applied;
}
