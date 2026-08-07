# Platform plugins

Projects select a platform adapter through the WebUI or configuration. The control plane persists
the first/legacy project in `.ctf-agent/project-config.json` and additional projects below
`.ctf-agent/projects/<project-hash>/project-config.json`; `.pi/ctf-config.json` remains a read-only
legacy fallback. Each plugin parses its own `config` object. Credentials are referenced by secret
name and never persisted in the project configuration.

The WebUI renders setup fields from each plugin's `setup` descriptor. It can test a temporary
connection before replacing the selected Project runtime. Secrets entered there are stored in
`.ctf-agent/secrets.json` with service-only file permissions and a key derived from both the Project
ID and plugin secret name, so multiple Projects can use different platform accounts. Legacy
unscoped keys remain a read-only fallback. The runtime resolves credentials only from this Secret
Store; environment variables are not a credential fallback.

## CTFd

```json
{
  "version": 1,
  "project": { "id": "demo", "name": "CTFd Demo" },
  "platform": {
    "plugin": "ctfd",
    "config": {
      "baseUrl": "https://demo.ctfd.io",
      "tokenSecret": "CTFD_TOKEN"
    }
  },
  "sandbox": {
    "image": "ctf-agent-solver:latest",
    "privileged": false,
    "networkMode": "bridge"
  }
}
```

Enter `CTFD_TOKEN` in the WebUI. The adapter uses CTFd's official `Token` authorization
scheme and supports challenge listing/detail, signed attachment downloads, notifications, and flag
attempts. Core CTFd has no standard per-player container lifecycle API, so this adapter does not
invent one. CTFd notification types are not stable enough to classify at the adapter boundary, so
notifications are emitted with `kind: "unknown"` for Core's conservative classifier.

## GZCTF

```json
{
  "version": 1,
  "project": { "id": "gz-review", "name": "GZCTF Review" },
  "platform": {
    "plugin": "gzctf",
    "config": {
      "baseUrl": "https://gz.imxbt.cn",
      "gameId": 36,
      "auth": {
        "type": "password",
        "usernameSecret": "GZCTF_USERNAME",
        "passwordSecret": "GZCTF_PASSWORD"
      }
    }
  },
  "sandbox": {
    "image": "ctf-agent-solver:latest",
    "privileged": false,
    "networkMode": "bridge"
  }
}
```

GZCTF's player APIs use the ASP.NET Identity `GZCTF_Token` Cookie, not its administrator API token.
The adapter logs in with the named username/password secrets, preserves the Cookie, and applies the
same X25519 + SHA-256 + AES-256-GCM encryption as the official web client whenever the server
publishes `apiPublicKey`.

If automated login is blocked by CAPTCHA, log in with a browser and select Cookie authentication:

```json
{
  "auth": { "type": "cookie", "cookieSecret": "GZCTF_COOKIE" }
}
```

`GZCTF_COOKIE` may contain the Cookie value alone or `GZCTF_Token=<value>`. The account must already
belong to a team participating in the configured game. The adapter supports challenge metadata,
attachments, asynchronous flag judgement, and native start/status/destroy container operations.
GZCTF notice types are normalized without matching challenges: `FirstBlood`, `SecondBlood`, and
`ThirdBlood` become `solve_broadcast`; `NewHint` becomes `hint`; `NewChallenge` becomes
`new_challenge`; the original value remains in `rawType` for diagnostics.

## Announcement data boundary

`Announcement.kind` is an optional normalized platform fact (`normal`, `hint`, `new_challenge`,
`solve_broadcast`, or `unknown`). Platform adapters do not decide which challenge an announcement
belongs to. Core first filters explicit solve broadcasts and conservative title/action patterns,
then performs deterministic NFKC/case/whitespace-normalized full-title or tokenized challenge-ID
matching. Very short titles require quoting or brackets, and duplicate normalized titles remain
ambiguous matches rather than being silently assigned to one challenge.
Remote-environment enumeration includes instances observed by the current plugin process because
GZCTF exposes challenge-scoped status but no player-wide instance-list endpoint.

## Validation

All plugin configs reject unknown keys, plaintext credentials, unsupported URL schemes, and invalid
timeouts/IDs. Network, authentication, permission, rate-limit, HTTP, and response-protocol failures
are surfaced as typed adapter errors. Expected business results such as a wrong flag are returned as
`FlagSubmission` values rather than thrown as process errors.
