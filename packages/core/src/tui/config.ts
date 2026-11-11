import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { isOwnerNetworkHost } from "../node/owner-network.js";
import type { ConnectionFlags } from "./args.js";
import { TuiError } from "./errors.js";

const ClientFileSchema = z.object({
  url: z.string().optional(),
  token: z.string().optional(),
  space: z.string().optional(),
});
export type ClientFile = z.infer<typeof ClientFileSchema>;

export type Connection = {
  /** Base URL without a trailing slash; only http or https, no embedded login. */
  url: string;
  token?: string;
  space?: string;
};

/** `~/.config/shepherd/client.json`, or under `XDG_CONFIG_HOME`; `SHEPHERD_CLIENT_FILE` overrides. */
export function clientFilePath(env: NodeJS.ProcessEnv): string {
  if (env.SHEPHERD_CLIENT_FILE) return env.SHEPHERD_CLIENT_FILE;
  const base = env.XDG_CONFIG_HOME || path.join(env.HOME || homedir(), ".config");
  return path.join(base, "shepherd", "client.json");
}

export function readClientFile(file: string): ClientFile {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = ClientFileSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** Atomic write, owner-only (the file holds a token). */
export function writeClientFile(file: string, value: ClientFile): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

/** `<base>` without trailing slash; only http and https, no embedded login, no path query. */
export function normalizeServerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new TuiError(`"${raw.trim()}" is not a URL; use http:// or https://.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TuiError("The server URL must start with http:// or https://.");
  }
  if (url.username || url.password) {
    throw new TuiError("Leave credentials out of the URL; use --token or the sign-in prompt.");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

/** A warning line when a token would cross the network in clear text, else undefined. */
export function insecureUrlWarning(url: string): string | undefined {
  const parsed = new URL(url);
  if (parsed.protocol === "https:") return undefined;
  if (isOwnerNetworkHost(parsed.hostname)) return undefined;
  return `Warning: ${parsed.host} is plain http outside loopback and Tailscale; anyone on the path can read your token. Prefer https.`;
}

/** Flags win over environment, which wins over the saved client file. */
export function resolveConnection(
  flags: ConnectionFlags,
  env: NodeJS.ProcessEnv,
  file: ClientFile,
): Connection {
  const raw = flags.url || env.SHEPHERD_URL || file.url;
  if (!raw) {
    throw new TuiError("No server URL. Pass --url, set SHEPHERD_URL, or run `pnpm tui login`.");
  }
  const token = flags.token || env.SHEPHERD_TOKEN || file.token;
  const space = flags.space || env.SHEPHERD_SPACE || file.space;
  return {
    url: normalizeServerUrl(raw),
    ...(token ? { token } : {}),
    ...(space ? { space } : {}),
  };
}
