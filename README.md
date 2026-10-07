# Plumber

Local tools for maintaining integrations with external APIs. Plumber compares API contracts, locates potentially affected TypeScript/JavaScript calls, prepares explicit migration proposals and validates approved changes in isolated copies.

**Status:** private, unpublished alpha. The SDK and CLI run locally. GitHub publication, MCP observation, AI-assisted recipes and the Cloud application are not implemented yet. This repository requires no hosted Plumber service.

## What works today

| Capability | Current scope |
| --- | --- |
| Contract comparison | Local OpenAPI 3.0.x/3.1.x JSON, using a pinned oasdiff executable |
| Consumer inspection | Bounded TS/JS syntax analysis of supported native `fetch` calls; unresolved usages remain explicit |
| Migration proposals | Caller-supplied recipes with exact edits, hashes and business decisions |
| Validation | Explicit approval, baseline/candidate tests and recovery on a fixed Linux x64 Docker profile |
| Local worker | SQLite subscriptions, review jobs, approved execution queues and explicit `--once` cycles |
| Publication preparation | Local evidence tied to Git HEAD, index and blobs; no branch or PR is created |

Code, patches, private schemas, raw logs and credentials stay in the customer's environment. Importing the SDK starts no worker, opens no database and executes no consumer code. A future authorized model provider would receive selected context directly from the local runner, never through Plumber Cloud.

## Prerequisites

- Node.js **24.x**, minimum **24.11.1**, and pnpm **11.19.0**.
- Project dependencies available in the local pnpm store for offline installation.
- The pinned **oasdiff 1.33.0** binary for contract comparison and the test suite.
- Git supporting `--no-lazy-fetch` for publication preparation and the ordinary test suite.
- A prepared Linux x64 Docker host for consumer test execution only. Windows/macOS support inspection and planning; execution there returns `blocked`.

## Quick start from this checkout

Run from the repository root. With dependencies already cached and the engine provisioned:

```sh
pnpm install --offline --frozen-lockfile
pnpm build
pnpm plumber --help
```

Compare the supplied **fictional** Orders API contracts on Windows:

```powershell
pnpm --silent plumber compare fixtures/orders-v1.json fixtures/orders-v2.json --engine work/tools/oasdiff/oasdiff.exe --json
```

On Linux/macOS:

```sh
pnpm --silent plumber compare fixtures/orders-v1.json fixtures/orders-v2.json --engine work/tools/oasdiff/oasdiff --json
```

Expect `status: "breaking-changes"` and exit code **1**: the second contract requires `region` and replaces `total` with `amount`. This is the expected comparison result, not a command failure. Comparing a file with itself exits **0**; invalid input or engine failure exits **2**. Errors are JSON on stderr. Omit `--json` for readable output.

The examples use `pnpm --silent` for JSON output so the package manager does not prepend its script banner. The installed `pnpm exec plumber` command invokes the CLI directly.

**First-time provisioning requires network access.** When permitted, `pnpm install --frozen-lockfile` downloads dependencies and `pnpm engine:setup` downloads the pinned official engine, verifies its archive checksum and retains its license under `work/tools/oasdiff`. The installer requires the system `tar` executable. These setup actions are separate from normal SDK/CLI use; comparisons never download the engine automatically. An offline installation fails if its cached dependencies are missing.

## Use the SDK

Import the package's public entry point from an ESM application. This example uses the same fixture paths when run from this checkout after building:

```js
import { compareOpenApi } from 'plumber';

const report = await compareOpenApi({
  basePath: './fixtures/orders-v1.json',
  revisionPath: './fixtures/orders-v2.json',
  enginePath: process.platform === 'win32'
    ? './work/tools/oasdiff/oasdiff.exe'
    : './work/tools/oasdiff/oasdiff',
});

console.log(report.status, report.changes);
```

TypeScript consumers use the same package name, including types:

```ts
import { compareOpenApi, type CompareOptions, type ComparisonReport } from 'plumber';

const compare: (options: CompareOptions) => Promise<ComparisonReport> = compareOpenApi;
```

Use ESM with TypeScript's `NodeNext` module resolution and Node type declarations. The package export map resolves build files internally. Consumers do not import `dist`, `src`, or other internal paths. Node also resolves `plumber` by its public name from this checkout.

## Install into another local project

Create a local archive from this repository. Packing builds the SDK and CLI first; it does not publish anything:

```sh
pnpm pack --pack-destination work/packages
```

From the receiving project's directory, install the archive using its actual absolute path:

```sh
pnpm add --offline --ignore-scripts "/absolute/path/to/plumber/work/packages/plumber-0.0.0.tgz"
pnpm exec plumber --help
```

