import { randomUUID } from "node:crypto";
import type { AgentRow } from "@rakazo/contracts";
import type { HerdrDiscoveryOptions } from "../node/herdr-discovery.js";
import { discoverHerdrUrl } from "../node/herdr-discovery.js";
import type { ConnectionFlags, TuiCommand } from "./args.js";
import { parseTuiArgs, TUI_USAGE } from "./args.js";
import type { ClientFile, Connection } from "./config.js";
import {
  assertPasswordTransport,
  clientFilePath,
  insecureUrlWarning,
  normalizeServerUrl,
  readClientFile,
  resolveConnection,
  writeClientFile,
} from "./config.js";
import { TuiError } from "./errors.js";
import type { Prompter } from "./prompter.js";
import { createPrompter } from "./prompter.js";
import {
  applyListFrame,
  chatLineFor,
  formatAgentEvent,
  formatAgentRow,
  formatAgentTable,
  oneLine,
} from "./render.js";
import type { FetchFn, TuiClient } from "./rpc.js";
import {
  BRIDGE_OPEN_ORIGIN,
  checkHealth,
  createTuiClient,
  explainRpcError,
  fetchCapabilities,
  openOwnerSession,
  signInWithPassword,
} from "./rpc.js";
import {
  createDetachFilter,
  createInputSequencer,
  filterTerminalInput,
  interpretFrame,
  TERMINAL_RESTORE,
} from "./terminal-io.js";

export type TuiRunOptions = {
  argv: string[];
  env: NodeJS.ProcessEnv;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  errorOutput: NodeJS.WritableStream;
  /** True when a person can answer prompts and the output is a screen. */
  interactive: boolean;
  fetch?: FetchFn;
  /** How to look for a herdr dashboard when no server URL is given; tests point it at local servers. */
  discovery?: HerdrDiscoveryOptions;
  /** Ends every follow loop; the CLI passes one tied to SIGINT. */
  signal?: AbortSignal;
};

type Context = TuiRunOptions & {
  say(text: string): void;
  warn(text: string): void;
  fetchImpl: FetchFn;
  file: string;
};

const isTty = (stream: NodeJS.ReadableStream): stream is NodeJS.ReadStream =>
  "setRawMode" in stream && typeof (stream as NodeJS.ReadStream).setRawMode === "function";

export async function runTui(options: TuiRunOptions): Promise<void> {
  const { command, flags } = parseTuiArgs(options.argv);
  const context: Context = {
    ...options,
    say: (text) => void options.output.write(`${text}\n`),
    warn: (text) => void options.errorOutput.write(`${text}\n`),
    fetchImpl: options.fetch ?? fetch,
    file: clientFilePath(options.env),
  };
  if (command.kind === "help") return context.say(TUI_USAGE);
  if (flags.token) {
    context.warn(
      "Note: --token is visible in the process list; prefer --token-stdin or SHEPHERD_TOKEN.",
    );
  }
  if (flags.tokenStdin) {
    if (command.kind === "attach" || command.kind === "chat") {
      throw new TuiError(
        "--token-stdin cannot be combined with a command that reads the keyboard.",
      );
    }
    flags.token = await readToken(options.input);
  }
  if (command.kind === "login") return login(context, flags);
  const connection = await authenticate(context, flags);
  const client = createTuiClient(connection, context.fetchImpl);
  switch (command.kind) {
    case "agents":
      return agents(context, client, command);
    case "agent":
      return agent(context, client, command.id);
    case "attach":
      return attach(context, client, command.id);
    case "chat":
      return chat(context, client, command);
  }
}

/** The first line of stdin, as a token. */
async function readToken(input: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(Buffer.from(chunk as Buffer));
  const token = Buffer.concat(chunks).toString("utf8").split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!token) throw new TuiError("--token-stdin: stdin held no token.");
  return token;
}

/** Server URL plus a token from flag, env, saved file, or an open-owner/password sign-in. */
async function authenticate(context: Context, given: ConnectionFlags): Promise<Connection> {
  const saved = readClientFile(context.file);
  const flags = await withDiscoveredUrl(context, given, saved);
  const base = resolveConnection(flags, context.env, saved);
  const warning = insecureUrlWarning(base.url);
  if (warning) context.warn(warning);
  if (base.token) return base;
  const token = await obtainToken(context, base.url, flags.email, flags.insecure === true);
  return { ...base, token };
}

