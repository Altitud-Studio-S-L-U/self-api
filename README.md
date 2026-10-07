# Plumber

**Early development: local observation, potential impact, migration proposals, and explicitly approved isolated validation.** Explicit worker cycles persist subscriptions, review jobs, authorized execution and recovery evidence. A local publication preflight binds validated changes to Git evidence; remote verification and publication, resident scheduling, live checkout adoption, and Cloud connection remain planned.

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

- Local OpenAPI 3.0.x/3.1.x JSON files only, at most 4 MiB and 128 nesting levels. External references, custom dialects, `$id`, dynamic references/anchors, reusable `components.pathItems`, and root webhooks are rejected. Inputs must be regular files without symlinked ancestors; URLs, UNC/device paths, stdin, Git refs, and alternate data streams are not supported. No remote fetching, YAML, SDK call mapping, or MCP observation yet. Authorized validation changes only an isolated captured copy.
- Captured input digests and API/specification versions identify the compared evidence. The local engine validates both contracts before comparing immutable temporary copies.
- Structural breaking-change findings only. `no-breaking-changes` does not prove consumer compatibility or unchanged business semantics; every report says `consumerImpact: not-analyzed`. Additive and prose-only changes can set `contentChanged` without producing breaking findings.
- The comparison engine disables external references, uses its own empty configuration, and receives a filtered environment. Comparison does not run consumer scripts. Engine process timeout and output limits are applied; this engine process is not a container sandbox or a hard memory limit. Consumer execution uses the separate Docker profile described below.
- The executable path is explicitly authorized by the caller. Runtime version checking is not proof of binary authenticity: protect the installed binary and use the checksum-verifying setup command or your own trusted distribution process.
- Reports remain local and may contain private operation names or schema descriptions. They are not the future Cloud transmission contract. No AI provider, Cloud client, telemetry, or runtime API proxy is included.

## Inspect consumer usage

```sh
node dist/cli.js scan fixtures/consumer --json
node dist/cli.js impact fixtures/orders-v1.json fixtures/orders-v2.json --consumer fixtures/consumer --provider-base-url https://orders.example.invalid --engine work/tools/oasdiff/oasdiff.exe --json
```

The SDK equivalents are `scanConsumer(directory)` and `analyzeImpact({ basePath, revisionPath, enginePath, consumerRoot, providerBaseUrl })`. `scan` captures TS/JS syntax and package manifests without loading application modules, resolving imports, reading Babel/project configuration, installing consumer dependencies, or running scripts. The AST parser is an explicitly pinned dependency of Plumber.

Supported native `fetch` calls expose file/line evidence, a known method and origin, and a path pattern where possible. A static absolute URL or an encoded template path segment can be associated with a changed operation under the explicitly supplied provider base URL. Matching supports whole parameter segments such as `/orders/{id}`; partial segments such as `/files/{id}.json` remain unmapped. Query values and URL credentials are not included in call evidence. Direct JSON response property reads are limited evidence, not complete parser or data-flow analysis. Aliases, dynamic URLs, wrappers, SDK calls, and indirect parsing require further analysis; an empty result never proves absence of integrations or impact.

Dependency inventory contains **declared ranges**, not verified installed versions or vulnerability findings. URL, Git, file, and other unrecognized specifiers use a null range rather than exposing possible credentials or private paths. Candidate validation scripts contain their names and command hashes, not raw commands, with execution marked `not-authorized`. No scan command authorizes their execution. These local reports still contain private metadata and are not a Cloud transmission contract.

Capture is limited to 500 source/manifest files, 2,000 directory entries, 1 MiB per file, 16 MiB total, and 20 directory levels. Hidden entries, declarations, dependencies, build output, and symlinks are omitted with reasons; symlinked roots are rejected. Limits and unreadable inputs fail explicitly. Content digests describe captured evidence, not an atomic Git checkout or an exhaustive repository analysis.

`scan` exits 1 when calls are unresolved or inspection issues exist. `impact` exits 1 whenever the contract has breaking findings, including findings with no observed consumer match. Every impact report requires review and distinguishes potentially matched operations, unmapped changes, and unresolved calls. It does not claim a migration is necessary, sufficient, or validated.

