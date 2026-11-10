import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { isMap, isSeq, parseDocument } from "yaml";
import { isOwnerNetworkHost } from "./owner-network.js";
import type { ShepherdConfig } from "./shepherd-config.js";
import { configPath, parseShepherdConfig, SHEPHERD_CONFIG_FILE } from "./shepherd-config.js";

const DEFAULT_URL = "http://127.0.0.1:11434/v1";
const DEFAULT_API_HOST = "127.0.0.1";
const MODELS_TIMEOUT_MS = 10_000;
const EXAMPLE_FILE = new URL("../../../../shepherd.example.yaml", import.meta.url);

/** A failure the person can act on. Messages never carry the API key. */
export class OnboardError extends Error {
  override name = "OnboardError";
}

type AccessMode = NonNullable<NonNullable<ShepherdConfig["access"]>["mode"]>;

export type OnboardOptions = {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** True when a person can answer prompts; false fails on missing values instead of waiting. */
  interactive: boolean;
};

export const ONBOARD_USAGE = `Usage: pnpm onboard [--url <base-url>] [--model <id>] [--key-env <NAME>]
                    [--access open-owner|accounts] [--reconfigure-access] [--yes]
The API key is read from the environment variable named by --key-env, else SHEPHERD_LLM_KEY.`;

