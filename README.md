# Keepseam Client

Private SDK, CLI and local worker for maintaining API integrations in the customer's environment. JS/TS has bounded automatic call discovery. Python and Java support explicit captured source/test selection, byte-bound recipes and isolated validation using Python 3.13.16 stdlib unittest suites or Java 25 main tests with assertions enabled. All languages retain model consent, semantic review, execution approval and separate draft publication approval; automatic Python/Java call discovery is not implemented.

The maintained technical documentation is [technical-guide.pdf](docs/technical-guide.pdf). It contains installation and public SDK examples, the CLI workflow, model context and review, Docker execution and recovery, native services, Cloud status and verified update staging. Fixtures and development laboratories keep their own example instructions.

Manual local SDK/CLI operations remain available without a Cloud license. Every automatic `worker-service` requires a separately trusted, identity-bound signed license; otherwise it starts paused. Connected suspension pauses Keepseam automation, preserving the customer's API and local evidence. Offline authorization lasts at most 24 hours and never outlives its entitlement; revocation and the clock watermark survive restart.

Release operators use `pnpm release:sign --config /absolute/operator/release.json` after building and reviewing the platform archives. Its `delivery/` directory contains the bounded Cloud import request, flat artifacts, exact PDF, public trust root and hash inventory. Import creates a draft; separate approval publishes it. The PDF explains native certificates, notarization, protected signing runners, trust provisioning and installation. No production release or trust identity is bundled.

Signing and offline `release:refresh` also export a separate `repository/` transport tree. New root ceremonies use `consistent_snapshot:true`: versioned metadata and hash-prefixed targets retain immutable identities. Existing roots with `false` remain supported without modification. Keep the canonical operator files outside the served tree. Cloud's maintained, authenticated worker update feed is still pending; the current updater stages only the SDK package, with installation separately authorized.

From this checkout, use Node 24.21.0–24.x and pnpm 11.19.0: `pnpm install --frozen-lockfile`, `pnpm engine:setup`, `pnpm build`, then `pnpm keepseam --help`. Engine acquisition needs network access. The separate release builder produces a CLI bundle with its own runtime; extract its whole directory. Consumer validation requires the documented Linux x64 Docker profile. No command installs models, authorizes unreviewed changes or merges/deploys a PR automatically.

Run `pnpm check` and the relevant prepared Linux `pnpm test:isolated` checks. Documentation source is `docs/technical-guide.html`; regenerate with `node tooling/build-docs.mjs --playwright-root ../keepseam-cloud` using Playwright 1.63.0 and its Chromium, then run `node tooling/build-docs.mjs --check`. Keep source and PDF together when Client contracts change.

The package remains `UNLICENSED` and is not published to npm. Keep local state, credentials, proposals, approval receipts and test output outside the consumer checkout and Git. See [AGENTS.md](AGENTS.md) for contribution conventions.
