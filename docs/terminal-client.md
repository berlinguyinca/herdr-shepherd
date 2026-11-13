# Terminal client

`pnpm tui` (or `shepherd tui`) is a terminal client for the oRPC contract. It runs inside any terminal, including a herdr pane, and talks to either a Shepherd server (this repo's `apps/api`) or herdr's bridge, which serves the same contract over plain oRPC JSON.

```sh
pnpm tui                                          # full-screen view (in a terminal); same as `pnpm tui ui`
pnpm tui login --url http://127.0.0.1:3100        # saves url + token (owner-only file)
pnpm tui agents [--all] [--once]                  # list, then follow live changes
pnpm tui agent <id>                               # history, then live events
pnpm tui attach <id>                              # terminal; detach with Ctrl-] then q
pnpm tui chat [--bot <id>]                        # talk to a bot; /quit leaves
```

## Full-screen view

A sidebar lists rooms, agents (most urgent first) and bots; the main pane shows the selected item's history and follows it live. Keys: `↑ ↓` move, `Tab` switches pane, `Enter` or `n` writes, `a` attaches to an agent or answers a room's open question, `c` chats with a bot, `r` reloads, `?` shows help, `q` quits.

- Messages to a room or bot go out at once. A message to an agent is sent to its bot id and always asks you to confirm first; if the bridge cannot message agents, the text is typed into its terminal instead and the status line says so.
- A room's open question shows above the input. Only the operator can answer it; other accounts get a plain "not allowed" line.

## Connection

The server URL, token and space come from, in order: flags (`--url`, `--token`, `--space`), the environment (`SHEPHERD_URL`, `SHEPHERD_TOKEN`, `SHEPHERD_SPACE`), then `~/.config/shepherd/client.json` (mode 0600, written by `login`; `SHEPHERD_CLIENT_FILE` overrides the path). Tokens are never printed or logged. Only `http(s)` URLs are accepted; plain `http` to a host outside loopback and Tailscale prints a warning.

With no token the client signs in for you where it can:

- Open-owner servers: `POST /api/auth/open` with the server's own origin. The server only allows this from loopback or Tailscale with an allowed origin; if it refuses, pass `--token` or `--email`.
- herdr's bridge allows one passwordless open per address every 30 seconds and each open retires the oldest session, so the session is kept in the client file (owner-only, never printed) and reused until the bridge refuses it, then opened once more. The assistant's herdr connector shares it. On a rate limit of 30 seconds or less the client waits and retries once.
- Accounts servers: `--email you@example.com` prompts for the password without echo (needs a terminal).
- Otherwise: `--token` / `SHEPHERD_TOKEN`.

## What each server serves

| Command                     | Shepherd `apps/api`             | herdr bridge                 |
| --------------------------- | ------------------------------- | ---------------------------- |
| `agents`, `agent`, `attach` | not served (the client says so) | yes                          |
| `chat`                      | yes (`bots/list`, `threads/*`)  | if the bridge serves threads |

`attach` sends keystrokes as numbered base64 calls (`n` from 1, in order, at most 32 KB each) and repaints every frame as a whole screen after a clear.

Not yet: reconnect after a dropped stream, copy mode or scrollback in `attach`, attachments and mentions in `chat`.

## Security notes

- **Saved credentials are per server.** The token and space in the client file are used only when the
  resolved server URL equals the URL they were saved for. A `--url`/`SHEPHERD_URL` pointing elsewhere
  never receives them; a `--token` flag or `SHEPHERD_TOKEN` env token is always honored.
- **Tokens.** Prefer `SHEPHERD_TOKEN` or `--token-stdin` (reads the first line of stdin; not valid for
  `attach`/`chat`, which need stdin). `--token <value>` works but prints a warning because the value
  is visible in the process list.
- **Passwords over plain http** are refused unless the host is loopback, or `--insecure` is passed.
  Tailnet hosts (`*.ts.net`, `100.64.0.0/10`, `fd7a:115c:a1e0::/48`) get no "unencrypted" warning
  because WireGuard encrypts the path, but a password is still refused over plain http to them: the
  100.64/10 block is the shared CGNAT range and is not necessarily a tailnet, so `--insecure` is the
  explicit opt-in.
- **Redirects are never followed** on sign-in, open-owner and capability requests.
- **Remote text is sanitized** (escape sequences, control, bidi and zero-width characters), and
  single-line fields are flattened.
- **`attach` filters terminal output**: all OSC (clipboard, titles, 1337, 7), DCS/APC/PM/SOS, 8-bit C1
  controls and terminal queries (DSR, DA, DECRQM, XTVERSION, window reports) are dropped; replies are
  never forwarded as input. On exit the terminal modes are reset and pending stdin is discarded.
- **Client file**: written with a random temp name (`wx`, mode 0600), its directory tightened to 0700,
  and a symlinked client file is refused.