/** `<base>/v1`-style base URL without a trailing slash; only http and https, no embedded login. */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new OnboardError(`"${raw.trim()}" is not a URL; use http:// or https://.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OnboardError("The server URL must start with http:// or https://.");
  }
  if (url.username || url.password) {
    throw new OnboardError("Leave the key out of the URL; enter it at the key prompt.");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

class StatusError extends OnboardError {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

async function fetchModelIds(baseUrl: string, key: string | undefined): Promise<string[]> {
  const origin = new URL(baseUrl).host;
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
      redirect: "error",
    });
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    if ((error as Error).name === "TimeoutError") {
      throw new StatusError(`${origin} did not answer within 10 seconds.`, false);
    }
    if (code === "ECONNREFUSED") {
      throw new StatusError(`Connection refused at ${origin}; is the server running?`, false);
    }
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
      throw new StatusError(`Host ${origin} was not found.`, false);
    }
    throw new StatusError(`Could not reach ${origin}.`, false);
  }
  if (response.status === 401 || response.status === 403) {
    throw new StatusError("The server rejected the key.", false);
  }
  if (!response.ok) {
    throw new StatusError(
      `${baseUrl}/models answered HTTP ${response.status}.`,
      true,
      response.status,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new StatusError(`${baseUrl}/models did not return JSON.`, true);
  }
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    throw new StatusError(`${baseUrl}/models is not an OpenAI-style model list.`, true);
  }
  const ids = [
    ...new Set(
      data.flatMap((entry) => {
        const id = (entry as { id?: unknown } | null)?.id;
        return typeof id === "string" && id ? [id] : [];
      }),
    ),
  ].sort();
  if (ids.length === 0) throw new StatusError("The server lists no models.", false);
  return ids;
}

/** Tries `<url>/models`, then `<url>/v1/models`; returns the base URL that answered. */
export async function discoverModels(
  rawUrl: string,
  key: string | undefined,
): Promise<{ baseUrl: string; models: string[] }> {
  const base = normalizeBaseUrl(rawUrl);
  try {
    return { baseUrl: base, models: await fetchModelIds(base, key) };
  } catch (error) {
    if (!(error instanceof StatusError) || !error.retryable || base.endsWith("/v1")) throw error;
    const withV1 = `${base}/v1`;
    try {
      return { baseUrl: withV1, models: await fetchModelIds(withV1, key) };
    } catch (second) {
      // A missing /models says less than what the /v1 path answered.
      throw error.status === 404 ? second : error;
    }
  }
}

type Prompter = {
  say(text: string): void;
  ask(question: string, fallback?: string): Promise<string>;
  askSecret(question: string): Promise<string>;
  close(): void;
};

/** Line-based prompts over any stream pair; the secret prompt never echoes what is typed. */
function createPrompter(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  terminal: boolean,
): Prompter {
  let muted = false;
  const echo = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) output.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input, output: echo, terminal });
  const queue: string[] = [];
  let closed = false;
  let waiting: ((line: string | undefined) => void) | undefined;
  rl.on("line", (line) => {
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(line);
    } else queue.push(line);
  });
  rl.on("SIGINT", () => rl.close());
  rl.on("close", () => {
    closed = true;
    waiting?.(undefined);
    waiting = undefined;
  });
  const nextLine = async (): Promise<string> => {
    const buffered = queue.shift();
    if (buffered !== undefined) return buffered;
    const line = closed ? undefined : await new Promise<string | undefined>((r) => (waiting = r));
    if (line === undefined)
      throw new OnboardError("Input ended before the questions were answered.");
    return line;
  };
  return {
    say: (text) => void output.write(`${text}\n`),
    async ask(question, fallback) {
      output.write(fallback ? `${question} [${fallback}]: ` : `${question}: `);
      return (await nextLine()).trim() || fallback || "";
    },
    async askSecret(question) {
      output.write(`${question}: `);
      muted = true;
      try {
        return (await nextLine()).trim();
      } finally {
        muted = false;
        output.write("\n");
      }
    },
    close: () => rl.close(),
  };
}

async function askYesNo(prompter: Prompter, question: string, fallback: boolean): Promise<boolean> {
  for (;;) {
    const answer = (await prompter.ask(question, fallback ? "yes" : "no")).toLowerCase();
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    prompter.say("Answer yes or no.");
  }
}

async function pickModel(
  prompter: Prompter,
  models: string[],
  fallback: string | undefined,
): Promise<string> {
  let shown = models;
  const list = () => {
    shown.forEach((id, index) => void prompter.say(`  ${index + 1}. ${id}`));
  };
  list();
  for (;;) {
    const answer = await prompter.ask("Default model (number, or text to filter)", fallback);
    const exact = models.find((id) => id === answer);
    if (exact) return exact;
    if (/^\d+$/.test(answer)) {
      const chosen = shown[Number(answer) - 1];
      if (chosen) return chosen;
      prompter.say(`Pick a number from 1 to ${shown.length}.`);
      continue;
    }
    const matches = models.filter((id) => id.toLowerCase().includes(answer.toLowerCase()));
    if (matches.length === 1 && matches[0]) return matches[0];
    if (matches.length === 0) prompter.say("No model matches.");
    else {
      shown = matches;
      list();
    }
  }
}

function setSeq(document: ReturnType<typeof parseDocument>, keyPath: string[], ids: string[]) {
  const existing = document.getIn(keyPath, true);
  if (isSeq(existing)) {
    existing.items = ids.map((id) => document.createNode(id));
    return;
  }
  const seq = document.createNode(ids);
  seq.flow = true;
  document.setIn(keyPath, seq);
}

function updateDocument(
  document: ReturnType<typeof parseDocument>,
  values: {
    baseUrl: string;
    models: string[];
    defaultModel: string;
    key: string | undefined;
    access: AccessMode | undefined;
  },
) {
  const section = (name: string) => {
    if (!isMap(document.get(name, true))) document.set(name, document.createNode({}));
  };
  section("llm");
  document.setIn(["llm", "provider"], "local");
  document.setIn(["llm", "base_url"], values.baseUrl);
  if (values.key) document.setIn(["llm", "api_key"], values.key);
  else document.deleteIn(["llm", "api_key"]);
  setSeq(document, ["llm", "models"], values.models);
  document.setIn(["llm", "default_model"], values.defaultModel);
  if (values.access) {
    section("access");
    document.setIn(["access", "mode"], values.access);
  }
}

/** Same-directory temp file, then rename: the old file stays whole until the new one is complete. */
function writeAtomic(file: string, text: string) {
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function parseFlags(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      options: {
        url: { type: "string" },
        model: { type: "string" },
        "key-env": { type: "string" },
        access: { type: "string" },
        "reconfigure-access": { type: "boolean" },
        yes: { type: "boolean", short: "y" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: false,
    }).values;
  } catch (error) {
    throw new OnboardError(`${(error as Error).message}\n${ONBOARD_USAGE}`);
  }
}

export async function runOnboard(options: OnboardOptions): Promise<void> {
  const { env, cwd, interactive } = options;
  const flags = parseFlags(options.argv);
  if (flags.help) {
    options.output.write(`${ONBOARD_USAGE}\n`);
    return;
  }
  if (flags.access !== undefined && flags.access !== "accounts" && flags.access !== "open-owner") {
    throw new OnboardError("--access must be open-owner or accounts.");
  }
  const flagAccess = flags.access as AccessMode | undefined;
  const yes = flags.yes === true;
  const prompting = interactive && !yes;
  const missing = (what: string) =>
    new OnboardError(`${what} is required when there is no terminal to ask; pass it as a flag.`);

  const file = configPath(env, cwd) ?? path.join(cwd, SHEPHERD_CONFIG_FILE);
  const isNew = !existsSync(file);
  const text = isNew
    ? existsSync(EXAMPLE_FILE)
      ? readFileSync(EXAMPLE_FILE, "utf8")
      : ""
    : readFileSync(file, "utf8");
  const current: ShepherdConfig = isNew ? {} : parseShepherdConfig(text, file);
  const currentLlm = current.llm?.provider === "local" ? current.llm : undefined;

  const keyEnvName = flags["key-env"];
  const suppliedKey = keyEnvName ? env[keyEnvName]?.trim() : env.SHEPHERD_LLM_KEY?.trim();
  if (keyEnvName && !suppliedKey) {
    throw new OnboardError(`Environment variable ${keyEnvName} is empty.`);
  }

  const prompter = createPrompter(options.input, options.output, prompting && isTty(options.input));
  try {
    let urlFlag = flags.url;
    let keyPrefilled = suppliedKey !== undefined;
    let found: { baseUrl: string; models: string[] };
    let key: string | undefined;
    for (;;) {
      let rawUrl = urlFlag;
      if (rawUrl === undefined) {
        if (!prompting && !yes) throw missing("--url");
        rawUrl = prompting
          ? await prompter.ask(
              "LLM server URL (OpenAI-compatible)",
              currentLlm?.base_url ?? DEFAULT_URL,
            )
          : (currentLlm?.base_url ?? DEFAULT_URL);
      }
      try {
        const base = normalizeBaseUrl(rawUrl);
        // A stored key goes only to the server it was stored for.
        const stored =
          currentLlm?.api_key &&
          currentLlm.base_url &&
          normalizeBaseUrl(currentLlm.base_url) === base
            ? currentLlm.api_key
            : undefined;
        if (keyPrefilled) key = suppliedKey;
        else if (prompting) {
          const typed = await prompter.askSecret(
            `API key (optional, hidden${stored ? "; Enter keeps the current key, - removes it" : ""})`,
          );
          key = typed === "-" ? undefined : typed || stored;
        } else key = stored;
        found = await discoverModels(base, key);
        break;
      } catch (error) {
        if (!(error instanceof OnboardError) || !prompting) throw error;
        prompter.say(error.message);
        urlFlag = undefined;
        keyPrefilled = false;
      }
    }

    const fallbackModel =
      currentLlm?.default_model && found.models.includes(currentLlm.default_model)
        ? currentLlm.default_model
        : undefined;
    let defaultModel = flags.model;
    if (defaultModel !== undefined) {
      if (!found.models.includes(defaultModel)) {
        throw new OnboardError(
          `The server does not list "${defaultModel}". Models: ${found.models.join(", ")}`,
        );
      }
    } else if (prompting) {
      defaultModel = await pickModel(prompter, found.models, fallbackModel);
    } else {
      defaultModel = found.models.length === 1 ? found.models[0] : fallbackModel;
      if (!defaultModel) {
        throw new OnboardError(`Pass --model; the server lists: ${found.models.join(", ")}`);
      }
    }

    let access: AccessMode | undefined = flagAccess;
    if (!access && (!current.access?.mode || flags["reconfigure-access"])) {
      const apiHost = current.server?.api_host ?? env.API_HOST?.trim() ?? DEFAULT_API_HOST;
      const fallback = isOwnerNetworkHost(apiHost);
      if (prompting) {
        const open = await askYesNo(
          prompter,
          "Open straight in without a login (private network only)?",
          fallback,
        );
        access = open ? "open-owner" : "accounts";
      } else if (yes) access = fallback ? "open-owner" : "accounts";
      else if (!current.access?.mode) throw missing("--access");
    }

    const document = parseDocument(text);
    updateDocument(document, {
      baseUrl: found.baseUrl,
      models: found.models,
      defaultModel,
      key,
      access,
    });
    const next = document.toString({ flowCollectionPadding: false });
    // Validates the whole document before anything touches the disk.
    const final = parseShepherdConfig(next, file);
    writeAtomic(file, next);

    const mode = final.access?.mode ?? "accounts";
    prompter.say(
      [
        `Wrote ${file}`,
        `  server: ${found.baseUrl}`,
        `  models: ${found.models.length}, default ${defaultModel}`,
        `  key: ${key ? "set" : "none"}`,
        `  access: ${mode}`,
        "Restart Rakazo to apply the change.",
      ].join("\n"),
    );
    if (
      mode === "open-owner" &&
      !isOwnerNetworkHost(final.server?.api_host ?? env.API_HOST?.trim() ?? DEFAULT_API_HOST)
    ) {
      prompter.say(
        "Open access needs API_HOST on loopback or Tailscale; the API refuses to start otherwise.",
      );
    }
  } finally {
    prompter.close();
  }
}

function isTty(input: NodeJS.ReadableStream): boolean {
  return (input as { isTTY?: boolean }).isTTY === true;
}
