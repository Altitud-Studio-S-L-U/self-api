# Keepseam Client

Private SDK, CLI and local worker for maintaining API integrations in the customer's environment. JS/TS has bounded automatic call discovery. Python and Java support explicit captured source/test selection, byte-bound recipes and isolated validation. Built-in profiles use Python 3.13.16 stdlib unittest or Java 25 main tests with assertions enabled; explicitly prepared Linux x64 runtimes also support pytest 9.1.1 and Maven 3.9.16/JUnit 6.1.3. Validation runs offline against unchanged selected tests; Maven support is limited to the documented single-module dependency profile. All languages retain model consent, semantic review, execution approval and separate draft publication approval; automatic Python/Java call discovery is not implemented.

The maintained technical documentation is [technical-guide.pdf](docs/technical-guide.pdf). It contains installation and public SDK examples, the CLI workflow, model context and review, Docker execution and recovery, native services, Cloud status and verified update staging. Fixtures and development laboratories keep their own example instructions.

Manual local SDK/CLI operations remain available without a Cloud license. Every automatic `worker-service` requires a separately trusted, identity-bound signed license; otherwise it starts paused. Connected suspension pauses Keepseam automation, preserving the customer's API and local evidence. Offline authorization lasts at most 24 hours and never outlives its entitlement; revocation and the clock watermark survive restart.

Linux worker bootstrap is offline and file-based. Its commands:

- `keepseam setup init --dir <private-directory>` creates a 0700 directory and a new ES256 installation key. It prints only the public identity to paste in Keepseam Cloud, and pins the Cloud origin (`https://keepseam.com` unless `--cloud` is given) and the state directory.
- `keepseam setup complete --dir <private-directory> < enrollment.json` reads the one-time enrollment JSON from stdin, never from argv or a terminal. Stdin may come from a protected file or a secret manager, and the command keeps no extra copy of it.
  - It accepts the enrollment only from the pinned origin and for that key.
  - It writes `credentials.json` and an observation-only `worker.json`, both 0600. That configuration reads no credentials and shares nothing with Cloud.
  - Files are never overwritten. If a run stops between the two files, re-running it with the same enrollment completes it. The pending key is removed only after both files are verified on disk.
- `keepseam setup trust --dir <private-directory> --trust <public-trust.json> --key <kid>=<sha256> ...` installs the public license trust.
  - The issuer must be the pinned origin, and every key must match the fingerprint shown for it in Keepseam Cloud. Use the same `kid=sha256` form, obtained separately for each key.
  - Missing, extra or different keys are refused, and nothing is downloaded.
- `keepseam setup config --dir <private-directory> --license --expect <config-sha256>` adds a license section to `worker.json` that uses the enrolled credentials and the installed trust.
  - It has no lease file: the service renews its license through authenticated control.
  - It changes only the exact revision named by the hash that `doctor` prints, keeps every other option, and preserves the replaced bytes in `worker.json.previous`. It refuses a different previous revision or license section, and it applies at the next service start.
  - Setup commands are serialized. A writer that ignores `setup.lock` is detected only up to a final check before the replacement, so the private directory and its dedicated account remain the trust boundary.
  - If verification fails after the replacement, the new revision may already be in place. Compare hashes with `doctor`; nothing is rolled back automatically.
- `keepseam doctor --dir <private-directory>` reports permissions, enrollment, configuration, license trust, a configured lease's offline signature and expiry, the configuration hash, and whether `GH_TOKEN` is present for the existing publication commands.
  - It never prints secret values or license claims.
  - An offline signature says nothing about revocation or the service's own license state.
  - `--online` checks network reach to the Cloud liveness endpoint, not authentication.

To roll back a configuration update manually:

1. Stop the service.
2. Keep a copy of the current `worker.json`, since it may be the only copy of the new revision.
3. Check that `worker.json.previous` is the revision you want.
4. Rename `worker.json.previous` over `worker.json`.

Recovery after a crash is manual by design: nothing resumes automatically, and unknown files are never deleted. A crash while a file is written can leave `setup.lock` and a named `<file>.<uuid>.tmp`. `doctor` tells the cases apart:

- `TEMPORARY_SECOND_LINK`: the temporary file is the same file (same inode) as an existing destination. Once no setup command runs, remove that temporary file and `setup.lock`.
- `TEMPORARY_ONLY_COPY`: there is no matching destination, because the crash came before the file was linked. The temporary file may be the only copy of the key or credentials, so keep it. Recovering it is manual. Inspect it, and rename it to its destination only when that destination is missing; if a different copy already exists, do not replace it. Otherwise start again in a new directory.

Release operators use `pnpm release:sign --config /absolute/operator/release.json` after building and reviewing the platform archives. Its `delivery/` directory contains the bounded Cloud import request, flat artifacts, exact PDF, public trust root and hash inventory. Import creates a draft; separate approval publishes it. The PDF explains native certificates, notarization, protected signing runners, trust provisioning and installation. No production release or trust identity is bundled.

Signing and offline `release:refresh` also export a separate `repository/` transport tree. New root ceremonies use `consistent_snapshot:true`: versioned metadata and hash-prefixed targets retain immutable identities. Existing roots with `false` remain supported without modification. Keep the canonical operator files outside the served tree. When configured, Cloud serves approved releases through an authenticated worker update feed and renews timestamp/snapshot metadata in a separate signing process. The updater stages the SDK package by default. With `"artifact": "worker-linux-x64"` in its configuration it stages instead the portable Linux x64 worker archive of the same signed release, and only from the authenticated Cloud feed. It reads the release manifest through TUF and requires exactly one canonical Linux x64 worker equal to its signed target. It keeps its own state directory, store and anti-rollback watermark, which records the last release observed and authenticated even when the download then fails. It never extracts the archive and never reports an installed worker. Installation stays separately authorized.

From this checkout, use Node 24.21.0–24.x and pnpm 11.19.0: `pnpm install --frozen-lockfile`, `pnpm engine:setup`, `pnpm build`, then `pnpm keepseam --help`. Engine acquisition needs network access. The separate release builder produces a CLI bundle with its own runtime; extract its whole directory. Consumer validation requires the documented Linux x64 Docker profile. No command installs models, authorizes unreviewed changes or merges/deploys a PR automatically.

Run `pnpm check` and the relevant prepared Linux `pnpm test:isolated` checks. Documentation source is `docs/technical-guide.html`; regenerate with `node tooling/build-docs.mjs --playwright-root ../keepseam-cloud` using Playwright 1.63.0 and its Chromium, then run `node tooling/build-docs.mjs --check`. Keep source and PDF together when Client contracts change.

The package remains `UNLICENSED` and is not published to npm. Keep local state, credentials, proposals, approval receipts and test output outside the consumer checkout and Git. See [AGENTS.md](AGENTS.md) for contribution conventions.
