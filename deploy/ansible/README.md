# Re-create the local Shepherd dashboard

```
export SHEPHERD_LLM_API_KEY=...      # optional; omit and run `shepherd onboard` instead
export SHEPHERD_HERDR_TOKEN=...      # optional; blank: no token written, nothing needed
ansible-playbook deploy/ansible/shepherd-local.yml
shepherd                             # start by hand; nothing autostarts
```

The play clones the fork, installs the `shepherd` / `shepherd-dev` launchers into `~/.local/bin`, writes a
`chmod 600` `shepherd.yaml` (never overwritten once it exists; set `-e shepherd_overwrite_config=true` to redo it) and runs
`pnpm install`. It does not start Docker or Shepherd and installs no launchd job or login item. Prerequisites: Docker,
and pnpm + node under `~/.local/share/shepherd-dev/bin`.

## The herdr bridge (not part of this play)

The assistant reads and types into herdr agents through the herdr control plane's Rakazo bridge on **bender**
(`http://100.104.39.6`, the `herdr-cp-web` container, port 80). It is configured in bender's
`~/.config/herdr-engineering/fleet-config.yaml` under `control_plane.rakazo_bridge` (`enabled: true`, `open_owner: true`,
an operator account whose `password_scrypt` comes from `herdr-eng bridge hash-password`). That file lives on bender, not in a repo.

With `access.mode: open-owner` and no token, Shepherd finds the herdr dashboard among your Tailscale peers itself
(`RAKAZO_HERDR_DISCOVER=off` disables that) and opens an owner session: `POST /api/auth/open` with `Origin: shepherd://`,
keeping the token in memory and re-opening once on a 401. No login, token or config is needed. The bridge must list
`shepherd://` (and `rakazo://`) in `open_owner_origins`, and allows one open per 30 s per address (Shepherd fails the tool
call on a 429 instead of waiting). Run `pnpm tui` or `shepherd tui` for the full-screen TUI. Only to pin a host or use a
token, sign in with `shepherd tui login --url <bridge url> --email <you>` and put the token in `shepherd.yaml` or
`SHEPHERD_HERDR_TOKEN` (it expires, `token_ttl_days`, 30 by default); a configured token is used as is and no open call is made.

Shepherd accepts the `herdr:` block only with `access.mode: open-owner`, and only for http to loopback or Tailscale. Without a `herdr:` block (and access.mode open-owner) Shepherd finds the dashboard among your Tailscale peers itself; the bridge only needs `shepherd://` in `open_owner_origins`.
