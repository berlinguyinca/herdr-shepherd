# Re-create the local Shepherd dashboard

```
export SHEPHERD_LLM_API_KEY=...      # optional; omit and run `shepherd onboard` instead
export SHEPHERD_HERDR_TOKEN=...      # optional; a placeholder is written otherwise
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

The bearer token is not static. Sign in once with `shepherd tui login --url http://100.104.39.6 --email <you>` (asks for the
password) and put the token in `shepherd.yaml` or `SHEPHERD_HERDR_TOKEN`. It expires (`token_ttl_days`, 30 by default).
The passwordless `/api/auth/open` route only answers the iPhone app's origin, so it is not an option here.

Shepherd accepts the `herdr:` block only with `access.mode: open-owner`, and only for http to loopback or Tailscale.
