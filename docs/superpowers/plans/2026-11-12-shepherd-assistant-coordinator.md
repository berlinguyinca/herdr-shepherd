# Shepherd Assistant Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shepherd opens straight into a chat with a default assistant (no sign-in), shows a status strip, and lets Gert create assistants, set the default, and switch.

**Architecture:** Reuse the Herdr control plane's Rakazo bridge (`open_owner`, `bots/*`, `agents/list`, `runs/list`) and the existing thread screen. Add one boolean (`isDefault`) end to end (server meta, contract, app), a build flag (`EXPO_PUBLIC_SINGLE_CHAT`) that swaps the root route for a single-chat screen, and a gateway access config.

**Tech Stack:** Expo/React Native + TypeScript (vitest, Biome, Maestro) in this repo; Python (pytest, ruff) in `herdr-engineering`.

**Spec:** `docs/superpowers/specs/2026-11-12-shepherd-assistant-coordinator-design.md`

## Repos and branches

- **App (A):** this repo, branch `feat/shepherd-assistant-coordinator` (exists). `M` = `apps/mobile`, `C` = `packages/contracts/src`.
- **Server (S):** `/Users/wohlgemuth/IdeaProjects/herdr-engineering`, new branch `feat/rakazo-default-assistant` created from `origin/main` (the local main is 535 commits behind; use a worktree, never commit to main). Server files are under `herdr_engineering/control_plane/`.

## Global Constraints

- Server-side config keeps `rakazo_*` names; never forge `rakazo://` origins or bridge session tokens.
- Pin the fabric name `https://local.metabolomics.us`, never an IP.
- Flag off = the full app behaves exactly as today.
- TypeScript strict, no `any`; new tests use real code paths (no mocks). Where existing mobile component tests mock `react-native`/`expo-router` (e.g. `M/lib/home-route.test.tsx`), keep logic in pure functions tested directly and cover wiring with the server integration and Maestro tests.
- Never commit `DEVELOPMENT_TEAM`; `M/ios/` is gitignored.
- Lint/typecheck: `pnpm lint`, `pnpm --filter @rakazo/mobile check`; server `ruff check`.

## Review Focus

1. Two bots both marked default (concurrent or repeated `bots/update`): exactly one stays default.
2. Archiving or removing the default assistant: the app must fall back to the first live bot, not a blank screen.
3. Zero assistants (fresh server): the app offers "Create assistant" instead of an empty chat.
4. Server unreachable or `open_owner` refused at launch: "can't reach the assistant" with retry, never a sign-in form or a crash loop.
5. Older server without `isDefault` in `bots/list`: the contract default (`false`) keeps parsing and the first bot is used.

---

### Task 1: Server — `isDefault` bot meta with single-default enforcement (S)

**Files:**
- Modify: `herdr_engineering/control_plane/rakazo_bots.py` (`_META` whitelist ~:18-35, `update()` ~:82-122, `duplicate` exclusion ~:181)
- Modify: `herdr_engineering/control_plane/rakazo_events.py` (`bot_view` defaults, `_SPACE_BOT_KEYS`)
- Test: `tests/control_plane/test_rakazo_bots.py`

**Interfaces:**
- Produces: `bots/update {botId, isDefault: bool}` sets the flag; `bots/list` and `bots/get` always include `isDefault: bool`; setting `true` clears it on every other bot of the same space; `duplicate` never copies it.

- [ ] **Step 1: Write failing tests** (use fixtures `srv`, `alice`, `new_bot`)
  - `test_update_sets_default_and_clears_previous`: create bots a,b; update a `isDefault=True`, then b `isDefault=True`; `bots/list` shows only b with `isDefault` true.
  - `test_list_includes_isdefault_false_by_default`.
  - `test_update_rejects_non_bool_isdefault`: `isDefault="yes"` → 400 `BAD_REQUEST`.
  - `test_duplicate_does_not_copy_isdefault`.
  - `test_archive_default_leaves_no_default_listed`: archived bot no longer appears in `bots/list`.
- [ ] **Step 2:** Run `pytest tests/control_plane/test_rakazo_bots.py -k default -v`; expect FAIL.
- [ ] **Step 3:** Add `"isDefault": lambda v: isinstance(v, bool)` to `_META`; in `update()`, after a valid `isDefault is True`, iterate `self.prefs.items(account, space, META_KIND)` (as `sections_remove` does) and write `isDefault=False` on the others; add `"isDefault": False` to `bot_view`; add `isDefault` to `_SPACE_BOT_KEYS`; add it to `duplicate`'s excluded keys next to `archivedAt` and `pinned`.
- [ ] **Step 4:** Run `pytest tests/control_plane/test_rakazo_bots.py tests/control_plane/test_rakazo_bridge.py tests/control_plane/test_rakazo_contract.py -v`; expect PASS. If the contract test fails on the new field, update `tests/control_plane/fixtures/rakazo_contract.json` via `scripts/rakazo_contract_export.ts` output (additive field only).
- [ ] **Step 5:** `ruff check`, commit `feat(rakazo): isDefault bot flag with single-default enforcement`.

