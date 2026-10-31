# Self-managed API

Local SDK, CLI and worker for maintaining API integrations. Compare contracts, inspect affected calls, review proposed changes and validate them in isolated copies. No project account, license token or hosted control server is required. The code is licensed under [MIT](LICENSE); the package is not published to npm.

Use Node 24.21.0-24.x and pnpm 11.19.0. From a Git checkout:

```sh
git clone https://github.com/Altitud-Studio-S-L-U/self-managed-api.git
cd self-managed-api
pnpm install --frozen-lockfile
pnpm build
pnpm self-managed-api --help
```

Try the included fictional MCP catalog and consumer, without a model, server or comparison engine:

```sh
pnpm --silent self-managed-api mcp-compare fixtures/mcp/catalog-before.json fixtures/mcp/catalog-after.json --json
pnpm --silent self-managed-api scan fixtures/consumer --json
```

The catalog comparison deliberately detects two breaking changes and exits **1**. The scan reads local files without running consumer code. Exit **2** indicates invalid input or an execution error; read stderr.

For OpenAPI, explicitly download the pinned oasdiff engine, then compare the fictional contracts:

```sh
pnpm engine:setup
pnpm --silent self-managed-api compare fixtures/orders-v1.json fixtures/orders-v2.json --engine work/tools/oasdiff/oasdiff --json
```

Use `work/tools/oasdiff/oasdiff.exe` on Windows. This fixture also exits 1. Engine setup needs network access and `tar`; later local comparisons do not download anything. JSON Schema and MCP comparisons do not require oasdiff.

JS/TS discovery covers bounded native-fetch patterns. Python and Java use explicitly selected source/tests and reviewed recipes; automatic call discovery is not implemented for those languages. Validation requires prepared Linux x64 Docker profiles and compares unchanged tests against original and candidate in separate copies. A successful test does not prove all business behavior. Model use, test execution and draft PR publication each require their own approval; nothing merges or deploys automatically. CLI approvals require terminal confirmation of the exact request identifier. SDK approval functions trust their caller and do not authenticate a human reviewer.

Models and GitHub are optional integrations. Configure your own local model or provider credentials if you choose inference, and your own GitHub credentials if you choose publication. Ordinary inspection and local worker observation require neither. Native service manifests are generated for review; they do not install a service or grant code execution.

The maintained [technical guide](docs/technical-guide.pdf) and its [HTML source](docs/technical-guide.html) cover SDK installation in another application, observation, proposals, approvals, Docker validation, native services and optional public TUF updates. The updater stages a verified package; installation remains separate. No official hosted update feed or trust identity is bundled.

To check the checkout locally, run `pnpm engine:setup` and `pnpm check`; use the documented Linux preparation before `pnpm test:isolated`. To regenerate the guide, install this repository's development dependencies and Playwright Chromium (`pnpm exec playwright install chromium`), then run `pnpm docs:build` and `pnpm docs:check`. The build checks each page for overflow and binds the PDF to the source hash and package version. Keep source and PDF together when contracts change.

Run `pnpm release:build` manually to produce a platform archive with its own CLI runtime. Extract the complete directory. Optional native signing and public TUF signing use operator-provisioned keys and preserve explicit signature status; checksums alone do not establish publisher identity. Publishing the resulting files is a separate manual action. See the guide for release inputs and trust bootstrap.

Keep state, model credentials, proposals and approval receipts outside the consumer checkout and Git. See [AGENTS.md](AGENTS.md) for contribution conventions.
