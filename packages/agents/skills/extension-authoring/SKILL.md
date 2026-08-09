---
name: extension-authoring
description: Investigate a CTF platform from source code, documentation, or an authorized test site and implement or repair a PlatformPlugin extension. Use for platform API discovery, authentication analysis, challenge and attachment mapping, flag submission, remote environment lifecycle support, fixtures, and validation-gate failures.
---

# Extension authoring

Build only a platform extension under `/workspace/plugin` and publish candidate files under `/workspace/output`. Treat the control plane validation gate as authoritative; local tests never prove production readiness.

## Workflow

1. Inspect the supplied source, documentation, and test site. Record verified endpoints, authentication state, response shapes, pagination, and error behavior in `/workspace/research/evidence.md`.
2. Read [platform-contract.md](references/platform-contract.md) before implementing the adapter. Read [validation-gate.md](references/validation-gate.md) before choosing fixtures and test data.
3. Copy the template from `assets/platform-template` into `/workspace/plugin`. Use a stable lowercase extension ID; never reuse `ctfd` or `gzctf`.
4. Keep credentials out of source, fixtures, output, and messages. Resolve only manifest-declared secret names through `resolveSecret`.
5. Implement configuration parsing, the setup descriptor, connection cleanup, stable IDs, challenge binding, attachment download, submission, announcements, and optional environment lifecycle.
6. Add fast deterministic tests for successful and malformed upstream responses. Include fixture coverage for accepted, rejected, authorization, rate-limit, and protocol-error responses even when the live gate cannot safely trigger every case.
7. Run formatting, type checking, tests, and import smoke checks inside the sandbox. Fix every local failure.
8. Copy only the manifest, entry source, required local modules, and tests into `/workspace/output`. Do not include credentials, downloaded source trees, caches, dependencies, or build artifacts.
9. Request the platform validation gate. When it returns a structured failure, fix the candidate instead of weakening assertions or claiming completion.
10. Report verified, skipped, and unverified capabilities separately. Finish only after the candidate content hash has a current gate report.

## Boundaries

- Work only inside the isolated Father workspace.
- Do not target the host control plane, Docker API, production Project workspaces, or production credentials.
- Do not modify the supplied platform source; use it only as evidence.
- Do not hide destructive behavior in module initialization, setup descriptors, or validation hooks.
- Make `close()` idempotent and clean up timers, sockets, cookies, and pending polls.
- Preserve exact validation artifacts so a later repair Session can reproduce the failure.