On Windows, use the corresponding quoted path, for example `"D:/projects/plumber/work/packages/plumber-0.0.0.tgz"`. The receiving project uses `import { compareOpenApi } from 'plumber'` and supplies its own contract files and trusted engine path. Fixtures and the engine are not bundled in the package. Offline installation requires the runtime dependencies in that machine's pnpm store.

| Context | CLI invocation |
| --- | --- |
| Developing this repository | `pnpm plumber <command>` after a build |
| Project with the archive installed | `pnpm exec plumber <command>` |
| SDK consumer | Named imports from `plumber` |

Do not install an unrelated registry package using this development name. The final package scope and public distribution remain undecided; no global install or production server is needed.

## Follow the maintenance workflow

1. **Inspect:** use `scan` and `impact` to find supported call sites and unresolved usages.
2. **Propose:** use `plan` with an explicit recipe. Review the call and parser changes and their business assumptions.
3. **Authorize and validate:** review `validation-plan`, then use `approve` and `validate` on a prepared Linux host. Approval is separate from planning and expires after 15 minutes.
4. **Repeat locally:** register a `subscribe` source, run `worker --once`, then review jobs. `job-plan`, `job-approve`, `job-queue` and `run-approved` handle approved execution; `recover-approved` reconciles interrupted attempts.
5. **Prepare publication evidence:** `publication-plan` requires a completed validation and a committed consumer repository. The output remains unapproved and its remote destination unverified.

Use the [local workflow reference](docs/local-workflow.md) for executable examples, state-directory setup, command outcomes, limits and recovery instructions. Read the [fictional migration guide](fixtures/migration-guide.md) before trying the sample recipe. Approval never grants permission to publish, merge or deploy.

## Development and checks

| Command | Purpose |
| --- | --- |
| `pnpm build` | Compile the SDK, CLI and type declarations |
| `pnpm typecheck` | Check types without emitting files |
| `pnpm test` | Build and run the ordinary test suite, including real contract comparisons |
| `pnpm test:package` | Pack and install into an offline test consumer; verify the public import, types, CLI and package boundary |
| `pnpm check` | Run type checks, the ordinary suite and the package check in order |
| `pnpm test:isolated` | Run real Docker integrations on the prepared Linux x64 host |
| `pnpm dev` | Show the delivery queue and active milestone |
| `pnpm dev:check` | Run project checks without changing delivery status |

The comparison engine must be installed before checks; missing infrastructure fails explicitly rather than skipping coverage. The package check reuses the cached dependency versions and performs no registry publication. The Docker suite requires its pinned image to be provisioned separately; see the [execution prerequisites](docs/local-workflow.md#approve-and-validate-captured-copies).

CI is configured for Windows, Linux and macOS, with a separate real Docker job. Running checks locally does not trigger CI, push commits or deploy. Follow the branch conventions in [AGENTS.md](AGENTS.md). Keep credentials, local state, archives and intermediate files out of Git; `work/` is ignored.

## Limits and troubleshooting

| Symptom or result | Meaning and next step |
| --- | --- |
| Engine missing or rejected | Provision the pinned binary explicitly and pass its actual path; use `.exe` on Windows |
| Offline install cannot resolve a dependency | Populate the local package store during a separately permitted setup; do not expect an offline fallback download |
| Consumer calls are unresolved | Supported syntax inspection is incomplete; review wrappers, dynamic URLs or SDK calls manually |
| Validation is `blocked` | Inspect the local outcome for unsupported host, missing Docker/image, resource limits or uncertain cleanup |
| Approval is stale, expired or consumed | Review current evidence and issue a new approval; never delete attempt markers to retry |
| Publication preparation rejects a fixture directory | Use the exact root of a separate committed Git repository, selected before observation and validation |

Structural diffs and passing selected tests do not prove full provider compatibility. JSON artifacts may contain source code and private evidence; keep them local. Docker uses a privileged local daemon and shared kernel, and same-account tampering is outside the trust boundary. Detailed restrictions and retained recovery evidence are documented in the [workflow reference](docs/local-workflow.md).

## Project map and licensing

- [Implementation plan](docs/implementation-plan.md): architecture, privacy boundaries and remaining release gates.
- [Delivery queue](tooling/delivery.json): implemented milestones and current work.
- [Plumber Cloud](https://github.com/Altitud-Studio-S-L-U/plumber-cloud): separate repository for the planned landing page, dashboard and coordination API.

Runtime dependencies are Node built-ins and `@babel/parser` 8.0.6 (MIT), with its resolved Babel dependencies. The lockfile pins TypeScript (Apache-2.0), Node type declarations (MIT) and resolved dependencies. pnpm is MIT; oasdiff is Apache-2.0 and its license is retained with the installed binary. Dependency lifecycle scripts are disabled by the workspace policy.

This repository is private and `UNLICENSED`. Apache-2.0 distribution remains a proposal requiring a separate licensing and publication decision; the implementation plan is not a license grant.
