# Platform Plugin Refactor TODO

## Decisions

- Project config selects a plugin and contains only plugin-owned, non-secret settings.
- Project resolves named secrets at connect time; plugins own authentication state and wire protocols.
- `@ctf-agent/platform` contains contracts only. CTFd and GZCTF never depend on one another.
- Platform-wide control methods remain in `PlatformProject`; SolverAgent receives only a bound
  `ChallengeCapability`.
- CTFd uses an access token. GZCTF player endpoints use the `GZCTF_Token` identity cookie because
  GZCTF API tokens are administrator-only and cannot authenticate player challenge endpoints.

## Implementation order

- [x] Delete the legacy generic remote client and split platform/event configuration.
- [x] Introduce plugin-owned configuration validation and secret resolution.
- [x] Implement CTFd challenge, attachment, notification, and submission APIs.
- [x] Implement GZCTF password/Cookie authentication and official request encryption.
- [x] Implement GZCTF challenge, attachment, asynchronous judgement, and container APIs.
- [x] Add local HTTP contract tests and opt-in live, read-only contract probes.
- [x] Register both plugins in the example runner and WebUI.
- [ ] Run the authenticated GZCTF live probe with an account that has active team participation.

The last item intentionally remains opt-in: the public site exposes no shared player credentials,
and joining a team or starting/submitting to a challenge would mutate external contest state.
