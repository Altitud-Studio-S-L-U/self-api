# Plumber

**Early development: local contract comparison.** The worker, consumer-code analysis, migrations, approvals, and Cloud connection are planned, not implemented.

Plumber is a TypeScript SDK and CLI being developed to maintain integrations with external APIs and MCP servers. The intended product will observe subscribed sources, identify affected consumer code, present an impact assessment and migration plan, and prepare validated changes after authorization.

The intended workflow preserves existing SDKs, native calls, parsers, and adapters. Plumber is not a mandatory request proxy or a dependency that must run inside a production application.

Code, patches, detailed logs, and repository credentials remain in the customer's environment. An explicitly authorized AI provider may receive selected context directly from the local runner; the Plumber SaaS will not receive it.

This repository owns:

- The local SDK, CLI, worker, source adapters, and migration engine.
- Versioned shared protocol/contracts, distributed as a package consumed by the cloud product.
- Local validation, authorization, isolation, and Git publication behavior.

The companion [plumber-cloud repository](https://github.com/Altitud-Studio-S-L-U/plumber-cloud) owns the public landing page, account management, dashboard, coordination backend, and cloud integrations.

## Run the first local comparison

Use a current Node.js 24 LTS patch (minimum 24.11.1), pnpm 11.19.0, and the system `tar` executable. From this checkout:

```sh
pnpm install --frozen-lockfile
pnpm engine:setup
pnpm check
node dist/cli.js compare fixtures/orders-v1.json fixtures/orders-v2.json --engine work/tools/oasdiff/oasdiff.exe --json
```

On Linux/macOS, use `work/tools/oasdiff/oasdiff` without `.exe`. These fixtures describe a **fictional** provider: version two requires a new `region` parameter and replaces the response's `total` property with `amount`. The comparison exits with code **1** because it detects breaking changes. Comparing a file with itself exits **0**; invalid input or an engine failure exits **2**. Errors are JSON on stderr; `--json` writes the report alone to stdout. Omit `--json` for readable text.

`engine:setup` explicitly downloads the pinned official oasdiff release, verifies its archive SHA-256 against the committed manifest, and installs it under ignored `work/tools/oasdiff`. It requires network access. Comparison itself neither downloads an engine nor uploads contracts. The installer includes artifact pins for Windows/Linux x64 and arm64, and macOS x64/arm64; platform compatibility must be confirmed by the corresponding CI run.

The SDK exposes the same operation:

```js
import { compareOpenApi } from './dist/index.js';

const report = await compareOpenApi({
  basePath: './fixtures/orders-v1.json',
  revisionPath: './fixtures/orders-v2.json',
  enginePath: './work/tools/oasdiff/oasdiff.exe',
});

console.log(report.status, report.changes);
```

## Current boundary

- Local OpenAPI 3.0.x/3.1.x JSON files only, at most 4 MiB and 128 nesting levels. External references, custom dialects, `$id`, dynamic references/anchors, reusable `components.pathItems`, and root webhooks are rejected. Inputs must be regular files without symlinked ancestors; URLs, UNC/device paths, stdin, Git refs, and alternate data streams are not supported. No remote fetching, YAML, SDK discovery, MCP observation, or code changes yet.
- Captured input digests and API/specification versions identify the compared evidence. The local engine validates both contracts before comparing immutable temporary copies.
- Structural breaking-change findings only. `no-breaking-changes` does not prove consumer compatibility or unchanged business semantics; every report says `consumerImpact: not-analyzed`. Additive and prose-only changes can set `contentChanged` without producing breaking findings.
- The runner disables external references, passes its own empty engine configuration, and filters the child environment. It does not run consumer scripts. Process timeout and output limits are applied; this process is not a container sandbox or a hard memory limit.
- The executable path is explicitly authorized by the caller. Runtime version checking is not proof of binary authenticity: protect the installed binary and use the checksum-verifying setup command or your own trusted distribution process.
- Reports remain local and may contain private operation names or schema descriptions. They are not the future Cloud transmission contract. No AI provider, Cloud client, telemetry, or runtime API proxy is included.

## Development and dependencies

`pnpm check` type-checks, builds, and runs Node's test runner, including comparisons against the real pinned engine. Install the engine first; engine absence fails tests rather than skipping integration coverage. CI defines the same checks on Windows, Linux, and macOS. No checks can demonstrate behavior for source types or product phases not implemented here.

Production JavaScript uses Node built-ins. Development dependencies are pinned in `pnpm-lock.yaml`: TypeScript (Apache-2.0), Node type definitions (MIT), and their resolved dependencies. pnpm is MIT; [oasdiff](https://github.com/oasdiff/oasdiff/tree/v1.33.0) is Apache-2.0 and its LICENSE is preserved alongside the installed binary. Dependency lifecycle scripts are not authorized by the checked-in pnpm configuration.

Read the [implementation plan](docs/implementation-plan.md) for the remaining architecture and acceptance criteria. The next useful slice connects contract findings to actual TypeScript consumer usages and parsers; persistence and the resident worker follow demonstrated needs. The Cloud product follows the local workflow.

The package is private and unpublished. Do not install an unrelated package from npm using this development name. Package scope and distribution require availability checks. Public distribution under Apache-2.0 remains a proposal, not a license grant for this private repository.
