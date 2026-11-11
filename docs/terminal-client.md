# Terminal client

`pnpm tui` (or `shepherd tui`) is a terminal client for the oRPC contract. It runs inside any terminal, including a herdr pane, and talks to either a Shepherd server (this repo's `apps/api`) or herdr's bridge, which serves the same contract over plain oRPC JSON.

```sh
pnpm tui login --url http://127.0.0.1:3100        # saves url + token (owner-only file)
pnpm tui agents [--all] [--once]                  # list, then follow live changes
pnpm tui agent <id>                               # history, then live events
pnpm tui attach <id>                              # terminal; detach with Ctrl-] then q
pnpm tui chat [--bot <id>]                        # talk to a bot; /quit leaves
```

## Connection

The server URL, token and space come from, in order: flags (`--url`, `--token`, `--space`), the environment (`SHEPHERD_URL`, `SHEPHERD_TOKEN`, `SHEPHERD_SPACE`), then `~/.config/shepherd/client.json` (mode 0600, written by `login`; `SHEPHERD_CLIENT_FILE` overrides the path). Tokens are never printed or logged. Only `http(s)` URLs are accepted; plain `http` to a host outside loopback and Tailscale prints a warning.

With no token the client signs in for you where it can:

- Open-owner servers: `POST /api/auth/open` with the server's own origin. The server only allows this from loopback or Tailscale with an allowed origin; if it refuses, pass `--token` or `--email`.
- Accounts servers: `--email you@example.com` prompts for the password without echo (needs a terminal).
- Otherwise: `--token` / `SHEPHERD_TOKEN`.

## What each server serves

| Command | Shepherd `apps/api` | herdr bridge |
| --- | --- | --- |
| `agents`, `agent`, `attach` | not served (the client says so) | yes |
| `chat` | yes (`bots/list`, `threads/*`) | if the bridge serves threads |

`attach` sends keystrokes as numbered base64 calls (`n` from 1, in order, at most 32 KB each) and repaints every frame as a whole screen after a clear.

Not yet: reconnect after a dropped stream, copy mode or scrollback in `attach`, attachments and mentions in `chat`.