/** With no URL from a flag, the environment or the saved file, a herdr dashboard on the tailnet. */
async function withDiscoveredUrl(
  context: Context,
  flags: ConnectionFlags,
  saved: ClientFile,
): Promise<ConnectionFlags> {
  if (flags.url || context.env.SHEPHERD_URL || saved.url) return flags;
  const found = await discoverHerdrUrl({ fetchImpl: context.fetchImpl, ...context.discovery });
  return found ? { ...flags, url: found } : flags;
}

async function obtainToken(
  context: Context,
  url: string,
  email: string | undefined,
  insecure: boolean,
): Promise<string> {
  if (email) return signInPrompt(context, url, email, insecure);
  const capabilities = await fetchCapabilities(url, context.fetchImpl);
  if (capabilities?.openOwner) return openOwnerSession(url, context.fetchImpl);
  const bridge = await openBridgeSession(context, url);
  if (bridge) return bridge;
  if (capabilities === null) {
    // No auth routes at all (herdr's bridge): a token is the only way in.
    throw new TuiError("No token. Pass --token, set SHEPHERD_TOKEN, or run `pnpm tui login`.");
  }
  throw new TuiError("Not signed in. Run `pnpm tui login` or pass --email or --token.");
}

/**
 * herdr's bridge opens an owner session for the `shepherd://` origin when its operator allowlisted
 * it (`open_owner_origins`); it does not advertise that as a capability. Any refusal falls back to
 * the token and password routes.
 */
async function openBridgeSession(context: Context, url: string): Promise<string | undefined> {
  try {
    return await openOwnerSession(url, context.fetchImpl, BRIDGE_OPEN_ORIGIN);
  } catch {
    return undefined;
  }
}

async function signInPrompt(
  context: Context,
  url: string,
  email: string,
  insecure: boolean,
): Promise<string> {
  if (!context.interactive) {
    throw new TuiError("Password sign-in needs a terminal; use --token or SHEPHERD_TOKEN instead.");
  }
  assertPasswordTransport(url, insecure);
  const prompter = createPrompter(context.input, context.output, true);
  try {
    const password = await prompter.askSecret(`Password for ${email}`);
    return await signInWithPassword(url, email, password, context.fetchImpl);
  } finally {
    prompter.close();
  }
}

async function login(context: Context, flags: ConnectionFlags): Promise<void> {
  const saved = readClientFile(context.file);
  const prompter = context.interactive
    ? createPrompter(context.input, context.output, true)
    : undefined;
  try {
    const rawUrl =
      flags.url || context.env.SHEPHERD_URL || saved.url || (await prompter?.ask("Server URL"));
    if (!rawUrl) throw new TuiError("No server URL. Pass --url or set SHEPHERD_URL.");
    const url = normalizeServerUrl(rawUrl);
    const warning = insecureUrlWarning(url);
    if (warning) context.warn(warning);
    if (!(await checkHealth(url, context.fetchImpl))) {
      throw new TuiError(`Cannot reach ${url}. Is the server running?`);
    }
    const token =
      flags.token ||
      context.env.SHEPHERD_TOKEN ||
      (await loginToken(context, prompter, url, flags.email, flags.insecure === true));
    const next: ClientFile = { url, token, ...(flags.space ? { space: flags.space } : {}) };
    writeClientFile(context.file, next);
    context.say(`Saved ${url} and a token to ${context.file} (owner-only).`);
  } finally {
    prompter?.close();
  }
}

async function loginToken(
  context: Context,
  prompter: Prompter | undefined,
  url: string,
  email: string | undefined,
  insecure: boolean,
): Promise<string> {
  const capabilities = await fetchCapabilities(url, context.fetchImpl);
  if (!email && capabilities?.openOwner) return openOwnerSession(url, context.fetchImpl);
  if (!email) {
    const bridge = await openBridgeSession(context, url);
    if (bridge) return bridge;
  }
  if (!prompter) {
    throw new TuiError("Nothing to sign in with. Pass --token, or run login in a terminal.");
  }
  assertPasswordTransport(url, insecure);
  const address = email || (await prompter.ask("Email"));
  const password = await prompter.askSecret(`Password for ${address}`);
  return signInWithPassword(url, address, password, context.fetchImpl);
}

