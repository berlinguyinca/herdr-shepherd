# CI on Woodpecker

GitHub Actions is disabled on this repository. CI runs on Woodpecker (https://ci.metabolomics.us)
from `.woodpecker/*.yaml`. The files in `.github/workflows` are inert and left in place as the
reference these pipelines were ported from.

## What runs

Each file is an independent workflow, so they run in parallel. Trigger: `pull_request`, and `push`
to `herdr/personal-dashboard`.

| File | Mirrors | Content |
| --- | --- | --- |
| `lint-typecheck.yaml` | `ci.yml` static-checks | `pnpm lint` (biome), `pnpm db:generate`, `pnpm check` (turbo typecheck), Python and Node script self-tests |
| `unit-tests.yaml` | `ci.yml` unit-tests-shard | `pnpm run test --shard=N/6`, 6 matrix workflows, `age` installed for the backup test |
| `compose-env.yaml` | compose-env test inside unit shards | `vitest run infra/updater/src/compose-env.test.ts` |
| `postgres-journeys.yaml` | `ci.yml` test-integration-shard | `pnpm test:integration --shard=N/6` with a `postgres:18-alpine` service and `CI_POSTGRES_URL` |
| `build.yaml` | `ci.yml` build | `pnpm build`, then Electron smoke under xvfb |
| `web-e2e.yaml` | `playwright.yml` shard | `pnpm test:e2e --shard=N/6` on the Playwright image, Postgres service |
| `web-e2e-heavy.yaml` | `playwright.yml` heavy | `page-browser` (1 worker) and `pages` (2 workers) specs |
| `www-screenshots.yaml` | `playwright.yml` www-screenshots | `pnpm --filter @rakazo/www e2e` |

Within a file, steps use `depends_on` (install first, then the checks that need it). Node 24 comes
from `node:24-bookworm`; pnpm comes from `corepack enable`, which reads `packageManager` in
`package.json`. Installs use `--frozen-lockfile`.

## Not ported

- Deploy, publish-server-image, publish-mobile-update, release-*, preview-*, nightly: need secrets, registries or production hosts.
- Screenshot/report publishing, artifact upload, label/triage/review bots, translation and dependency bump workflows: GitHub-specific or secret-bearing.
- `native-computer` (macOS and Windows runners): no such agents assumed.
- `test-postgres-upgrade` and Compose smokes: need the host Docker socket.
- Changed-area filtering and turbo/pnpm cache steps: everything always runs; no cache.

## Server assumptions

- Docker backend, no privileged mode, `services:` supported (Woodpecker 2.x or 3.x).
- Steps can reach `mirror.gcr.io` and `mcr.microsoft.com`, GitHub (for the `age` download), npm.
- The service hostname `postgres` resolves from steps (service `name` is the host).
- `pull_request` events are enabled for the repo and the forge is GitHub.

## Activate

1. Sign in at https://ci.metabolomics.us and choose Add repository.
2. Enable `berlinguyinca/herdr-shepherd` (needs the GitHub webhook to be installable).
3. In repo settings enable Pull Request and Push events. Do not enable Trusted/privileged.
4. Optionally add the workflows as required checks once green.

## TODO (unverified)

- None of the YAML has run on the server; only parsed syntactically (`woodpecker-cli lint` was not available).
- Playwright image Node version versus `engines` (`^24.15.0 || >=26`); the image may need a Node 24 install.
- The CJK font coverage of the Playwright image (GitHub CI installed `fonts-noto-cjk`).
- Whether unit tests or the harness need the Docker socket (Testcontainers); none is mounted.
- Electron smoke apt package list for `node:24-bookworm`.
- Image tag `v1.64.1-noble` exists, and `postgres` service readiness timing.
- Whether `${SHARD}` matrix expansion and `E2E_WORKERS: ${WORKERS}` behave as written in your version.
- Typecheck `db:generate` uses a placeholder `DATABASE_URL`, as the GitHub workflow did.
