# Validation gate (current)

The gate loads the exact candidate revision through the production plugin loader and uses user-supplied test configuration.

Required read-only checks cover config parsing, connection, refresh, overview, stable challenge lists, announcements, challenge details, IDs, and cleanup. A rejected test flag verifies submission when provided. A disposable environment challenge verifies start, status, and destroy when enabled; destroy runs during cleanup even after failure.

Results are `failed`, `read_only_verified`, or `fully_verified`. Skipped mutation checks do not count as passed. The report is bound to the candidate content hash, validation profile fingerprint, harness version, and author Session. Any candidate change invalidates the report.

Do not modify code to special-case profile IDs or validation data. The same implementation is used by real Projects after activation.