async function agents(
  context: Context,
  client: TuiClient,
  command: Extract<TuiCommand, { kind: "agents" }>,
): Promise<void> {
  const rows = new Map<string, AgentRow>();
  let cursor: number;
  try {
    const list = await client.agents.list({ showOlder: command.all });
    for (const row of list.agents) rows.set(row.id, row);
    cursor = list.cursor;
    if (list.hiddenCount > 0 && !command.all) {
      context.warn(`${list.hiddenCount} older agents hidden; pass --all to show them.`);
    }
  } catch (error) {
    throw explainRpcError(error, "agents/list");
  }
  context.say(formatAgentTable(rows.values()));
  if (command.once) return;
  try {
    const stream = await client.agents.subscribeList(
      { cursor },
      context.signal ? { signal: context.signal } : {},
    );
    for await (const frame of stream) {
      // Keep-alive frames carry no row.
      if (!frame.row) continue;
      applyListFrame(rows, frame.row);
      if (context.interactive) {
        context.output.write(`\u001b[H\u001b[2J${formatAgentTable(rows.values())}\n`);
      } else {
        context.say(formatAgentRow(frame.row));
      }
    }
  } catch (error) {
    if (context.signal?.aborted) return;
    throw explainRpcError(error, "agents/subscribeList");
  }
}

async function agent(context: Context, client: TuiClient, id: string): Promise<void> {
  let rev: number;
  try {
    const head = await client.agents.get({ id });
    context.say(formatAgentRow(head.agent));
    const page = await client.agents.messages({ id });
    for (const event of [...page.events].reverse()) context.say(formatAgentEvent(event));
    rev = page.rev;
  } catch (error) {
    throw explainRpcError(error, "agents/get");
  }
  try {
    const stream = await client.agents.subscribe(
      { id, cursor: rev },
      context.signal ? { signal: context.signal } : {},
    );
    for await (const frame of stream) {
      // Keep-alive frames carry no event.
      if (frame.event) context.say(formatAgentEvent(frame.event));
    }
  } catch (error) {
    if (context.signal?.aborted) return;
    throw explainRpcError(error, "agents/subscribe");
  }
}

async function attach(context: Context, client: TuiClient, id: string): Promise<void> {
  const { input, output } = context;
  const out = output as NodeJS.WriteStream;
  const size = { rows: out.rows || 24, cols: out.columns || 80 };
  let opened: Awaited<ReturnType<TuiClient["terminal"]["open"]>>;
  try {
    opened = await client.terminal.open({ id, ...size });
  } catch (error) {
    throw explainRpcError(error, "terminal/open");
  }
  const { terminalId } = opened;
  const controller = new AbortController();
  const stop = () => controller.abort();
  context.signal?.addEventListener("abort", stop);
  const sequencer = createInputSequencer();
  const detach = createDetachFilter();
  let typing: Promise<void> = Promise.resolve();
  let inputFailed = false;
  const onData = (chunk: Buffer | string) => {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    const { forward, detach: leave } = detach.feed(filterTerminalInput(bytes));
    if (forward.length > 0) {
      for (const call of sequencer.next(forward)) {
        typing = typing.then(() =>
          client.terminal.input({ terminalId, ...call }).then(
            () => undefined,
            () => {
              if (!inputFailed) context.warn("\r\n[input was refused by the server]");
              inputFailed = true;
            },
          ),
        );
      }
    }
    if (leave) stop();
  };
  const onResize = () =>
    void client.terminal
      .resize({ terminalId, rows: out.rows || size.rows, cols: out.columns || size.cols })
      .catch(() => undefined);
  const raw = isTty(input);
  if (raw) input.setRawMode(true);
  input.on("data", onData);
  if ("resume" in input) input.resume();
  out.on?.("resize", onResize);
  let lastSeq = opened.seq - 1;
  let endMessage = "Detached.";
  try {
    const stream = await client.terminal.subscribe(
      { terminalId, cursor: opened.seq },
      { signal: controller.signal },
    );
    for await (const frame of stream) {
      const action = interpretFrame(frame, lastSeq);
      if (action.kind === "skip") continue;
      lastSeq = action.seq;
      if (action.kind === "end") {
        endMessage = action.message;
        break;
      }
      output.write(action.bytes);
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      endMessage = explainRpcError(error, "terminal/subscribe").message;
    }
  } finally {
    input.off("data", onData);
    out.off?.("resize", onResize);
    // Undo anything the remote screen switched on, then swallow what the terminal still sends
    // (mouse reports, replies) so none of it lands in the shell's prompt.
    output.write(TERMINAL_RESTORE);
    if (raw) await swallow(input, 60);
    if (raw) input.setRawMode(false);
    if ("pause" in input) input.pause();
    context.signal?.removeEventListener("abort", stop);
    stop();
    await typing;
    await client.terminal.close({ terminalId }).catch(() => undefined);
  }
  context.say(`\n[${endMessage}]`);
}

