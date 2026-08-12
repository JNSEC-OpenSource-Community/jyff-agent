---
name: extension-authoring
description: Investigate a CTF platform from source code, documentation, or an authorized test site and implement or repair a PlatformPlugin extension. Use for platform API discovery, authentication analysis, challenge and attachment mapping, flag submission, remote environment lifecycle support, fixtures, and validation-gate failures.
---

# Extension authoring

Build only a platform extension under `/workspace/plugin` and publish candidate files under `/workspace/output`. Treat the control plane validation gate as authoritative; local tests never prove production readiness.

## Workflow

1. Read [platform-contract.d.ts](references/platform-contract.d.ts) and [platform-contract.md](references/platform-contract.md) before researching the target. Do not search npm, the CTF Agent repository, or production WebUI bundles for the plugin contract.
2. Inspect supplied source and documentation before the authorized test site. Record verified endpoints, authentication state, response shapes, pagination, and error behavior in `/workspace/research/evidence.md`. Do not inspect minified bundles when readable source is available.
3. Read [validation-gate.md](references/validation-gate.md) before choosing fixtures and test data.
4. Copy the template from `assets/platform-template` into `/workspace/plugin`. Use a stable lowercase extension ID; never reuse `ctfd` or `gzctf`. The distributable candidate is schema v2 `extension.json` plus a self-contained `index.ts`; fixtures and tests stay outside `/workspace/output`.
5. Keep credentials out of source, fixtures, output, and messages. Resolve only manifest-declared secret names through `resolveSecret`.
6. Implement configuration parsing, the setup descriptor, connection cleanup, stable IDs, challenge binding, attachment download, submission, announcements, and optional environment lifecycle. For environments, propagate `start(signal)` through every request and poll, use a wall-clock startup deadline, treat a timed-out POST as ambiguous, and make `destroy()` idempotent; follow [platform-contract.md](references/platform-contract.md).
7. Add fast deterministic tests for successful and malformed upstream responses. Include fixture coverage for accepted, rejected, authorization, rate-limit, and protocol-error responses even when the live gate cannot safely trigger every case.
8. Run formatting, type checking, tests, and import smoke checks inside the sandbox. Fix every local failure.
9. Copy only `extension.json` and the self-contained `index.ts` into `/workspace/output`. Keep the static manifest `setup` structurally equivalent to the plugin's exported `setup`. Do not include credentials, downloaded source trees, caches, dependencies, or build artifacts.
10. Call `father_request_test_access` after the setup form and importable candidate exist. Never request credentials in chat or inspect them with shell commands. Reuse the saved test access while the setup schema remains unchanged.
11. When the gate returns a structured failure, fix the candidate instead of weakening assertions or claiming completion.
12. Report verified, skipped, and unverified capabilities separately. Finish only after the candidate content hash has a current gate report.

## Boundaries

- Work only inside the isolated Father workspace.
- Do not target the host control plane, Docker API, production Project workspaces, or production credentials.
- Do not modify the supplied platform source; use it only as evidence.
- Do not hide destructive behavior in module initialization, setup descriptors, or validation hooks.
- Make `close()` idempotent and clean up timers, sockets, cookies, and pending polls.
- Never leave an environment method pending without a finite network or polling deadline. Cover response-body reads, not only response headers.
- Preserve `AbortError` from `start(signal)` and stop all polling promptly. Core bounds the tool call, but the plugin must cooperate to avoid orphan instances and leaked sockets.
- Make repeated environment cleanup safe when start fails, is cancelled, or returns after the caller has stopped waiting.
- Preserve exact validation artifacts so a later repair Session can reproduce the failure.
- Use `curl --fail --location` for downloads and verify status, file type, and size before extraction. Stop retrying a source after a rate limit or definitive not-found response.
