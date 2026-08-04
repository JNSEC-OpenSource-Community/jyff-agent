# Solver / BaseAgent Refactor TODO

## Architecture decisions

- Full agent conversations use Pi's native `Session` and JSONL session-tree storage.
  Each run owns one `session.jsonl` file under its run directory.
- SQLite remains the authoritative index for run status, scheduling, blackboard,
  and control-plane telemetry. Full transcripts are not duplicated into SQLite.
- `BaseAgent` owns the Pi harness, session persistence/recovery, compaction,
  skills, common tool registration, and lifecycle coordination.
- `CtfSolverAgent` extends `BaseAgent` and owns only challenge-scoped CTF
  capabilities and terminal submission behavior.
- Pi's bash/read/write/edit tools are reused through a Docker-backed
  `ExecutionEnv`; agent filesystem and shell operations stay inside the run
  container.
- Package dependencies must remain acyclic. Project orchestration may depend on
  SolverAgent, but SolverAgent must not depend on Project or RunStore.

## Implementation order

- [x] Extract platform contracts into `@ctf-agent/platform`.
- [x] Extract sandbox contracts and Docker implementation into
      `@ctf-agent/sandbox`.
- [x] Implement a Docker-backed Pi `ExecutionEnv` with normalized file,
      execution, abort, timeout, and cleanup errors.
- [x] Add `@ctf-agent/base-agent` using Pi `AgentHarness` and `Session`.
- [x] Create/open one native Pi JSONL session per run and verify restoration.
- [x] Migrate skill discovery, diagnostics, and prompt formatting to Pi.
- [ ] Remove the legacy compaction implementation in favor of Pi sessions.
- [x] Migrate bash/read/write/edit to Pi tools over the Docker environment.
- [x] Make `CtfSolverAgent` extend `BaseAgent` and remove duplicated runtime code.
- [ ] Extract Project, RunStore, runner, and scheduler into
      `@ctf-agent/project`.
- [ ] Replace direct RunStore access in solver tools with a narrow blackboard
      capability.
- [ ] Consolidate runner/scheduler attempt execution and lifecycle cleanup.
- [ ] Classify validation, tool, abort, persistence, diagnostic, and cleanup
      errors; remove silent broad catches.
- [ ] Shrink duplicated tests and add session recovery, Docker tool, lifecycle,
      cancellation, and concurrent-dispatch edge cases.
- [ ] Update examples, WebUI dependencies, README, and compatibility exports.
- [ ] Run typecheck and deterministic tests from a clean dependency install.

## Acceptance criteria

- Every concrete agent extends `BaseAgent`.
- Restarting a run from its JSONL session restores messages, thinking level,
  active tools, and compaction entries.
- No common file or shell tool executes on the host.
- `packages/solver` contains no Project, SQLite, scheduler, skills parser,
  compaction algorithm, or Docker process implementation.
- Expected operational failures never create an unhandled rejection; primary
  and cleanup failures remain observable without masking each other.
- Workspace package dependencies are acyclic and all deterministic checks pass.