## Preview an explicit migration

```sh
node dist/cli.js plan fixtures/orders-v1.json fixtures/orders-v2.json --consumer fixtures/migration-consumer --provider-base-url https://orders.example.invalid --engine work/tools/oasdiff/oasdiff.exe --recipe fixtures/orders-migration.json --json
```

The SDK exposes `createMigrationPlan({ ...impactOptions, recipe })`. A recipe supplies its summary, explicit business decisions, source paths and expected hashes, and exact unique replacements. Recipes are supplied by the caller at this stage; they are not inferred automatically from a schema diff. The fictional guide in `fixtures/migration-guide.md` explains both the `total`/`amount` equivalence and the existing source of `region`.

Planning captures current evidence, rejects stale or ambiguous edits, builds before/after previews in memory, and checks their syntax. The plan includes the decisions, contract/consumer/recipe hashes, target-directory identity, and a content digest. A digest identifies the proposed content; it does not authenticate an approver. Edits are matched against original positions, cannot overlap, and cannot cascade through earlier replacements. Unknown fields, traversal, edits to package manifests, and unsupported source syntax are rejected.

Recipes are bounded to 1 MiB, 50 source files, 100 edits, and 100 decisions. A missing decision produces `requires-decision` with no proposed files. A `ready-for-review` plan still has `authorization: not-granted`: syntax parsing does not establish type correctness, business equivalence, test success, or permission to execute. Approval and isolated validation are separate explicit actions below; installation, live adoption, and publication are not implemented.

JSON plans contain exact source previews and private local evidence. Keep them in the customer's environment; they are not Cloud messages. Text mode shows the proposal identity, decisions, and file hashes without dumping source. Exit codes are 0 for a syntax-checked proposal, 1 for pending decisions, and 2 for invalid input or analysis failure.

Controlled tests execute only this repository's fictional fixture with a mocked provider: the old call passes against A, fails against B, and the proposed call plus parser preserves the internal model against B. This proves that fixture transformation, not a general consumer execution sandbox. The planner itself does not import, run, or modify consumer code.

## Approve and validate captured copies

The first execution profile supports a **Linux x64 host** with `/usr/bin/docker`, a local daemon at `/var/run/docker.sock`, and the pinned official Node image already available. Docker Desktop, remote contexts, rootless socket discovery, dependency installation, application services, and arbitrary package scripts are outside this profile. Windows/macOS can inspect and propose; execution returns `blocked` there. It never falls back to executing the consumer on the host.

Provision the image explicitly on the Linux validation host. This is a network operation separate from approval:

```sh
docker pull node@sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd
```

Use `validation-plan`, `approve`, then `validate` with identical source, recipe and selected tests. For the fictional fixture:

```sh
node dist/cli.js validation-plan fixtures/orders-v1.json fixtures/orders-v2.json --consumer fixtures/validation-consumer --provider-base-url https://orders.example.invalid --engine work/tools/oasdiff/oasdiff --recipe fixtures/validation-recipe.json --test orders.test.mjs --json
node dist/cli.js approve fixtures/orders-v1.json fixtures/orders-v2.json --consumer fixtures/validation-consumer --provider-base-url https://orders.example.invalid --engine work/tools/oasdiff/oasdiff --recipe fixtures/validation-recipe.json --test orders.test.mjs --state "$HOME/.plumber-local-state"
node dist/cli.js validate fixtures/orders-v1.json fixtures/orders-v2.json --consumer fixtures/validation-consumer --provider-base-url https://orders.example.invalid --engine work/tools/oasdiff/oasdiff --recipe fixtures/validation-recipe.json --test orders.test.mjs --state "$HOME/.plumber-local-state" --approval RECEIPT_ID
```

