import { randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
  /** The bridge session this computer opened last, shared by the TUI and the assistant connector. */
  bridgeSession: z.object({ url: z.string(), token: z.string() }).optional(),
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

function refuseSymlink(file: string): void {
  try {
    if (lstatSync(file).isSymbolicLink()) {
      throw new TuiError(`${file} is a symlink; remove it so the token is not written elsewhere.`);
    }
  } catch (error) {
    if (error instanceof TuiError) throw error;
  }
}

export function readClientFile(file: string): ClientFile {
  refuseSymlink(file);
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

/**
 * Atomic, owner-only write (the file holds a token). The directory is made 0700 (and tightened if
 * it is ours and looser), the temp file is created exclusively with a random name so nothing at
 * that path is followed, and a symlinked client file is refused.
 */
export function writeClientFile(file: string, value: ClientFile): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = statSync(dir);
  if ((info.mode & 0o077) !== 0 && info.uid === process.getuid?.()) chmodSync(dir, 0o700);
  refuseSymlink(file);
  const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
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

function isLoopbackHost(hostname: string): boolean {
  const bare = hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  return bare === "localhost" || bare === "::1" || /^127(\.\d{1,3}){3}$/.test(bare);
}

/**
 * Hosts where plain http is not warned about: loopback, `*.ts.net`, and the Tailscale address
 * ranges. 100.64.0.0/10 is also carrier-grade NAT and cannot be told apart from Tailscale by
 * address, so it is treated as Tailscale; the warning is only advice, the password rule below
 * is stricter.
 */
function isTrustedPlainHost(hostname: string): boolean {
  return hostname.toLowerCase().endsWith(".ts.net") || isOwnerNetworkHost(hostname);
}

/** A warning line when a token would cross the network in clear text, else undefined. */
export function insecureUrlWarning(url: string): string | undefined {
  const parsed = new URL(url);
  if (parsed.protocol === "https:" || isTrustedPlainHost(parsed.hostname)) return undefined;
  return `Warning: ${parsed.host} is plain http outside loopback and Tailscale; anyone on the path can read your token. Prefer https.`;
}

/** A password only goes over https or to this computer, unless `--insecure` says otherwise. */
export function assertPasswordTransport(url: string, insecure: boolean): void {
  const parsed = new URL(url);
  if (insecure || parsed.protocol === "https:" || isLoopbackHost(parsed.hostname)) return;
  throw new TuiError(
    `Refusing to send a password over plain http to ${parsed.host}. Use https, or pass --insecure.`,
  );
}

/**
 * Flags win over environment, which wins over the saved client file. The file's token and space
 * belong to the file's server: they are used only when the resolved URL is that same server, so
 * `--url other` never sends the saved token there. A token from a flag or env is always allowed.
 */
export function resolveConnection(
  flags: ConnectionFlags,
  env: NodeJS.ProcessEnv,
  file: ClientFile,
): Connection {
  const raw = flags.url || env.SHEPHERD_URL || file.url;
  if (!raw) {
    throw new TuiError("No server URL. Pass --url, set SHEPHERD_URL, or run `pnpm tui login`.");
  }
  const url = normalizeServerUrl(raw);
  const sameServer = file.url !== undefined && safeNormalize(file.url) === url;
  const token = flags.token || env.SHEPHERD_TOKEN || (sameServer ? file.token : undefined);
  const space = flags.space || env.SHEPHERD_SPACE || (sameServer ? file.space : undefined);
  return { url, ...(token ? { token } : {}), ...(space ? { space } : {}) };
}

function safeNormalize(raw: string): string | undefined {
  try {
    return normalizeServerUrl(raw);
  } catch {
    return undefined;
  }
}
