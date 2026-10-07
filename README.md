# Plumber

**Planning baseline; no implementation yet.**

Plumber is a proposed TypeScript SDK, CLI, and optional local worker for teams maintaining integrations with external APIs and MCP servers. It will observe subscribed sources, identify affected consumer code, present an impact assessment and migration plan, and prepare validated changes after authorization.

The intended workflow preserves existing SDKs, native calls, parsers, and adapters. Plumber is not a mandatory request proxy or a dependency that must run inside a production application.

Code, patches, detailed logs, and repository credentials remain in the customer's environment. An explicitly authorized AI provider may receive selected context directly from the local runner; the Plumber SaaS will not receive it.

This repository owns:

- The local SDK, CLI, worker, source adapters, and migration engine.
- Versioned shared protocol/contracts, distributed as a package consumed by the cloud product.
- Local validation, authorization, isolation, and Git publication behavior.

The companion [plumber-cloud repository](https://github.com/Altitud-Studio-S-L-U/plumber-cloud) owns the public landing page, account management, dashboard, coordination backend, and cloud integrations.

Read the [implementation plan](docs/implementation-plan.md) for scope, architecture, delivery phases, and acceptance criteria. The proposed baseline is Node.js 24, TypeScript, pnpm, SQLite through `better-sqlite3`, and a pinned local `oasdiff` executable.

No executable package, implementation, test result, release, or public license is provided by this planning baseline. Package names and scopes require availability checks. Public distribution under Apache-2.0 is a proposal, not a license grant for this private repository.
