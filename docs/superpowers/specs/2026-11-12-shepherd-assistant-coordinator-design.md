# Shepherd: a single assistant coordinator on the tailnet

## Intent and why

Gert wants to coordinate a few assistants from the iPhone and give them work. A standalone install of the
Shepherd iOS app (`apps/mobile`, bundle `com.berlinguyinca.shepherd`) showed a sign-in screen. Expectation:
no sign-in, because the phone and the Herdr fabric share a tailnet; one default assistant in front that
assigns roles and tasks; the assistants handle rooms, agents and sessions themselves.

## What already exists (audited 2026-11-12; reuse, do not rebuild)

- **Server for the app:** the Rakazo mobile bridge in the Herdr control plane
  (`herdr-cargo-cache-host` / `herdr-engineering`, `control_plane/rakazo_bridge.py`, `rakazo_bots.py`,
  `rakazo_agents.py`, `rakazo_terminal.py`). It implements `/rpc/*` and `/api/auth/*`. The Node `apps/api`
  in this repo is the stock Rakazo server and is not the one in use.
- **No login:** the bridge's `open_owner` (`POST /api/auth/open`) mints an owner session with no password
  for callers on tailnet addresses (100.64.0.0/10) and the app origins `rakazo://`, `shepherd://`. It is
  enabled on bender (`open_owner: true`, `trusted_proxies: [100.104.39.6]`). The app already tries it first
  (`openOwnerSession`, `lib/api.ts`; `app/sign-in.tsx`) and only shows the password form if it fails.
- **Endpoint:** the gateway apex `https://local.metabolomics.us` already forwards every path, including
  `/rpc` and `/api/auth`, to the control plane, and works from any tailnet device. The sign-in screen
  appeared because the install was not pinned to it: the app fell back to `http://127.0.0.1:3100`.
- **Assistants:** bots create, list, get, update, pin and archive; chat screen and send path
  (`threads/send`, `/thread`); the full app has the screens for them.
- **Status data:** `agents.list` / `agents.subscribeList` (status blocked, done, working, idle, unknown,
  closed, plus a one-line summary) and `runs.list` (which assistant runs which prompt).
- **Roles and tasks:** team roles and tasks exist in the control plane (`collab_team_roles.py`,
  `team_tasks.py`, tickets, proposals, approvals); coordinators assign by role.
- **Terminal view** (`terminal/*`) for a later "show me" link.

## Goals

1. Opening Shepherd shows the default assistant chat immediately. No sign-in, no server prompt.
2. Gert can tell the default assistant what to do and which assistant does what; the assistant assigns
   roles and tasks using Herdr's existing tools.
3. A small status strip on the same screen shows which assistants are working and on what.
4. Gert can create assistants, mark one as the default, and switch between them.
5. The build is pinned to `https://local.metabolomics.us`.
6. Only Gert's own tailnet devices can obtain the no-login session (see "Security").

## Non-goals

- No rooms, tabs, pane drawer or session list; no multi-host switching; no accounts or sign-up.
- No Herdr remote, no per-host trust rollout, no new auth mode in the Rakazo server.
- No terminal view in v1.

## Anti-goals

- Anything reachable from outside the tailnet, or by a shared-in guest node, being able to act as owner.
- Forged `rakazo://` origins or bridge session tokens. Never allowed.
- Renaming server-side config: it keeps its `rakazo_*` names.
- Rebuilding anything in "What already exists".

## What is truly new

1. **Default assistant.** A per-bot flag (for example a bot-meta `isDefault` key, like the existing
   `pinned`) plus a `default` field in the bots listing and a way to set it. At most one default.
2. **Single-chat build flag** in the shared `apps/mobile` app. When on: the root route opens the default
   assistant's chat; the home tabs, settings, server and sign-in screens are not reachable; the brief
   detour through `/sign-in` is skipped. Reversible; the full app must keep working with the flag off.
3. **Switch and create UI** inside that one screen (a small picker), reusing `bots/create` and
   `bots/list`. Optional role/name field on create (today every new bot is "New Bot").
4. **Status strip** over `agentListQuery` and `runs/list`.
5. **Offline state:** "can't reach the assistant" with a retry button.
6. **Security hardening** (config, not code): `open_owner` trusts any address in 100.64.0.0/10, and the
   gateway has no `--allow-user` / `--allow-tag`, so a shared-in guest node could mint an owner session.
   Turn on the gateway's existing `AccessPolicy` (`fabric_access.py`) for Gert's tailnet user. Confirm
   first that the control plane sees the real client address through the gateway (`trusted_proxies`).

## Left to the builder

- Where the default flag lives and how the strip filters to assistants the default assistant assigned
  (no existing field carries that; fall back to showing all active assistants if it is not cheap).
- How the Herdr checkout behind bender is updated; the local `herdr-engineering` checkout is 535 commits
  behind origin/main, so read origin/main.
- Test layers per the repo rules (unit, integration, smoke, E2E; no mocks). The E2E for the phone UI runs
  on a simulator against a real endpoint, plus a manual check on the iPhone.

## Delivery

Release build only (Debug needs a Metro server). Signing works only through the running Xcode GUI (CLI
`xcodebuild` reports "No Accounts"); see memory note `xcode-apple-id-signed-in`. Never commit
`DEVELOPMENT_TEAM`.

## Decided by Gert

- Single, simple interface: chat with the default assistant, assign roles and tasks; the assistants
  handle rooms and sessions themselves.
- Create assistants, set one as the default, switch between them.
- Do not worry about hosts and do not build a Herdr remote.
- Do not rebuild what exists.

## My calls (to check)

- Default assistant starts as the existing first bot; no new assistant is created by the build.
- Pin the fabric name, not an IP.
- Offline state with retry.
- Security hardening via the gateway allow-list rather than new code.