Replace `RECEIPT_ID` with the returned local approval ID. `approve` shows the before/after content, selected commands, profile and limits, then requires typing the exact request ID in an interactive terminal. There is no `--yes`, piped approval, implicit authorization, or execution during approval. A changed request must be reviewed again. The SDK exposes `prepareMigrationValidation(options)`, `approveMigrationValidation({ options, expectedRequestId, statePath, origin: 'explicit-sdk-caller' })`, and `executeMigrationValidation({ options, statePath, receiptId })`. An SDK approval represents the trusted caller's explicit intent; it does not prove a human reviewed the change.

Approvals expire after 15 minutes and bind the plan, consumer, contracts, recipe, selected tests, exact profile, and local state directory. Execution re-creates the request from current inputs and verifies those bindings. It claims the attempt exclusively before staging or execution, so parallel requests, failure, or a process crash cannot reuse the receipt. A failed attempt needs a new explicit approval. Changing the local clock or tampering with state under the same OS account is outside this trust boundary; no cryptographic identity claim is made.

Only captured source and package manifests are staged, from captured bytes. Dependencies, JSON test data, environment files, generated outputs, and omitted entries are unavailable. Select 1–20 Node test files explicitly; recipes cannot edit those selected tests. The same tests run on an original snapshot and a separate proposed snapshot. A missing import, service, or fixture is a real validation failure, never a fabricated successful result. This profile is currently useful for dependency-free contract tests; it does not replace a project's full CI. Tests that require transpilers, credentials, dependencies or network need a future separately approved execution profile.

