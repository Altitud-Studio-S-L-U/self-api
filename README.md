# Keepseam Client

Private SDK, CLI and local worker for maintaining API integrations in the customer's environment. The supported product profile is TypeScript/JavaScript: evidence capture, bounded impact analysis, model proposals with explicit consent, semantic review, approved isolated validation and separately approved GitHub draft publication.

The maintained technical documentation is [technical-guide.pdf](docs/technical-guide.pdf). It contains installation and public SDK examples, the CLI workflow, model context and review, Docker execution and recovery, native services, Cloud status and verified update staging. Fixtures and development laboratories keep their own example instructions.

From this checkout, use Node 24.11.1–24.x and pnpm 11.19.0: `pnpm install --frozen-lockfile`, `pnpm engine:setup`, `pnpm build`, then `pnpm keepseam --help`. Engine acquisition needs network access. The separate release builder produces a CLI bundle with its own runtime; extract its whole directory. Consumer validation requires the documented Linux x64 Docker profile. No command installs models, authorizes unreviewed changes or merges/deploys a PR automatically.

Run `pnpm check` and the relevant prepared Linux `pnpm test:isolated` checks. Documentation source is `docs/technical-guide.html`; regenerate with `node tooling/build-docs.mjs --playwright-root ../keepseam-cloud` using Playwright 1.63.0 and its Chromium, then run `node tooling/build-docs.mjs --check`. Keep source and PDF together when Client contracts change.

The package remains `UNLICENSED` and is not published to npm. Keep local state, credentials, proposals, approval receipts and test output outside the consumer checkout and Git. See [AGENTS.md](AGENTS.md) for contribution conventions.
