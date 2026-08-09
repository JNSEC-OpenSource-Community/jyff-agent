# Platform contract

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
