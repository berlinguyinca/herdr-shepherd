---
name: sync-upstream
description: Merge the parent fork (elie222/rakazo main) into this fork (berlinguyinca/herdr-shepherd) without breaking our herdr/Shepherd changes - fetch upstream, merge onto an integration branch from our tip, resolve conflicts keeping both sides, verify, then push and open a PR. Use when asked to sync, update, or integrate upstream/parent fork changes.
---

# Sync upstream into the Shepherd fork

Our work lives on `herdr/*` branches, not `main` (fork `main` is just a stale mirror of upstream). The tip that contains all of them is `origin/herdr/personal-dashboard`; confirm each time (step 2). Upstream is `https://github.com/elie222/rakazo.git`.

Scope is `upstream/main` only. Do not merge other upstream branches or third-party forks of rakazo unless the user names them; unreviewed outside code is a supply-chain risk.

## Steps

1. **Remotes and fetch**

   ```sh
   git remote get-url upstream 2>/dev/null || git remote add upstream https://github.com/elie222/rakazo.git
   git fetch upstream && git fetch origin
   git status --short   # must be clean; stop and ask if not
   ```
2. **Find our tip.** For each `origin/herdr/*` branch, `git rev-list --count <tip>..origin/herdr/<b>` must be 0 for every branch except the tip itself. If no single branch contains the rest, ask the user which to base on.
3. **Branch and merge** (never on `main`, never rebase our history):

   ```sh
   git checkout -b integrate/upstream-$(date +%Y%m%d) origin/herdr/personal-dashboard
   git merge --no-ff upstream/main
   ```
4. **Resolve conflicts keeping both sides' intent.** For each file, compare what we changed: `git diff upstream/main...origin/herdr/personal-dashboard -- <file>`. Upstream refactors can move code (e.g. `apps/mobile/lib/api.ts` was split into `api-auth/-server/-live.ts`); re-apply our changes in the new location rather than dropping them. Our features that must survive:
   - first-launch empty server field and no "Use default server" during setup (`serverNeedsSetup`, `app/server.tsx`)
   - `openOwnerSession`, personal-server-only sign-in, Shepherd strings
   - terminal and agents views (`streamRpc`, `shepherd-terminal` contracts, `@xterm/*` deps, `build:terminal`)
   - bundle id prefix `com.berlinguyinca.shepherd` (upstream uses `com.rakazo.app`; plugin tests enforce the parent prefix)
   - `pnpm-lock.yaml`: take upstream's, then regenerate with `pnpm install --no-frozen-lockfile`; never hand-edit.
5. **Fix merge breakage beyond conflicts.** These all bit us on the last sync:
   - Every locale file needs our new strings, including any new upstream locale (such as `pl`). The Polish `messages.po` msgid must match the source string exactly or the catalog test fails. Mobile catalogs live in `apps/mobile/lib/locales/*.ts` and must be Biome-formatted.
   - Keys we renamed that upstream still uses (the visible product name is Shepherd; internal identifiers such as `@rakazo/*`, `RAKAZO_*` and `rakazo://` stay).
   - New upstream tRPC routes the API must implement. `agents` and `terminal` are served by the bridge, so `apps/api/src/routes/context.ts` destructures them out of `appContract`; do the same for any new bridge-only route, or `@rakazo/api` typecheck fails.
   - `packages/testkit/src/ios-screenshot-catalog.test.ts`: add new upstream screens, or list ours in `UNCOVERED`.
   - New compose env vars: `infra/updater/src/compose-env.test.ts` has an allowlist; pass the variable through `docker-compose{,.prod,.images}.yml` or add it to `NOT_PASSED`.
   - `packages/testkit/src/dev-database.test.ts` copies a temp checkout and needs `packages/core` symlinked in.
   - Framework type changes after dependency bumps.
6. **Verify before committing** (no conflict markers; typecheck `apps/mobile` and `packages/contracts`; `vitest run apps/mobile packages/contracts`; `turbo check --filter='...@rakazo/contracts'`). Compare any failure against `upstream/main` before calling it ours or pre-existing. Known flaky or baseline: `account-zip-reader.test.ts` (timeout), biome `useTemplate` warnings in upstream files, and about 48 environment-dependent vitest failures locally; Postgres-backed tests only run in CI. Compare against `origin/herdr/personal-dashboard` before calling a failure ours. If the `pnpm` shim fails with ENOEXEC, call the pnpm binary directly with `npm_config_manage_package_manager_versions=false`.
7. **Commit** with the default merge subject (do not pass `--no-edit` together with `-m`, it replaces the subject), plus the attribution trailer required by the session.
8. **Push and PR to our fork, not upstream:**

   ```sh
   git push -u origin integrate/upstream-<date>
   gh pr create --repo berlinguyinca/herdr-shepherd --base herdr/personal-dashboard --head integrate/upstream-<date>
   ```

   `--repo` is mandatory; `gh` can default to the parent. Pushing changes under `.github/workflows/` needs the `workflow` token scope: `gh auth refresh -h github.com -s workflow` (the user runs this; it opens a browser).

## CI notes

- Users never see the name Rakazo: upstream copy that reappears in conflicts or new strings (and the matching catalog entries) gets the product name Shepherd. Developers may see Rakazo in identifiers, `LICENSE` and attribution, so leave those alone.

- Web E2E shards sometimes fail with exit 124 from the `apt-get` font install; that is infrastructure. Rerun with `gh run rerun <run-id> --failed` and do not change code.
- A workflow can reference a test title or executable path by name (for example `desktop-macos-screenshot.yml` filters by a test title). When renaming visible strings, grep `.github/` for the old text.
- Wait for checks with `gh pr checks <n> --watch`, then merge only when green and no review comments remain.

## Report

State: merge commit and parents, files conflicted and how each was resolved, what was added beyond conflicts, test results with counts, known failures (and whether they also fail on `upstream/main`), and anything needing human review (machine-translated strings).
