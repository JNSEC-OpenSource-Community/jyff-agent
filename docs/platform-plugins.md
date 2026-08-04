# Platform plugins

Projects select a platform adapter in `.pi/ctf-config.json`. The `config` object is parsed by that
adapter; credentials are referenced by environment-variable name and are never persisted in the
project file.

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

Set `CTFD_TOKEN` to a CTFd user access token. The adapter uses CTFd's official `Token` authorization
scheme and supports challenge listing/detail, signed attachment downloads, notifications, and flag
attempts. Core CTFd has no standard per-player container lifecycle API, so this adapter does not
invent one.

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
Remote-environment enumeration includes instances observed by the current plugin process because
GZCTF exposes challenge-scoped status but no player-wide instance-list endpoint.

## Validation

All plugin configs reject unknown keys, plaintext credentials, unsupported URL schemes, and invalid
timeouts/IDs. Network, authentication, permission, rate-limit, HTTP, and response-protocol failures
are surfaced as typed adapter errors. Expected business results such as a wrong flag are returned as
`FlagSubmission` values rather than thrown as process errors.
