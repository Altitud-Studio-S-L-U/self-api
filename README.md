# Keepseam Client

Local tools for maintaining integrations with external APIs. Keepseam compares API contracts, locates potentially affected TypeScript/JavaScript calls, prepares explicit migration proposals and validates approved changes in isolated copies.

The SDK and CLI run in the customer's environment. Local observation, optional model proposals and separately authorized GitHub draft publication are implemented. The GitHub transport is tested with controlled responses; a live publication pilot remains a release gate. Keepseam Cloud has a separate development environment for accounts, organization management, internal administration and authenticated worker status. No hosted Keepseam service is required for the local workflow.

## What works today

| Capability | Current scope |
| --- | --- |
| Contract comparison | Local OpenAPI 3.0.x/3.1.x JSON, using a pinned oasdiff executable |
| MCP and JSON Schema | Complete local MCP catalog captures and an explicit JSON Schema structural profile, with input/output compatibility direction |
| Evidence sources | Persistent local and explicit HTTPS subscriptions for contracts, MCP catalogs, schemas, JSON examples and text documentation; examples and prose never establish compatibility |
| Integration catalog | Separate API/SDK/webhook/MCP versions, source provenance, retirement evidence and optional function boundary metadata |
| Dependency evidence | npm lockfile v2/v3 inventory and correlation against supplied advisories listing exact versions |
| Consumer inspection | Bounded TS/JS analysis of native `fetch` and explicitly bound MCP `callTool` calls, including direct structured-output reads; unresolved usages remain explicit |
| Migration proposals | Caller-supplied recipes with exact edits, hashes and business decisions |
| Validation | Explicit approval, baseline/candidate tests and recovery on a fixed Linux x64 Docker profile |
| Local worker | SQLite subscriptions, review jobs, approved execution queues, one-shot/finite observation and a persistent observation service with native supervisor definitions |
| Optional model harness | Selected context, explicit one-use consent, customer-selected adapter, bounded structured proposals and mandatory semantic review |
| GitHub publication | Separate approval, exact repository/base/file bindings, create-only branch, draft PR and read-only reconciliation of uncertain writes |
| Cloud coordination | Versioned status allowlist, local P-256 identity, DPoP transport and persistent opt-in status outbox; owner-approved enrollment in Cloud |

Code, patches, private schemas and raw logs are excluded from the Cloud status protocol. Importing the SDK starts no worker, opens no database and executes no consumer code. An explicitly authorized customer model can receive selected context; authorized publication sends the approved changes directly to the customer's GitHub repository. Neither route passes through Keepseam Cloud.

## Architecture and local state

The CLI and SDK share the same TypeScript implementation. Contract comparison and consumer inspection produce evidence; planning binds that evidence to exact edits and selected tests. The local worker persists observations and queues separately approved execution. Model and GitHub adapters are explicit external boundaries, with independent authorization from test execution.

| Boundary | Implementation | Data and responsibility |
| --- | --- | --- |
| Public SDK and CLI | `src/index.ts`, `src/cli.ts` | Exported operations, types and command input validation |
| Contracts and usage | `src/contracts.ts`, `src/consumer-contracts.ts`, `src/integration-registry.ts` | Snapshot hashes, comparison reports, call sites and version/source provenance |
| Observation | `src/worker.ts`, `src/source-observer.ts`, `src/http-source.ts` | Local or explicitly permitted HTTPS capture and immutable evidence |
| Persistent service | `src/worker-service.ts`, `src/worker-service-config.ts` | Serialized observation, private bounded operational state and systemd/launchd/Windows SCM definitions |
| Execution | `src/job-validation.ts`, `src/migration-validation.ts`, `src/docker-runner.ts` | Approval binding, isolated baseline/candidate validation and recovery |
| Optional external actions | `src/model-harness.ts`, `src/publication-runner.ts`, `src/github-publication.ts` | Selected model context and approved GitHub draft publication |
| Cloud exchange | `src/cloud-protocol.ts`, `src/cloud-connection.ts`, `src/cloud-sync.ts` | Versioned allowlist, key-bound transport and retryable local outbox |