The fixed container uses the image digest above, `--pull=never`, no network, a read-only root and snapshot, a numeric non-root user, no Linux capabilities, no-new-privileges, Docker's built-in seccomp profile, a 1 CPU / 512 MiB / 128 PID limit, and bounded temporary storage. No home directory, host environment, source checkout, credentials or Docker socket is mounted. Each baseline/candidate run has a 30-second total deadline, 1 MiB output budget and an additional bounded cleanup window. Daemon prerequisites and container removal are checked; failed cleanup prevents a successful result. See Docker's [run options](https://docs.docker.com/reference/cli/docker/container/run/), [bind-mount behavior](https://docs.docker.com/engine/storage/bind-mounts/) and [security model](https://docs.docker.com/engine/security/). A privileged local daemon and shared kernel remain part of the trust boundary; this is not a hostile multitenant execution service.

Results preserve both test outcomes: `passed` means both passed, `improved` means the baseline failed and the candidate passed, `regression` means only the candidate failed, and `failed` means both failed. Incomplete execution, unavailable infrastructure, exhausted budgets or unverified cleanup produce `blocked`. Passing selected tests does not establish provider compatibility beyond those assertions. The fictional B fixture is expected to return `improved` after fixing both call and parser. CLI exit 0 requires both passing, exit 1 preserves completed failures/improvement for review, and exit 2 indicates invalid input/authorization or blocked execution.

Use a private state directory outside the consumer; neither directory may contain the other. New state directories/files use restrictive POSIX modes; Windows relies on inherited account ACLs. `receipts/` holds approvals; `attempts/<id>/` holds the consumed marker, exact request, snapshots and result including bounded raw output. These contain private source and must remain local. Artifacts are retained for inspection; deleting a consumed marker could permit replay while a receipt remains valid, so do not remove attempt markers to retry. The durable job flow below adds explicit recovery. No state cleanup daemon, Git publication, Cloud transmission, or live checkout mutation is implemented.

## Persist local subscriptions and observe once

```sh
node dist/cli.js subscribe fixtures/orders-v2.json --baseline fixtures/orders-v1.json --consumer fixtures/consumer --provider-base-url https://orders.example.invalid --engine work/tools/oasdiff/oasdiff --state "$HOME/.plumber-local-state" --label "Fictional orders API"
node dist/cli.js worker --once --state "$HOME/.plumber-local-state" --engine work/tools/oasdiff/oasdiff --json
node dist/cli.js subscriptions --state "$HOME/.plumber-local-state" --json
node dist/cli.js jobs --state "$HOME/.plumber-local-state" --json
```

Use `.exe` for the engine on Windows. `registerLocalSubscription(options)`, `observeOnce({ statePath, enginePath, subscriptionId? })`, `listLocalSubscriptions({ statePath })`, and `listMaintenanceJobs({ statePath })` provide the SDK equivalents. Importing the SDK does not load SQLite, open a database, create state, start polling, or execute a consumer. The engine executable remains an explicit argument each cycle rather than a command loaded from the database.

A subscription fixes a local JSON source, consumer directory, provider binding and **configured baseline**. That baseline is captured once; later edits or deletion of its original file do not change it. It is not proof of an adopted or deployed API version. Configuration is immutable in this slice; repeating the same registration is idempotent, while changing the binding/baseline of an existing subscription requires a future explicit reconfiguration flow. Labels are limited to 200 UTF-8 bytes. Only local OpenAPI JSON sources are supported; no HTTP/documentation crawler, webhook, MCP adapter, resident daemon or scheduler is started.

Each explicit `--once` cycle captures the source bytes, including any UTF-8 BOM, writes owned private comparison copies, and inspects one consumer capture without executing it. Structurally invalid or incomplete inputs are failures; absence of findings does not prove compatibility. Changed bytes produce a review job even when the engine finds no structural breaking change. Jobs are keyed by subscription, baseline/revision digests, consumer digest and engine version: repeated evidence is deduplicated, a changed consumer gets new review evidence, and provider rollback preserves earlier jobs and transition history. Observing B never silently makes B the configured baseline. Adoption and deployment remain `unknown`.

State lives in `worker.sqlite3` beside the separate approval state. SQLite transactions atomically persist immutable snapshot BLOBs, subscriptions, observation transitions, review jobs and expiring ownership claims. A five-minute claim coordinates concurrent observers; its owner and generation must still match and remain unexpired at commit. An interrupted observer may be replaced after expiry, but the old observer cannot commit over its successor. Source/consumer/engine failures preserve the last successful observation and pending jobs, record a fixed reason, and release ownership for a later explicit retry. Repeating the same source after a failed analysis is allowed. Read-only observation retries are separate from execution recovery; consumed approvals are never replayed.

The store uses Node's built-in `node:sqlite`, avoiding an additional native installation step. At the minimum Node 24.11.1 runtime this API is experimental and emits its standard warning when first opened; Node documents it as a release candidate from 24.15.0. Use a current Node 24 LTS patch and retain backups of customer-owned state. See the [Node 24 SQLite API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html). The implementation uses transactions with full synchronization and the rollback journal on a regular local filesystem; network/shared filesystem coordination and remote database import are unsupported. Unknown database identities or future schema versions are rejected.

Limits are 100 subscriptions, 1,000 jobs and 1,000 observed transitions; individual contracts/reports are at most 4 MiB, with separate 64 MiB totals for snapshot bytes and report JSON. These bound stored payloads, not exact database disk usage. Exceeding a limit returns an explicit failure without pruning pending evidence or advancing freshness. No automatic retention/deletion policy is implemented. New directories/files use private modes; existing POSIX state/database paths with group/other access are rejected without changing their permissions. Windows uses inherited account ACLs. Keep the state directory private, outside the consumer, on customer-controlled storage; reports and snapshots are not Cloud messages.

`worker --once` exits 0 when the cycle completes without a current review job, 1 when a current job needs review, and 2 if any subscription is busy or fails. An unchanged current source does not close historical jobs. Use `jobs` to inspect retained evidence. Observation does not create a recipe, grant approval, execute tests, mutate source, publish to GitHub or contact Cloud.

## Queue approved jobs and recover interrupted validation

For a subscription using `fixtures/validation-consumer`, select its current job from `jobs`, then review and authorize a specific recipe and test set:

```sh
node dist/cli.js job-plan JOB_ID --state "$HOME/.plumber-local-state" --engine work/tools/oasdiff/oasdiff --recipe fixtures/validation-recipe.json --test orders.test.mjs --json
node dist/cli.js job-approve JOB_ID --state "$HOME/.plumber-local-state" --engine work/tools/oasdiff/oasdiff --recipe fixtures/validation-recipe.json --test orders.test.mjs
node dist/cli.js job-queue JOB_ID --state "$HOME/.plumber-local-state" --engine work/tools/oasdiff/oasdiff --recipe fixtures/validation-recipe.json --test orders.test.mjs --approval RECEIPT_ID
node dist/cli.js run-approved --once --state "$HOME/.plumber-local-state" --engine work/tools/oasdiff/oasdiff --json
node dist/cli.js recover-approved --state "$HOME/.plumber-local-state" --json
node dist/cli.js executions --state "$HOME/.plumber-local-state"
```

Replace `JOB_ID` and `RECEIPT_ID` with the returned identifiers. The SDK equivalents are `prepareJobValidation`, `approveJobValidation`, `queueJobValidation`, `runApprovedJobsOnce`, `recoverApprovedJobs`, and `listJobExecutions`. A job fixes the observed contract bytes, configured baseline, consumer digest and engine version. Planning, approval, queue admission and execution compare those against current evidence; changed source or consumer requires a fresh observation/review. Queue admission inspects an unexpired, unconsumed approval but does not consume it. The 15-minute approval deadline continues while queued; it is not renewed automatically.

Each receipt identifies at most one immutable execution intent. Its recipe and selected tests remain local in SQLite. Repeating queue admission with the same still-valid inputs is idempotent. The database migrates its owned v1 schema to v2 transactionally, preserving existing subscriptions and jobs; future versions and unrelated databases are rejected. Execution storage is bounded to 1,000 intents, 1 MiB per recipe, 20 selected tests and 64 MiB total recipe JSON.

`run-approved --once` takes at most one queued intent by default (`--limit 1` through `10`), optionally selected by `--intent`. A ten-minute owner/generation claim protects execution; it is checked again before consuming approval, creating/starting containers and committing results. Only queued intents are eligible to execute. A stale request blocks before execution; a consumed or uncertain attempt stays available for recovery. An interrupted intent never returns to the execution queue. A failed or expired approval requires a new explicit approval, not removal of its existing receipt or marker.

The v2 Docker profile persists an exclusive, synchronized intent before container creation and its confirmed ID before start. Labels bind the container to the local receipt, request, intent, phase and profile. Cleanup verifies these labels, image, command and mounts, removes only the verified container ID, and checks absence. A private `containers/` journal remains inside the attempt. `result.json` holds the full result; `outcome.json` is published afterwards and contains a strict summary without logs or source. Recovery validates both artifacts and their bindings before recording completion in SQLite. These summaries still belong to local state; they are not the future Cloud protocol.

`recover-approved` only reconciles expired execution claims and unresolved cleanup. It obtains a new five-minute recovery claim, then either records a durable outcome or checks/removes owned containers. It cannot start tests, grant approval or retry a consumed receipt. An attempt interrupted before a result remains `interrupted`, even if cleanup succeeds. A valid outcome published late by an old process can be reconciled in a later pass; invalid artifacts do not become success. Unconfirmed Docker creation remains `cleanup-unresolved`, including when no container is currently visible, because a daemon request could finish later. Recovery requires the same local Docker host for container inspection; absent attempts or valid markers with no container journal can be reconciled without Docker.

SQLite, filesystem writes and the Docker daemon are not one atomic transaction. Guards and retained evidence fence stale commits and prevent approval reuse, but do not establish exactly-once external effects or guarantee zero orphaned containers after every host failure. Do not move/import a state directory between hosts as a recovery mechanism. A compromised process under the same OS account remains outside the trust boundary. Retain uncertain attempts for operator inspection rather than deleting evidence.

Execution passes exit 0 for no work or all outcomes `passed`, 1 for completed failures/improvement, and 2 for blocked/interrupted/lost-ownership cases. A completed queue entry means its validation outcome was recorded; that outcome can be `blocked`. It does not mean compatibility, adoption, merge or deployment. Text listings omit recipes; `--json` includes private local records and must remain in the customer's environment.

## Prepare a local publication candidate

After an execution intent completes with a passing candidate, prepare a private proposal against a committed consumer repository:

```sh
node dist/cli.js publication-plan INTENT_ID --state /private/plumber-state --git /usr/bin/git --engine work/tools/oasdiff/oasdiff --repository OWNER/REPO --base main --json
```

Replace the identifiers and paths with the reviewed destination and trusted local executables. On Windows, supply the absolute path to `git.exe`. The SDK equivalent is `prepareJobPublicationCandidate({ statePath, intentId, gitPath, enginePath, repository, baseBranch })`. Git must support `--no-lazy-fetch`; an unsupported executable fails explicitly. Neither Git nor oasdiff is installed automatically.

The preflight reconstructs the validated request from the worker's immutable evidence, checks current provider and consumer evidence, and compares the durable result with the completed intent. Only `passed` or `improved` outcomes with a passing candidate and confirmed cleanup qualify. `improved` preserves the failing baseline in the proposed PR. Selected test success does not establish compatibility beyond those tests.

The first Git profile requires the exact root of a non-bare SHA-1 repository with a local `.git` directory. Every captured source and manifest must match the index and raw HEAD blobs in both directions; uncommitted additions, changes and deletions in that profile are rejected. Git filters and line-ending normalization are not applied. Other omitted files are not validated by this comparison. Linked worktrees, configuration includes, external object stores, Git symlinks, submodules, unsupported repository extensions, missing local objects, ambiguous paths and changing evidence are rejected. Git reads have bounded output and runtime and use a filtered environment with hooks, fsmonitor, lazy fetching and network protocols disabled. No staging, checkout, commit, branch creation or index refresh is performed.

The trusted executable and repository metadata are controlled by the local user. These checks do not isolate against a malicious process with the same OS account or provide an atomic filesystem snapshot. Consumer execution remains a separate, containerized action.

The deterministic candidate binds exact before/after content, Git blob identities/modes, the local HEAD/tree, validation/request/policy digests and an **unverified** `github.com` destination. It proposes a `feat/api-…` branch and draft PR, with `authorization: not-granted` and `publication: not-started`. Text output omits code and the PR body; JSON contains private source previews and must remain in the customer's environment. This command has no GitHub credentials, network client or publication permission. Remote repository identity/base verification, a distinct publication approval and durable write reconciliation are subsequent gates.

## Development and dependencies

`pnpm check` type-checks, builds, and runs Node's test runner, including comparisons against the real pinned engine. Install the engine first; engine absence fails tests rather than skipping integration coverage. CI defines the same checks on Windows, Linux, and macOS. No checks can demonstrate behavior for source types or product phases not implemented here.

`pnpm test:isolated` runs the real Docker integration suite on a prepared Linux x64 host. It is a separate CI job with explicit image provisioning; an absent daemon/image fails that suite instead of skipping it. The ordinary cross-platform suite tests authorization and the Docker process boundary without needing a daemon.

`pnpm dev` shows the delivery queue, pending reviews, and the next implementation milestone with its acceptance criteria. `pnpm dev:check` runs the existing project checks and propagates failures; it never changes delivery status, merges a PR, or starts background work. Resume instructions are in section 12 of the implementation plan.

Runtime dependencies are Node built-ins and `@babel/parser` 8.0.6 (MIT), with its resolved Babel dependencies. Development dependencies are pinned in `pnpm-lock.yaml`: TypeScript (Apache-2.0), Node type definitions (MIT), and their resolved dependencies. pnpm is MIT; [oasdiff](https://github.com/oasdiff/oasdiff/tree/v1.33.0) is Apache-2.0 and its LICENSE is preserved alongside the installed binary. Dependency lifecycle scripts are not authorized by the checked-in pnpm configuration.

Read the [implementation plan](docs/implementation-plan.md) for the remaining architecture and acceptance criteria. Direct, separately authorized Git publication and the versioned Cloud protocol are the next boundaries. The Cloud product follows the local workflow.

The package is private and unpublished. Do not install an unrelated package from npm using this development name. Package scope and distribution require availability checks. Public distribution under Apache-2.0 remains a proposal, not a license grant for this private repository.
