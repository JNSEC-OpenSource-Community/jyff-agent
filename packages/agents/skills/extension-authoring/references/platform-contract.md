# Platform contract (schema v2)

Export one `PlatformPlugin` as `platformPlugin` or the default export. Its ID must match `extension.json`.

The control plane executes this lifecycle:

1. `plugin.config.parse(value)`
2. `plugin.connect({ project, config, resolveSecret })`
3. `getOverview()` and `refresh()`
4. `listChallenges()` and `listAnnouncements()` concurrently or repeatedly
5. `bindChallenge(id)` followed by `getInfo()`, attachment download, and `submitFlag()`
6. remote-environment enumeration and optional challenge instance lifecycle
7. `close()`, potentially after a partial failure

Requirements:

- Reject unknown config keys and plaintext credentials.
- Keep challenge, attachment, announcement, and environment IDs stable and non-empty.
- Return expected business outcomes such as a wrong flag as values, not exceptions.
- Throw bounded, credential-free errors for network, authentication, permission, rate-limit, and protocol failures.
- Never decide which challenge an announcement belongs to.
- Make repeated reads deterministic within the upstream platform's observable state.
- Make cleanup idempotent.

## Remote environment lifecycle

The control plane supplies Project-level quota, queueing, a hard startup deadline, cancellation racing, lease persistence, and bounded best-effort cleanup. Implement the adapter so upstream resources also terminate correctly:

- Pass the `AbortSignal` received by `instance.start(signal)` to fetch, response-body consumption, polling sleeps, and nested helpers. On cancellation, stop promptly and preserve an `AbortError`; do not translate it into a generic network failure or continue polling.
- Give every HTTP request a finite timeout covering the complete response body. A timeout that ends after response headers does not bound `response.json()`, `response.text()`, or `response.arrayBuffer()`.
- Bound readiness with an absolute wall-clock deadline. Do not infer the total deadline from a poll count because each poll request consumes time too.
- Treat a start POST timeout, disconnect, or cancellation as an ambiguous result: the server may have created the instance. Re-read status before retrying the POST, and support cleanup after cancellation.
- Return from `start()` only when the result is usable for the Agent. If the platform remains `starting`, never exposes a required endpoint, or enters a terminal failure state, throw a bounded credential-free error.
- Make `destroy()` safe for a never-started, already-stopped, concurrently-created, or repeatedly-destroyed instance. Core may call it immediately after a failed start and again if an abort-ignoring start resolves late.
- Bound `status()` and `destroy()` internally even though Core has a final defensive timeout. Close timers, sockets, WebSockets, local proxies, and in-flight polls from `close()`.
- Mark transient network, rate-limit, and server failures structurally, for example with `retryable: true`; keep authentication, permission, configuration, and malformed-protocol failures non-retryable.

Add deterministic tests for cancellation during a request, stalled response bodies, perpetual starting state, ambiguous POST outcomes, and repeated destroy. The validation gate's successful lifecycle check does not replace these failure-path tests.