State belongs in a dedicated private directory outside the consumer checkout. `worker.sqlite3` contains subscriptions, immutable snapshots, observations, review jobs and execution intents. `source-observations.sqlite3` stores the additional source catalogs and their transitions. Approval receipts, attempt markers and validation outcomes remain local files. These databases use Node's built-in SQLite; the client does not require PostgreSQL, a hosted queue or a Keepseam account.

The public TypeScript contracts and their runtime validators define the supported artifact shapes. Local evidence may include private code or schemas; the separate Cloud status contract accepts only its explicit fields. Do not copy local evidence into a Cloud event or edit database rows to bypass an approval. See the [state and recovery procedures](docs/local-workflow.md#persist-local-subscriptions-and-observe-once) before operating a persistent worker.

## Prerequisites

- Node.js **24.x**, minimum **24.11.1**, and pnpm **11.19.0**.
- Project dependencies available in the local pnpm store for offline installation.
- The pinned **oasdiff 1.33.0** binary for contract comparison and the test suite.
- Git supporting `--no-lazy-fetch` for publication preparation and the ordinary test suite. Verify the selected executable with `git --no-lazy-fetch --version`; older system Git installations can lack this capability. Keepseam fails before repository plumbing and never removes this protection as a fallback.
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

Keepseam is the product name. The package `plumber`, CLI command `plumber`, `plumber/protocol` export, environment variables and stored protocol identifiers retain their existing names for compatibility. This name change does not migrate local state or publish a package to npm.

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
pnpm add --offline --ignore-scripts "/absolute/path/to/keepseam-client/work/packages/plumber-0.0.0.tgz"
pnpm exec plumber --help
```

On Windows, use the corresponding quoted path, for example `"D:/projects/keepseam-client/work/packages/plumber-0.0.0.tgz"`. The receiving project uses `import { compareOpenApi } from 'plumber'` and supplies its own contract files and trusted engine path. Fixtures and the engine are not bundled in the package. Offline installation requires the runtime dependencies in that machine's pnpm store.

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
5. **Publish separately:** `publication-plan` prepares local evidence. Destination review, explicit publication approval and GitHub publication are separate steps. Uncertain responses require reconciliation; no automatic merge, deployment, branch overwrite or write retry is performed.

Use the [local workflow reference](docs/local-workflow.md) for SDK/CLI examples, MCP and schema profiles, model consent, state-directory setup, publication and recovery. Read the [fictional migration guide](fixtures/migration-guide.md) before trying the sample recipe. Validation approval never grants permission to publish, merge or deploy.

Try MCP comparison without an engine or server connection:

```sh
pnpm --silent plumber mcp-compare fixtures/mcp/catalog-before.json fixtures/mcp/catalog-after.json --json
pnpm --silent plumber integration-check fixtures/integration-manifest.json --json
```

The MCP fixture changes both an input and a parsed output. Expect comparison exit code **1**. Its files and the integration manifest are fictional examples, not maintained provider catalogs. `mcp-impact` can associate these changes with explicitly bound calls and direct parser reads. HTTPS observation requires an explicit source policy and `--http`; it fetches only the selected URL, without crawling documentation or discovering versions. Framework/DB export execution remains outside this profile. See the [source and impact instructions](docs/local-workflow.md#mcp-schemas-examples-and-documentation).

## Development and checks

For a persistent local development environment, use the [Compose development guide](docs/local-workflow.md#persistent-local-development-with-compose). It starts a fictional payments provider and a separate consumer, seeds editable data once, and keeps the SDK worker's SQLite state between restarts. You can retire the provider version, inspect the resulting job, review its exact plan and authorize validation separately. This environment is distinct from the disposable integration test suite.

| Command | Purpose |
| --- | --- |
| `pnpm build` | Compile the SDK, CLI and type declarations |
| `pnpm typecheck` | Check types without emitting files |
| `pnpm test` | Build and run the ordinary test suite, including real contract comparisons |
| `pnpm test:package` | Pack and install into an offline test consumer; verify the public import, types, CLI and package boundary |
| `pnpm check` | Run type checks, the ordinary suite and the package check in order |
| `pnpm test:isolated` | Run real Docker integrations on the prepared Linux x64 host |
| `pnpm dev` | Show the delivery queue and active milestone |
| `pnpm dev:local --help` | Seed and operate the persistent fictional Compose development environment |
| `pnpm dev:apis --help` | Operate the separate real-documentation/native-SDK laboratory; see its guide for opt-in Cloud sync |
| `pnpm dev:check` | Run project checks without changing delivery status |

The comparison engine must be installed before checks; missing infrastructure fails explicitly rather than skipping coverage. The package check reuses the cached dependency versions and performs no registry publication. The Docker suite requires its pinned image to be provisioned separately; see the [execution prerequisites](docs/local-workflow.md#approve-and-validate-captured-copies).

The [fictional payments scenarios](docs/local-workflow.md#exercise-a-fictional-payments-provider) use real HTTP/TLS sockets. They cover API retirement, required request fields, nested decimal amounts, currency integrity, rate limits and provider failures. The Linux Docker suite runs the approved worker migration and HTTPS capture inside the existing network-isolated profile. No real payment provider or account is contacted.

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

The shared status encoder is imported from `plumber/protocol`. It validates a small allowlist; an encoder alone does not authenticate installations or prove a reported outcome. The separate Cloud transport authenticates and scopes status delivery. Remote approval/execution, Slack delivery, live provider pilots and public package distribution remain release gates. Model and Git adapters are trusted customer code, not sandboxes. Source expansion does not imply automatic migration support for every SDK or MCP call style.

## Run a persistent worker

Use the [service operation guide](docs/worker-service.md) for complete configuration, least-privilege filesystem preparation, native installation, status, shutdown and upgrade procedures. `plumber worker-service run --config <absolute-json>` stays in the foreground under systemd, launchd or Windows SCM/WinSW. `render` creates a reviewable supervisor definition; it does not install a service. The private `plumber/cli` export resolves the installed CLI entry point without importing a build path in application code.

The service observes registered OpenAPI and source profiles, creates review jobs and can synchronize explicitly shared status to Cloud. It never grants approvals, executes consumer tests or installs updates. A separate SQLite lock excludes concurrent service ownership and releases on process loss; the native manager owns boot and restart. Logs are sanitized and rotate locally. Long observation batches can delay Cloud heartbeats; supervisor restart is not a hung-process watchdog.

## Connect worker status to Cloud

Follow the [connection procedure](docs/local-workflow.md#connect-an-approved-worker-to-cloud) for complete identity generation, enrollment, private credential assembly, integration binding and synchronization examples. Identity/enrollment are public SDK APIs; the product CLI does not yet have enrollment commands. The persistent service can synchronize approved metadata using a private credential-file reference. The separate [real API laboratory](dev/real-apis/README.md#connect-the-actual-worker) supplies development-only `cloud-sync` and `worker` helpers.

Generate an identity with `generateCloudWorkerIdentity()` from `plumber`. Keep its `privateJwk` in customer-controlled secret storage. Give the Cloud organization owner/admin only `{ installationId, publicJwk, fingerprint }`. In the worker panel, they enroll the installation using a recently verified passkey, compare the fingerprint independently and activate it. Enrollment returns a client secret **revealed once** and an opaque Cloud project identifier; combine these locally with the private key to create a `CloudCredentials` object. The secret is reusable for token exchange until expiry/revocation, not a single-use token. HTTPS is required; `allowLocalHttp: true` permits only an explicit loopback development origin.

Bind each approved local subscription separately. Its public identifier is `deriveCloudIdentifier(localSubscriptionId, installationId)` from `plumber/protocol`; the Cloud owner associates it with an enabled integration in the same project. This consent does not permit uploading the subscription's documents or code.

```ts
import { readFile } from 'node:fs/promises';
import { syncWorkerToCloud, type CloudCredentials } from 'plumber';

const credentialPath = process.env.KEEPSEAM_WORKER_CREDENTIAL_FILE;
const approvedLocalSubscriptionId = process.env.KEEPSEAM_LOCAL_SUBSCRIPTION_ID;
if (!credentialPath || !approvedLocalSubscriptionId) throw new Error('Select a private credential file and an approved local subscription.');
const credentials: CloudCredentials = JSON.parse(await readFile(credentialPath, 'utf8'));

const result = await syncWorkerToCloud({
  statePath: './work/worker',
  cloudStatePath: './work/cloud',
  credentials,
  integrationIds: [approvedLocalSubscriptionId],
});
```

Both state directories must remain outside consumer codebases. `integrationIds` is mandatory: select 1–100 existing local subscription IDs, not Cloud UUIDs or their derived public IDs. The outbox stores enum states, counts and opaque identifiers, never credentials or local artifacts. A sync sends at most 50 events, with at most 1,000 pending and sequence numbers 0–1,000,000. Lost acknowledgements retain the exact event for retry. Keep SQLite state; a reset cannot safely reuse the same enrollment. A renewable lease excludes concurrent syncs. The [workflow reference](docs/local-workflow.md#sync-results-retries-and-limits) explains pending/busy results, expiry and exhausted-state recovery. Cloud failure does not alter local jobs, approvals or execution.

The transport obtains a DPoP-bound token valid for at most five minutes. Cloud limits token issuance to ten per minute per installation and checks current revocation for every request. The enrollment credential expires after 90 days; enroll a replacement explicitly and revoke the previous installation. Reusable `createCloudTransport(credentials)` is available for applications emitting their own protocol events. No signing key or client secret belongs in Git, logs or Cloud status messages.

Maintenance timestamps retain the local job creation or execution update time, including after an offline period; heartbeat timestamps describe the current sync. These reports do not attest the provider's most recent observation, deployment or complete compatibility. Selected/passing test counts describe selected test targets, not individual framework test cases. Cloud can display status and send an optional attention email; approving changes and executing tests remain local.

## Project map and licensing

- [Implementation plan](docs/implementation-plan.md): architecture, privacy boundaries and remaining release gates.
- [Delivery queue](tooling/delivery.json): implemented milestones and current work.
- [Keepseam client](https://github.com/Altitud-Studio-S-L-U/keepseam-client): this SDK, CLI, local worker and versioned status protocol.
- [Keepseam Cloud](https://github.com/Altitud-Studio-S-L-U/keepseam-cloud): the ES/EN landing page, passwordless accounts, organization workspace, internal administration and scoped worker enrollment/status ingestion. Deployment and commercial activation remain separate operations.
- [Keepseam infrastructure](https://github.com/Altitud-Studio-S-L-U/keepseam-infra): provisioning and deployment of Keepseam Cloud on the selected provider, OVHcloud. The service and region remain to be confirmed; the infrastructure design is not a deployed environment. This choice does not change the client's local execution requirements.

Runtime dependencies are Node built-ins, `@babel/parser` 8.0.6 (MIT) and `jose` 6.2.12 (MIT). JOSE implements standard ES256 proof signing and JWK thumbprints. The lockfile pins TypeScript (Apache-2.0), Node type declarations (MIT) and resolved dependencies. pnpm is MIT; oasdiff is Apache-2.0 and its license is retained with the installed binary. Dependency lifecycle scripts are disabled by the workspace policy.

The source is `UNLICENSED`; public distribution has not been authorized. Apache-2.0 distribution remains a proposal requiring a separate licensing and publication decision; the implementation plan is not a license grant.