/** Reads and discards input for `ms`, so late terminal reports do not reach the shell. */
async function swallow(input: NodeJS.ReadableStream, ms: number): Promise<void> {
  const drop = () => undefined;
  input.on("data", drop);
  await new Promise((resolve) => setTimeout(resolve, ms));
  input.off("data", drop);
}

async function chat(
  context: Context,
  client: TuiClient,
  command: Extract<TuiCommand, { kind: "chat" }>,
): Promise<void> {
  const prompter = createPrompter(context.input, context.output, context.interactive);
  try {
    const botId = command.botId ?? (await pickBot(context, client, prompter));
    let cursor: number;
    try {
      cursor = (await client.threads.head({ botId })).cursor;
    } catch (error) {
      throw explainRpcError(error, "threads/head");
    }
    const controller = new AbortController();
    context.signal?.addEventListener("abort", () => controller.abort());
    const replies = await followReplies(client, botId, cursor, controller.signal);
    context.say("Type a message; /quit or end of input leaves.");
    try {
      for (;;) {
        if (context.interactive) context.output.write("> ");
        const line = await prompter.nextLine();
        const text = line?.trim();
        if (text === undefined || text === "/quit") break;
        if (!text) continue;
        try {
          await client.threads.send({ botId, text, clientNonce: randomUUID() });
        } catch (error) {
          throw explainRpcError(error, "threads/send");
        }
        for (;;) {
          const next = await replies.next();
          if (next.kind === "bot") context.say(next.text);
          else if (next.kind === "end") {
            if (next.text) context.say(next.text);
            break;
          } else break;
        }
      }
    } finally {
      controller.abort();
    }
  } finally {
    prompter.close();
  }
}

async function pickBot(context: Context, client: TuiClient, prompter: Prompter): Promise<string> {
  let bots: Awaited<ReturnType<TuiClient["bots"]["list"]>>;
  try {
    bots = await client.bots.list();
  } catch (error) {
    throw explainRpcError(error, "bots/list");
  }
  if (bots.length === 0) throw new TuiError("This server has no bots to chat with.");
  if (!context.interactive) {
    throw new TuiError("Pass --bot <id> when there is no terminal to pick from.");
  }
  bots.forEach((bot, index) => {
    context.say(`${index + 1}. ${oneLine(bot.name, 60)}  (${oneLine(bot.id, 64)})`);
  });
  const answer = await prompter.ask("Chat with number");
  const bot = bots[Number(answer) - 1];
  if (!bot) throw new TuiError(`"${answer}" is not one of the listed bots.`);
  return bot.id;
}

type Reply = { kind: "bot" | "end" | "closed"; text: string };

/** Starts the thread stream, then hands replies one at a time; resolves once subscribed. */
async function followReplies(
  client: TuiClient,
  botId: string,
  cursor: number,
  signal: AbortSignal,
): Promise<{ next(): Promise<Reply> }> {
  let stream: Awaited<ReturnType<TuiClient["threads"]["subscribe"]>>;
  try {
    stream = await client.threads.subscribe({ botId, cursor }, { signal });
  } catch (error) {
    throw explainRpcError(error, "threads/subscribe");
  }
  const queue: Reply[] = [];
  let waiting: ((reply: Reply) => void) | undefined;
  const push = (reply: Reply) => {
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(reply);
    } else queue.push(reply);
  };
  void (async () => {
    try {
      for await (const event of stream) {
        const line = chatLineFor(event);
        if (line.kind !== "ignore") push(line);
      }
    } catch {
      // aborted on exit, or the stream dropped; either way the waiting turn is released
    }
    push({ kind: "closed", text: "[connection closed]" });
  })();
  return {
    next: () => {
      const buffered = queue.shift();
      if (buffered) return Promise.resolve(buffered);
      return new Promise<Reply>((resolve) => {
        waiting = resolve;
      });
    },
  };
}
