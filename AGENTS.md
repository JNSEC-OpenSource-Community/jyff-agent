# Repository Instructions

## Toolchain

- This is a pnpm 11 workspace (`packages/*` and `apps/*`) using Vite+ 0.2.8. Use the `vp` commands below; do not assume standalone Vite, Vitest, Biome, or pnpm scripts are the source of truth.
- Node.js must be `>=22.19.0`; the pinned package manager is pnpm `11.20.0`.
- Run `vp install` after dependency or lockfile changes. CI uses `vp install --frozen-lockfile`.
- `vite.config.ts` is the active root config. It sets the frontend build root, test discovery, type-aware linting, and no-semicolon formatting.

## Commands

- First setup: `vp install`, then `vp run build:sandbox` to create the `ctf-agent-solver:latest` Docker image.
- Start the local control plane with `vp run webui`; this builds the frontend before starting `apps/backend/src/main.ts`.
- Run validation in this order: `vp check`, `vp run typecheck`, `vp test`, then `vp build`.
- Run one test file with `vp test run path/to/file.test.ts`; use `-t "test name"` for one test. `vp run test:runner` is the existing shortcut for the contest runner suite.
- For Dockerfile changes, also run `docker build --check -f apps/backend/Dockerfile .`.
- Production-like WebUI uses `docker compose up --build -d`; it requires Docker socket access and the `ctf-agent-data` volume.
- Git commit message must obey gitmoji + conventional mix pattern，such as `✨ feat(solver): add a new feature` or `🐛 fix(core): fix something`

## Architecture

- Runtime flow is `WebUI -> Hono/SSE -> ControlPlane -> Project/Scheduler -> Agent/Sandbox`.
- The backend entrypoint is `apps/backend/src/main.ts`; HTTP routes are under `apps/backend/src/http/routes`. The frontend entrypoint is `apps/frontend/src/main.tsx`; page components are under `apps/frontend/src/pages`.
- `packages/core` owns ControlPlane, Project lifecycle, scheduling, and RunStore persistence. `packages/agents` owns Pi agents and tools. `packages/platform` owns CTFd/GZCTF adapters and plugin contracts. `packages/sandbox` owns Docker execution. `packages/prompts` owns role prompts. `packages/web-access` owns search and content extraction.
- API, SSE, and workspace-file operations are Project-scoped and must carry the Project ID. Run state is authoritative in RunStore; schedulers should not bypass it.
- Add behavior tests under the affected package's `test/` directory and assert public behavior rather than internal fields. Tests import helpers from `vite-plus/test`.

## Runtime Gotchas

- `--root` selects the data root and defaults to the current directory; runtime state is stored under `<root>/.ctf-agent`, including sensitive `secrets.json`. Never commit or expose that file.
- Solver, Father, and extension validation need the `ctf-agent-solver:latest` image. The compose setup mounts `/var/run/docker.sock` and persists `/data/.ctf-agent` in `ctf-agent-data`.
- `packages/web-access` is a pinned fork, not a Pi TUI extension. Its network requests run in the backend host process, credentials come from the host SecretStore, and sandbox `networkMode` does not restrict those requests. Follow `packages/web-access/UPSTREAM_PIN.md` before changing upstream-derived code.
- Platform live tests are opt-in: `CTFD_DEMO_TOKEN` enables the CTFd demo test and `GZCTF_LIVE=1` enables the GZCTF live contract test.

For deeper invariants, read `docs/architecture.md` and `docs/platform-plugins.md` before changing orchestration, persistence, or extension behavior.