### Task 2: Contract — `isDefault` in the shared schemas (A)

**Files:**
- Modify: `C/domain.ts` (`BotSchema` :92-145, `UpdateBotInput`, `SpaceBotSchema` pick)
- Test: `C/domain.test.ts` (create if absent, vitest picks up `packages/*/src/**/*.test.ts`)

**Interfaces:**
- Produces: `BotSchema.isDefault: boolean` (default `false`), `UpdateBotInput.isDefault?: boolean`.

- [ ] **Step 1: Write failing tests:** `BotSchema.parse` of a bot without `isDefault` yields `isDefault === false`; `UpdateBotInput.parse({botId, isDefault:true})` keeps `isDefault`.
- [ ] **Step 2:** `pnpm exec vitest run packages/contracts` → FAIL.
- [ ] **Step 3:** Add `isDefault: z.boolean().default(false)` to `BotSchema`, `isDefault: z.boolean().optional()` to `UpdateBotInput`, include it in the `SpaceBotSchema` pick.
- [ ] **Step 4:** Tests PASS; `pnpm --filter @rakazo/mobile check` passes (watch for exhaustive object literals of `Bot` in fixtures).
- [ ] **Step 5:** Commit `feat(contracts): isDefault on bots`.

### Task 3: Default-assistant selection and single-chat flag (A)

**Files:**
- Create: `M/lib/default-assistant.ts`
- Modify: `M/lib/server-config.ts` (add flag next to `personalServerOnly`, :6)
- Test: `M/lib/default-assistant.test.ts`

**Interfaces:**
- Produces: `singleChatOnly(): boolean` (`process.env.EXPO_PUBLIC_SINGLE_CHAT === "true"`);
  `pickDefaultBot(bots: readonly Bot[]): Bot | null` — the bot with `isDefault` that is not archived; else the first non-archived bot; else `null`.

- [ ] **Step 1: Write failing tests:** default present → returned; two flagged → first flagged; flagged but archived → falls back to first live; empty → `null`; `singleChatOnly()` false when unset, true when `"true"`.
- [ ] **Step 2:** `pnpm exec vitest run apps/mobile/lib/default-assistant.test.ts` → FAIL.
- [ ] **Step 3:** Implement the two functions as specified.
- [ ] **Step 4:** PASS, `pnpm lint`, `pnpm --filter @rakazo/mobile check`.
- [ ] **Step 5:** Commit `feat(mobile): default-assistant selection and single-chat flag`.

### Task 4: Single-chat root route with silent session and offline state (A)

**Files:**
- Create: `M/components/single-chat/single-chat-home.tsx`, `M/lib/single-chat-state.ts`
- Modify: `M/app/index.tsx` (`HomeRoute` :115: when `singleChatOnly()`, return `<SingleChatHome/>` before the tab bar and the `/sign-in` redirect at :783); `M/app/_layout.tsx` (no new routes)
- Test: `M/lib/single-chat-state.test.ts`

**Interfaces:**
- Consumes: `singleChatOnly`, `pickDefaultBot` (Task 3), `openOwnerSession`, `loadSessionToken`, `rpc("bots/list")`.
- Produces: `type SingleChatState = {kind:"connecting"} | {kind:"offline"; retry: () => void} | {kind:"empty"} | {kind:"ready"; bot: Bot}` and `resolveSingleChat(deps)` pure reducer over `(hasSession, openOwnerResult, bots)`. `SingleChatHome` renders: connecting → spinner; offline → "Can't reach the assistant" + Retry; empty → "Create assistant" (Task 5); ready → the existing thread screen component `M/components/thread/thread-screen.tsx` with `botId`.

- [ ] **Step 1: Write failing tests** for `resolveSingleChat`: no session + open ok + bots → ready; open fails (network) → offline; open refused → offline; session present + empty list → empty; archived default only → empty.
- [ ] **Step 2:** FAIL. **Step 3:** implement reducer and component; on mount, if no session call `openOwnerSession()` (once), then `rpc("bots/list")`. Never navigate to `/sign-in` or `/server` in this mode. **Step 4:** PASS + typecheck.
- [ ] **Step 5:** Commit `feat(mobile): single-chat home with silent session and offline state`.

### Task 5: Assistant picker — create, set default, switch (A)

**Files:**
- Create: `M/components/single-chat/assistant-picker.tsx`, `M/lib/assistant-actions.ts`
- Modify: `M/components/single-chat/single-chat-home.tsx` (header button opens the picker)
- Test: `M/lib/assistant-actions.test.ts`

**Interfaces:**
- Produces: `createAssistant(name: string, role?: string): Promise<Bot>` (`rpc("bots/create", {name, instructions: role ?? "", notifyOnFinish:true, computerMode:"team"})`), `setDefaultAssistant(botId: string): Promise<void>` (`rpc("bots/update", {botId, isDefault:true})`); the picker lists live bots, marks the default, and switching changes the chat's `botId` locally without changing the default.

