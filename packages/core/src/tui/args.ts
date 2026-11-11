import { parseArgs } from "node:util";
import { TuiError } from "./errors.js";

export const TUI_USAGE = `Usage: pnpm tui <command> [options]
  login                       sign in and remember the server (url + token) in the client file
  agents [--all] [--once]     list agents and follow live changes (--once prints and exits)
  agent <id>                  show an agent's events and follow new ones
  attach <id>                 attach to an agent's terminal (detach: Ctrl-] then q)
  chat [--bot <id>]           talk to a bot (pick from a list when --bot is omitted)
Options:
  --url <base-url>            server base URL (env SHEPHERD_URL)
  --token <token>             bearer token (env SHEPHERD_TOKEN); visible in the process list
  --token-stdin               read the token from stdin (safer than --token)
  --insecure                  allow a password over plain http to a non-loopback host
  --email <address>           sign in with email + password (password is prompted, not echoed)
  --space <id>                space id sent as x-rakazo-space-id (env SHEPHERD_SPACE)
Agents and terminal are served by herdr's bridge; a Shepherd server answers "not found" for them.`;

export type ConnectionFlags = {
  url?: string;
  token?: string;
  /** Read the token from the first line of stdin instead of the command line. */
  tokenStdin?: boolean;
  /** Allow a password over plain http to a non-loopback host. */
  insecure?: boolean;
  email?: string;
  space?: string;
};

export type TuiCommand =
  | { kind: "help" }
  | { kind: "login" }
  | { kind: "agents"; all: boolean; once: boolean }
  | { kind: "agent"; id: string }
  | { kind: "attach"; id: string }
  | { kind: "chat"; botId?: string };

export type ParsedTuiArgs = { command: TuiCommand; flags: ConnectionFlags };

/** Pure: argv (after `tui`) to a typed command. Throws TuiError with the usage on bad input. */
export function parseTuiArgs(argv: readonly string[]): ParsedTuiArgs {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    throw new TuiError(`${(error as Error).message}\n${TUI_USAGE}`);
  }
  const { values, positionals } = parsed;
  const flags: ConnectionFlags = {};
  if (values.url) flags.url = values.url;
  if (values.token) flags.token = values.token;
  if (values.insecure) flags.insecure = true;
  if (values["token-stdin"]) flags.tokenStdin = true;
  if (values.email) flags.email = values.email;
  if (values.space) flags.space = values.space;
  const [name, id, ...rest] = positionals;
  if (values.token && values["token-stdin"]) {
    throw new TuiError(`Use either --token or --token-stdin, not both.\n${TUI_USAGE}`);
  }
  if (values.help || name === undefined || name === "help") {
    return { command: { kind: "help" }, flags };
  }
  const extra = rest.length > 0;
  const needId = (): string => {
    if (!id || extra) throw new TuiError(`"${name}" takes exactly one agent id.\n${TUI_USAGE}`);
    return id;
  };
  switch (name) {
    case "login":
      return { command: { kind: "login" }, flags };
    case "agents":
      return {
        command: { kind: "agents", all: values.all === true, once: values.once === true },
        flags,
      };
    case "agent":
      return { command: { kind: "agent", id: needId() }, flags };
    case "attach":
      return { command: { kind: "attach", id: needId() }, flags };
    case "chat":
      return {
        command: values.bot ? { kind: "chat", botId: values.bot } : { kind: "chat" },
        flags,
      };
    default:
      throw new TuiError(`Unknown command "${name}".\n${TUI_USAGE}`);
  }
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      url: { type: "string" },
      token: { type: "string" },
      "token-stdin": { type: "boolean" },
      insecure: { type: "boolean" },
      email: { type: "string" },
      space: { type: "string" },
      bot: { type: "string" },
      all: { type: "boolean" },
      once: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
}