- [ ] **Step 1: Write failing tests** against a real bridge started by the server test harness is not available from vitest, so test the request shaping: `createAssistant("Ops","runs deploys")` builds `bots/create` input with name and instructions; empty name rejected; `setDefaultAssistant` builds `{botId, isDefault:true}`.
- [ ] **Step 2–4:** FAIL → implement → PASS + typecheck.
- [ ] **Step 5:** Commit `feat(mobile): assistant picker with create, default and switch`.

### Task 6: Status strip (A)

**Files:**
- Create: `M/components/single-chat/status-strip.tsx`, `M/lib/status-strip.ts`
- Test: `M/lib/status-strip.test.ts`

**Interfaces:**
- Consumes: `agentListQuery(false)` (`M/lib/agents.ts:54`), `fetchSpaceActivity()` (`M/lib/activity.ts`).
- Produces: `summarizeStatus(agents, runs): {name: string; state: "working"|"blocked"|"done"|"idle"; line: string}[]` showing active assistants only, at most 3 rows plus "+N more"; hidden when none are working or blocked. Strip is read-only.

- [ ] **Step 1: Write failing tests:** idle/closed excluded; blocked sorted first; one-line summary truncated to 60 chars; 5 working → 3 rows + "+2 more"; `AgentsUnsupportedError` → strip hidden, no crash.
- [ ] **Step 2–4:** FAIL → implement → PASS + typecheck.
- [ ] **Step 5:** Commit `feat(mobile): read-only assistant status strip`.

### Task 7: Security — restrict the no-login session to Gert's devices (S, ops; needs Gert's go-ahead before touching bender)

**Files:** facts only first; config change on bender's `~/.config/herdr-engineering/config.yaml` (`fabric.access.users`) and/or bridge settings.

- [ ] **Step 1: Verify real client IP** reaches the control plane through the gateway: from the Mac call `POST https://local.metabolomics.us/api/auth/open` with `Origin: rakazo://` and read the server's recorded peer (bridge `_open_owner`, `rakazo_bridge.py` ~:970-1006); confirm `trusted_proxies: [100.104.39.6]` makes it use the forwarded address. Record the result in the PR.
- [ ] **Step 2: Decide scope.** `AccessPolicy` (`fabric_access.py:87`) gates gateway leased-port listeners; confirm whether the apex route to cp-web is covered. If not, add the user allow-list at the bridge (open_owner source allow-list) as a small server change with a pytest in `test_rakazo_bridge.py` (open_owner from a non-allowed tailnet address → 403), instead of relying on the gateway.
- [ ] **Step 3:** Apply on bender after Gert approves; verify from the iPhone (allowed) and a non-listed tailnet node or simulated address (denied).
- [ ] **Step 4:** Run `/code-review` on the change; commit/PR on the server branch.

### Task 8: Release build, smoke flow, install on the iPhone (A)

**Files:**
- Create: `M/.maestro/single-chat.yaml`
- Modify: none committed besides the flow (build env is local only)

- [ ] **Step 1:** Maestro flow `single-chat.yaml`: launch with cleared state, assert no "Sign up for Shepherd" and no sign-in form, assert the message input is visible, send a message, assert it appears; add offline variant by pointing at a dead URL and asserting "Can't reach the assistant" and Retry.
- [ ] **Step 2:** Build Release with `EXPO_PUBLIC_SINGLE_CHAT=true EXPO_PUBLIC_PERSONAL_SERVER_ONLY=true EXPO_PUBLIC_PERSONAL_SERVER_URL=https://local.metabolomics.us`; run the flow on a simulator against the fabric endpoint (`maestro test .maestro/single-chat.yaml`).
- [ ] **Step 3:** Build for the device via the Xcode GUI recipe in memory note `xcode-apple-id-signed-in` (temporary `DEVELOPMENT_TEAM`, revert after), install with `xcrun devicectl device install app --device 00008160-001C55C80821400A <app>`, launch (phone unlocked).
- [ ] **Step 4:** Manual check with Gert on the phone: opens to the chat, picker creates and switches, default survives relaunch, status strip shows when an assistant runs. Report the result.

## Self-review

- Spec coverage: goals 1 (T3, T4, T8), 2 (existing assistant tools, verified in T8 step 4), 3 (T6), 4 (T1, T2, T5), 5 (T8 env), 6 (T7); offline state (T4); non-goals respected (no new routes, no auth mode).
- Types: `isDefault` named identically in T1, T2, T3, T5; `pickDefaultBot`, `singleChatOnly` defined in T3 and used in T4.
- Known unknowns, handled inside tasks: whether the contract fixture rejects extra fields (T1 step 4), whether the apex route is covered by `AccessPolicy` (T7 step 2).
