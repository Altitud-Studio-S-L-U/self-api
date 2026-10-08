# Local workflow reference

Start with the [README](../README.md) for prerequisites, public SDK imports and local installation. Run these examples from the repository root after building. They use fictional provider contracts and do not contact that provider. Checkout examples use `pnpm keepseam`, with `--silent` when emitting JSON to suppress the package-manager banner. Installed consumers use `pnpm exec keepseam` and supply their own paths.

Set the engine and private state paths once. The state directory must be outside the consumer directory and must not contain it.

PowerShell (inspection and planning on Windows):

```powershell
$KEEPSEAM_ENGINE = './work/tools/oasdiff/oasdiff.exe'
$KEEPSEAM_STATE = Join-Path $HOME '.keepseam-local-state'
```

Bash (Linux/macOS):

```bash
KEEPSEAM_ENGINE='./work/tools/oasdiff/oasdiff'
KEEPSEAM_STATE="$HOME/.keepseam-local-state"
```

Only the prepared Linux x64 Docker profile can execute consumer tests. Windows and macOS can inspect, plan and manage local evidence; unavailable execution produces a blocked result.

- [Inspect consumer usage](#inspect-consumer-usage) and [preview a migration](#preview-an-explicit-migration).
- [Approve and validate an isolated copy](#approve-and-validate-captured-copies).
- [Subscribe to changes](#persist-local-subscriptions-and-observe-once), then [queue and recover approved jobs](#queue-approved-jobs-and-recover-interrupted-validation).
- [Prepare publication evidence](#prepare-a-local-publication-candidate) for a separately committed consumer repository.
- [Connect an approved worker to Cloud](#connect-an-approved-worker-to-cloud) to share only selected status summaries.

## Current boundary

For ten real vendor documentation sources and a reproducible native/SDK Notion migration, see the [real API laboratory](../dev/real-apis/README.md). Its consumer operations are explicitly simulated; the SDK, scanner, observer and validation worker are real.

- The OpenAPI comparator accepts local OpenAPI 3.0.x/3.1.x JSON, at most 4 MiB and 128 nesting levels. External references, custom dialects, `$id`, dynamic references/anchors, reusable `components.pathItems`, and root webhooks are rejected. Direct comparator inputs must be regular files without symlinked ancestors; URLs, UNC/device paths, stdin, Git refs, and alternate data streams are not supported. The observer can separately capture remote sources using explicit HTTPS policies, as described below. YAML and general SDK call mapping remain unsupported. Authorized validation changes only an isolated captured copy.
- Captured input digests and API/specification versions identify the compared evidence. The local engine validates both contracts before comparing immutable temporary copies.
- Structural breaking-change findings only. `no-breaking-changes` does not prove consumer compatibility or unchanged business semantics; every report says `consumerImpact: not-analyzed`. Additive and prose-only changes can set `contentChanged` without producing breaking findings.
- The comparison engine disables external references, uses its own empty configuration, and receives a filtered environment. Comparison does not run consumer scripts. Engine process timeout and output limits are applied; this engine process is not a container sandbox or a hard memory limit. Consumer execution uses the separate Docker profile described below.
- The executable path is explicitly authorized by the caller. Runtime version checking is not proof of binary authenticity: protect the installed binary and use the checksum-verifying setup command or your own trusted distribution process.
- Reports remain local and may contain private operation names or schema descriptions. They are not Cloud messages. `keepseam-client/protocol` exports a separate status allowlist; the optional enrolled transport below sends only that projection. Model adapters and GitHub publication require their own explicit authorization. No telemetry or runtime API proxy is included.

## Inspect consumer usage

```sh
pnpm --silent keepseam scan fixtures/consumer --json
pnpm --silent keepseam impact fixtures/orders-v1.json fixtures/orders-v2.json --consumer fixtures/consumer --provider-base-url https://orders.example.invalid --engine "$KEEPSEAM_ENGINE" --json
```

The SDK equivalents are `scanConsumer(directory)` and `analyzeImpact({ basePath, revisionPath, enginePath, consumerRoot, providerBaseUrl })`. `scan` captures TS/JS syntax and package manifests without loading application modules, resolving imports, reading Babel/project configuration, installing consumer dependencies, or running scripts. The AST parser is an explicitly pinned dependency of Keepseam.

Supported native `fetch` calls expose file/line evidence, a known method and origin, and a path pattern where possible. A static absolute URL or an encoded template path segment can be associated with a changed operation under the explicitly supplied provider base URL. Matching supports whole parameter segments such as `/orders/{id}`; partial segments such as `/files/{id}.json` remain unmapped. Query values and URL credentials are not included in call evidence. Direct JSON response property reads are limited evidence, not complete parser or data-flow analysis. Aliases, dynamic URLs, wrappers, SDK calls, and indirect parsing require further analysis; an empty result never proves absence of integrations or impact.

Dependency inventory contains **declared ranges**, not verified installed versions or vulnerability findings. URL, Git, file, and other unrecognized specifiers use a null range rather than exposing possible credentials or private paths. Candidate validation scripts contain their names and command hashes, not raw commands, with execution marked `not-authorized`. No scan command authorizes their execution. These local reports still contain private metadata and are not a Cloud transmission contract.

Capture is limited to 500 source/manifest files, 2,000 directory entries, 1 MiB per file, 16 MiB total, and 20 directory levels. Hidden entries, declarations, dependencies, build output, and symlinks are omitted with reasons; symlinked roots are rejected. Limits and unreadable inputs fail explicitly. Content digests describe captured evidence, not an atomic Git checkout or an exhaustive repository analysis.

`scan` exits 1 when calls are unresolved or inspection issues exist. `impact` exits 1 whenever the contract has breaking findings, including findings with no observed consumer match. Every impact report requires review and distinguishes potentially matched operations, unmapped changes, and unresolved calls. It does not claim a migration is necessary, sufficient, or validated.

## Preview an explicit migration

```sh
pnpm --silent keepseam plan fixtures/orders-v1.json fixtures/orders-v2.json --consumer fixtures/migration-consumer --provider-base-url https://orders.example.invalid --engine "$KEEPSEAM_ENGINE" --recipe fixtures/orders-migration.json --json
```

The SDK exposes `createMigrationPlan({ ...impactOptions, recipe })`. A recipe supplies its summary, explicit business decisions, source paths and expected hashes, and exact unique replacements. Recipes are supplied by the caller at this stage; they are not inferred automatically from a schema diff. The fictional guide in `fixtures/migration-guide.md` explains both the `total`/`amount` equivalence and the existing source of `region`.

Planning captures current evidence, rejects stale or ambiguous edits, builds before/after previews in memory, and checks their syntax. The plan includes the decisions, contract/consumer/recipe hashes, target-directory identity, and a content digest. A digest identifies the proposed content; it does not authenticate an approver. Edits are matched against original positions, cannot overlap, and cannot cascade through earlier replacements. Unknown fields, traversal, edits to package manifests, and unsupported source syntax are rejected.

Recipes are bounded to 1 MiB, 50 source files, 100 edits, and 100 decisions. A missing decision produces `requires-decision` with no proposed files. A `ready-for-review` plan still has `authorization: not-granted`: syntax parsing does not establish type correctness, business equivalence, test success, or permission to execute. Approval, isolated validation and publication are separate explicit actions below. Consumer dependency installation and live adoption are not performed by this profile.

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
pnpm --silent keepseam validation-plan fixtures/orders-v1.json fixtures/orders-v2.json --consumer fixtures/validation-consumer --provider-base-url https://orders.example.invalid --engine "$KEEPSEAM_ENGINE" --recipe fixtures/validation-recipe.json --test orders.test.mjs --json
pnpm keepseam approve fixtures/orders-v1.json fixtures/orders-v2.json --consumer fixtures/validation-consumer --provider-base-url https://orders.example.invalid --engine "$KEEPSEAM_ENGINE" --recipe fixtures/validation-recipe.json --test orders.test.mjs --state "$KEEPSEAM_STATE"
pnpm keepseam validate fixtures/orders-v1.json fixtures/orders-v2.json --consumer fixtures/validation-consumer --provider-base-url https://orders.example.invalid --engine "$KEEPSEAM_ENGINE" --recipe fixtures/validation-recipe.json --test orders.test.mjs --state "$KEEPSEAM_STATE" --approval RECEIPT_ID
```

Replace `RECEIPT_ID` with the returned local approval ID. `approve` shows the before/after content, selected commands, profile and limits, then requires typing the exact request ID in an interactive terminal. There is no `--yes`, piped approval, implicit authorization, or execution during approval. A changed request must be reviewed again. The SDK exposes `prepareMigrationValidation(options)`, `approveMigrationValidation({ options, expectedRequestId, statePath, origin: 'explicit-sdk-caller' })`, and `executeMigrationValidation({ options, statePath, receiptId })`. An SDK approval represents the trusted caller's explicit intent; it does not prove a human reviewed the change.

Approvals expire after 15 minutes and bind the plan, consumer, contracts, recipe, selected tests, exact profile, and local state directory. Execution re-creates the request from current inputs and verifies those bindings. It claims the attempt exclusively before staging or execution, so parallel requests, failure, or a process crash cannot reuse the receipt. A failed attempt needs a new explicit approval. Changing the local clock or tampering with state under the same OS account is outside this trust boundary; no cryptographic identity claim is made.

Only captured source and package manifests are staged, from captured bytes. Dependencies, JSON test data, environment files, generated outputs, and omitted entries are unavailable. Select 1–20 Node test files explicitly; recipes cannot edit those selected tests. The same tests run on an original snapshot and a separate proposed snapshot. A missing import, service, or fixture is a real validation failure, never a fabricated successful result. This profile is currently useful for dependency-free contract tests; it does not replace a project's full CI. Tests that require transpilers, credentials, dependencies or network need a future separately approved execution profile.

The fixed container uses the image digest above, `--pull=never`, no network, a read-only root and snapshot, a numeric non-root user, no Linux capabilities, no-new-privileges, Docker's built-in seccomp profile, a 1 CPU / 512 MiB / 128 PID limit, and bounded temporary storage. No home directory, host environment, source checkout, credentials or Docker socket is mounted. Each baseline/candidate run has a 30-second total deadline, 1 MiB output budget and an additional bounded cleanup window. Daemon prerequisites and container removal are checked; failed cleanup prevents a successful result. See Docker's [run options](https://docs.docker.com/reference/cli/docker/container/run/), [bind-mount behavior](https://docs.docker.com/engine/storage/bind-mounts/) and [security model](https://docs.docker.com/engine/security/). A privileged local daemon and shared kernel remain part of the trust boundary; this is not a hostile multitenant execution service.

Results preserve both test outcomes: `passed` means both passed, `improved` means the baseline failed and the candidate passed, `regression` means only the candidate failed, and `failed` means both failed. Incomplete execution, unavailable infrastructure, exhausted budgets or unverified cleanup produce `blocked`. Passing selected tests does not establish provider compatibility beyond those assertions. The fictional B fixture is expected to return `improved` after fixing both call and parser. CLI exit 0 requires both passing, exit 1 preserves completed failures/improvement for review, and exit 2 indicates invalid input/authorization or blocked execution.

Use a private state directory outside the consumer; neither directory may contain the other. New state directories/files use restrictive POSIX modes; Windows relies on inherited account ACLs. `receipts/` holds approvals; `attempts/<id>/` holds the consumed marker, exact request, snapshots and result including bounded raw output. These contain private source and must remain local. Artifacts are retained for inspection; deleting a consumed marker could permit replay while a receipt remains valid, so do not remove attempt markers to retry. The durable job flow below adds explicit recovery. Validation does not clean state, publish to Git, upload source or mutate the live checkout. Publication and optional status sync are separately configured actions.

## Persist local subscriptions and observe once

```sh
pnpm keepseam subscribe fixtures/orders-v2.json --baseline fixtures/orders-v1.json --consumer fixtures/validation-consumer --provider-base-url https://orders.example.invalid --engine "$KEEPSEAM_ENGINE" --state "$KEEPSEAM_STATE" --label "Fictional orders API"
pnpm --silent keepseam worker --once --state "$KEEPSEAM_STATE" --engine "$KEEPSEAM_ENGINE" --json
pnpm --silent keepseam subscriptions --state "$KEEPSEAM_STATE" --json
pnpm --silent keepseam jobs --state "$KEEPSEAM_STATE" --json
```

Use `.exe` for the engine on Windows. `registerLocalSubscription(options)`, `observeOnce({ statePath, enginePath, subscriptionId? })`, `listLocalSubscriptions({ statePath })`, and `listMaintenanceJobs({ statePath })` provide the SDK equivalents. Importing the SDK does not load SQLite, open a database, create state, start polling, or execute a consumer. The engine executable remains an explicit argument each cycle rather than a command loaded from the database.

A subscription fixes a local JSON source, consumer directory, provider binding and **configured baseline**. That baseline is captured once; later edits or deletion of its original file do not change it. It is not proof of an adopted or deployed API version. Configuration is immutable in this slice; repeating the same registration is idempotent, while changing the binding/baseline of an existing subscription requires a future explicit reconfiguration flow. Labels are limited to 200 UTF-8 bytes. `http-subscribe` adds an explicitly configured HTTPS source as described below. Registration starts no crawler, webhook, MCP connection, resident daemon or scheduler.

Each explicit `--once` cycle captures the source bytes, including any UTF-8 BOM, writes owned private comparison copies, and inspects one consumer capture without executing it. Structurally invalid or incomplete inputs are failures; absence of findings does not prove compatibility. Changed bytes produce a review job even when the engine finds no structural breaking change. Jobs are keyed by subscription, baseline/revision digests, consumer digest and engine version: repeated evidence is deduplicated, a changed consumer gets new review evidence, and provider rollback preserves earlier jobs and transition history. Observing B never silently makes B the configured baseline. Adoption and deployment remain `unknown`.

State lives in `worker.sqlite3` beside the separate approval state. SQLite transactions atomically persist immutable snapshot BLOBs, subscriptions, observation transitions, review jobs and expiring ownership claims. A five-minute claim coordinates concurrent observers; its owner and generation must still match and remain unexpired at commit. An interrupted observer may be replaced after expiry, but the old observer cannot commit over its successor. Source/consumer/engine failures preserve the last successful observation and pending jobs, record a fixed reason, and release ownership for a later explicit retry. Repeating the same source after a failed analysis is allowed. Read-only observation retries are separate from execution recovery; consumed approvals are never replayed.

The store uses Node's built-in `node:sqlite`, avoiding an additional native installation step. At the minimum Node 24.11.1 runtime this API is experimental and emits its standard warning when first opened; Node documents it as a release candidate from 24.15.0. Use a current Node 24 LTS patch and retain backups of customer-owned state. See the [Node 24 SQLite API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html). The implementation uses transactions with full synchronization and the rollback journal on a regular local filesystem; network/shared filesystem coordination and remote database import are unsupported. Unknown database identities or future schema versions are rejected.

Limits are 100 subscriptions, 1,000 jobs and 1,000 observed transitions; individual contracts/reports are at most 4 MiB, with separate 64 MiB totals for snapshot bytes and report JSON. These bound stored payloads, not exact database disk usage. Exceeding a limit returns an explicit failure without pruning pending evidence or advancing freshness. No automatic retention/deletion policy is implemented. New directories/files use private modes; existing POSIX state/database paths with group/other access are rejected without changing their permissions. Windows uses inherited account ACLs. Keep the state directory private, outside the consumer, on customer-controlled storage; reports and snapshots are not Cloud messages.

`worker --once` exits 0 when the cycle completes without a current review job, 1 when a current job needs review, and 2 if any subscription is busy or fails. An unchanged current source does not close historical jobs. Use `jobs` to inspect retained evidence. Observation does not create a recipe, grant approval, execute tests, mutate source, publish to GitHub or contact Cloud.

## Queue approved jobs and recover interrupted validation

For a subscription using `fixtures/validation-consumer`, select its current job from `jobs`, then review and authorize a specific recipe and test set:

```sh
pnpm --silent keepseam job-plan JOB_ID --state "$KEEPSEAM_STATE" --engine "$KEEPSEAM_ENGINE" --recipe fixtures/validation-recipe.json --test orders.test.mjs --json
pnpm keepseam job-approve JOB_ID --state "$KEEPSEAM_STATE" --engine "$KEEPSEAM_ENGINE" --recipe fixtures/validation-recipe.json --test orders.test.mjs
pnpm keepseam job-queue JOB_ID --state "$KEEPSEAM_STATE" --engine "$KEEPSEAM_ENGINE" --recipe fixtures/validation-recipe.json --test orders.test.mjs --approval RECEIPT_ID
pnpm --silent keepseam run-approved --once --state "$KEEPSEAM_STATE" --engine "$KEEPSEAM_ENGINE" --json
pnpm --silent keepseam recover-approved --state "$KEEPSEAM_STATE" --json
pnpm keepseam executions --state "$KEEPSEAM_STATE"
```

Replace `JOB_ID` and `RECEIPT_ID` with the returned identifiers. The SDK equivalents are `prepareJobValidation`, `approveJobValidation`, `queueJobValidation`, `runApprovedJobsOnce`, `recoverApprovedJobs`, and `listJobExecutions`. A job fixes the observed contract bytes, configured baseline, consumer digest and engine version. Planning, approval, queue admission and execution compare those against current evidence; changed source or consumer requires a fresh observation/review. Queue admission inspects an unexpired, unconsumed approval but does not consume it. The 15-minute approval deadline continues while queued; it is not renewed automatically.

Each receipt identifies at most one immutable execution intent. Its recipe and selected tests remain local in SQLite. Repeating queue admission with the same still-valid inputs is idempotent. The database migrates its owned v1 schema to v2 transactionally, preserving existing subscriptions and jobs; future versions and unrelated databases are rejected. Execution storage is bounded to 1,000 intents, 1 MiB per recipe, 20 selected tests and 64 MiB total recipe JSON.

`run-approved --once` takes at most one queued intent by default (`--limit 1` through `10`), optionally selected by `--intent`. A ten-minute owner/generation claim protects execution; it is checked again before consuming approval, creating/starting containers and committing results. Only queued intents are eligible to execute. A stale request blocks before execution; a consumed or uncertain attempt stays available for recovery. An interrupted intent never returns to the execution queue. A failed or expired approval requires a new explicit approval, not removal of its existing receipt or marker.

The v2 Docker profile persists an exclusive, synchronized intent before container creation and its confirmed ID before start. Labels bind the container to the local receipt, request, intent, phase and profile. Cleanup verifies these labels, image, command and mounts, removes only the verified container ID, and checks absence. A private `containers/` journal remains inside the attempt. `result.json` holds the full result; `outcome.json` is published afterwards and contains a strict summary without logs or source. Recovery validates both artifacts and their bindings before recording completion in SQLite. These summaries still belong to local state; they are not the future Cloud protocol.

`recover-approved` only reconciles expired execution claims and unresolved cleanup. It obtains a new five-minute recovery claim, then either records a durable outcome or checks/removes owned containers. It cannot start tests, grant approval or retry a consumed receipt. An attempt interrupted before a result remains `interrupted`, even if cleanup succeeds. A valid outcome published late by an old process can be reconciled in a later pass; invalid artifacts do not become success. Unconfirmed Docker creation remains `cleanup-unresolved`, including when no container is currently visible, because a daemon request could finish later. Recovery requires the same local Docker host for container inspection; absent attempts or valid markers with no container journal can be reconciled without Docker.

SQLite, filesystem writes and the Docker daemon are not one atomic transaction. Guards and retained evidence fence stale commits and prevent approval reuse, but do not establish exactly-once external effects or guarantee zero orphaned containers after every host failure. Do not move/import a state directory between hosts as a recovery mechanism. A compromised process under the same OS account remains outside the trust boundary. Retain uncertain attempts for operator inspection rather than deleting evidence.

Execution passes exit 0 for no work or all outcomes `passed`, 1 for completed failures/improvement, and 2 for blocked/interrupted/lost-ownership cases. A completed queue entry means its validation outcome was recorded; that outcome can be `blocked`. It does not mean compatibility, adoption, merge or deployment. Text listings omit recipes; `--json` includes private local records and must remain in the customer's environment.

## Prepare a local publication candidate

This step requires a separate consumer repository committed **before** observation and validation. The checked-in fixture directories are subdirectories of Keepseam, not standalone Git roots; they cannot satisfy this publication profile. Select your actual consumer repository root and repeat its subscription, review and validation with that committed evidence. The earlier fixture demonstration ends at isolated validation.

After an execution intent completes with a passing candidate, prepare a private proposal against a committed consumer repository:

```sh
pnpm --silent keepseam publication-plan INTENT_ID --state "$KEEPSEAM_STATE" --git /usr/bin/git --engine "$KEEPSEAM_ENGINE" --repository OWNER/REPO --base main --json
```

Replace the identifiers and paths with the reviewed destination and trusted local executables. On Windows, supply the absolute path to `git.exe`. The SDK equivalent is `prepareJobPublicationCandidate({ statePath, intentId, gitPath, enginePath, repository, baseBranch })`. Git must support `--no-lazy-fetch`; an unsupported executable fails explicitly. Neither Git nor oasdiff is installed automatically.

The preflight reconstructs the validated request from the worker's immutable evidence, checks current provider and consumer evidence, and compares the durable result with the completed intent. Only `passed` or `improved` outcomes with a passing candidate and confirmed cleanup qualify. `improved` preserves the failing baseline in the proposed PR. Selected test success does not establish compatibility beyond those tests.

The first Git profile requires the exact root of a non-bare SHA-1 repository with a local `.git` directory. Every captured source and manifest must match the index and raw HEAD blobs in both directions; uncommitted additions, changes and deletions in that profile are rejected. Git filters and line-ending normalization are not applied. Other omitted files are not validated by this comparison. Linked worktrees, configuration includes, external object stores, Git symlinks, submodules, unsupported repository extensions, missing local objects, ambiguous paths and changing evidence are rejected. Git reads have bounded output and runtime and use a filtered environment with hooks, fsmonitor, lazy fetching and network protocols disabled. No staging, checkout, commit, branch creation or index refresh is performed.

The trusted executable and repository metadata are controlled by the local user. These checks do not isolate against a malicious process with the same OS account or provide an atomic filesystem snapshot. Consumer execution remains a separate, containerized action.

The deterministic candidate binds exact before/after content, Git blob identities/modes, the local HEAD/tree, validation/request/policy digests and an **unverified** `github.com` destination. It proposes a `feat/api-…` branch and draft PR, with `authorization: not-granted` and `publication: not-started`. Text output omits code and the PR body; JSON contains private source previews and must remain in the customer's environment. This command has no GitHub credentials, network client or publication permission. The separate steps below verify and publish that candidate.

## Review, authorize and publish to GitHub

These commands contact GitHub only with an explicit `--github` flag. They are optional; the preceding local workflow does not need credentials. Use a customer credential with repository read access for review and the required contents/PR write access for publication. Prefer a short-lived, repository-scoped credential. The CLI resolves `GH_TOKEN` at request time; do not put tokens in arguments or checked-in files. The SDK accepts a `getToken` callback for the customer's credential store or GitHub App installation token provider. Keepseam does not enroll an App or refresh tokens for you.

Save the `publication-plan --json` output as `candidate.json` in a private directory outside the consumer. Replace all placeholders and review the destination. The following examples assume that directory is the current working directory and the package is installed there:

```sh
pnpm exec keepseam publication-review --candidate candidate.json --author-name "YOUR COMMIT NAME" --author-email "YOUR COMMIT EMAIL" --github --json > publication-request.json
pnpm exec keepseam publication-approve --request publication-request.json --state /private/keepseam-state --consumer /projects/consumer
pnpm exec keepseam publication-publish --request publication-request.json --state /private/keepseam-state --consumer /projects/consumer --approval RECEIPT_ID --github --json
```

`publication-review` performs reads to verify the private repository's immutable ID, permissions, branch, commit and tree. It grants no permission and sends no candidate source in those read requests. `publication-approve` is entirely local: it shows before/after source, PR content, author and destination, then requires the exact request ID in a terminal. The resulting permission is single-use, expires after 15 minutes and cannot be replaced by a validation receipt. JSON request files are private local artifacts; the CLI accepts at most 4 MiB per file, while the SDK's publication evidence budget is 16 MiB.

Publication rechecks captured source and the remote base before proceeding. The GitHub adapter verifies parent blobs, uploads immutable blobs/tree/commit, creates a new `feat/api-…` branch and opens a draft PR. It never updates an existing branch, deletes branches, merges or deploys. An identity, source, base or permission change stops further writes. Credentials stay outside consumer validation containers. GitHub receives the explicitly approved source changes directly; Keepseam Cloud receives none of them.

The SDK equivalents are:

```ts
import {
  createGitHubPublicationAdapter, preparePublicationRequest,
  approvePublicationRequest, publishPublication, reconcilePublication,
} from 'keepseam-client';
```

Use `preparePublicationRequest({ candidate, adapter, author })`, review the complete returned request, then `approvePublicationRequest({ request, expectedRequestId: request.id, statePath, consumerRoot, origin: 'explicit-sdk-caller' })`. Calling that approval method is an explicit customer policy decision; do not call it automatically on untrusted Cloud or model input. `publishPublication({ request, receiptId: approval.id, statePath, consumerRoot, adapter })` requires the same request and adapter identity. `validatePublicationRequest(unknown)` validates a serialized request without authorizing it or contacting GitHub.

Every external write phase has a durable local intent recorded first. A timeout, lost response or mismatched result produces `uncertain`, never an automatic retry. Reconcile the original request and receipt:

```sh
pnpm exec keepseam publication-reconcile --request publication-request.json --state /private/keepseam-state --consumer /projects/consumer --approval RECEIPT_ID --github --json
```

Reconciliation reads GitHub and the journal. It recognizes an existing matching open, closed or merged PR without recreating it, and preserves human commits. A missing PR after an uncertain write does not prove that the write will never complete. Missing durable commit identity also remains uncertain. Reconciliation does not resume remote writes; retain the evidence for operator review. Publication exits `0` for confirmed publication, `1` for a conflict and `2` for uncertainty or an error. A simulated adapter labels its results `mode: simulation`; this is not evidence of a live PR.

The first transport profile supports private, active, writable, non-fork GitHub.com repositories with SHA-1 objects and a same-repository PR. It rejects redirects, bounds request/response sizes and deadlines, reads short-lived credentials on demand and never retries a write. GitHub's PR creation is not an atomic compare-and-swap on the head ref: a concurrent human update can still race creation. Before/after checks report the conflict without overwriting that branch. Local journals, source digests and callbacks do not isolate a malicious process running under the same OS identity.

## MCP, schemas, examples and documentation

MCP input is an explicit normalized capture, not a URL or a request to invoke tools. Use the complete examples under `fixtures/mcp/` for the file shape: `schemaVersion`, server/protocol/auth-context identity, capabilities, capture time, completeness, pagination and tools. Keep auth-context IDs opaque; never include access tokens. Partial/failed captures or changed server, authorization, protocol or capabilities produce `inconclusive`, without interpreting absent tools as removals.

```sh
pnpm --silent keepseam mcp-snapshot fixtures/mcp/catalog-before.json --json
pnpm --silent keepseam mcp-compare fixtures/mcp/catalog-before.json fixtures/mcp/catalog-after.json --json
pnpm --silent keepseam schema-compare /contracts/before.json /contracts/after.json --direction output --json
pnpm --silent keepseam example-compare /samples/before.json /samples/after.json --json
```

The shared JSON Schema profile supports a single type, object properties/required/boolean `additionalProperties`, arrays/items and scalar enum/const values. References, combinators, type unions and additional constraints outside the profile are rejected. Input comparison preserves old accepted inputs; output comparison requires new outputs to satisfy the old contract. An annotation change requires review, even when the structural profile is compatible. Absent MCP output contracts remain a limitation. Limits are 4 MiB, depth 64 and 20,000 inspected schema nodes; MCP has at most 1,000 tools.

MCP/schema/example JSON readers reject numeric precision loss before parsing: numbers must be finite, integers must stay within ±9,007,199,254,740,991, and the decimal value must survive conversion to JavaScript Number and back to JSON. Numeric tokens are bounded to 256 characters. Unsafe integers, rounded decimals and underflow cannot silently become equal contracts; they produce an explicit unsupported-input result. Equivalent spellings such as `0.10` and `0.1` remain supported, and quoted numeric strings remain strings.

`loadJsonSchema`/`compareJsonSchemas` consume a declared schema. `loadJsonExample`/`compareJsonExamples` preserve the fact that input is only an observed value: required fields, variants and compatibility remain unknown, including for identical examples. No schema or migration is inferred from absent sample properties. Framework and DB-generated documents may be supplied as local exports; these functions do not import application modules, query a database or establish the API's authorization behavior.

Persist observations using a dedicated state directory:

```sh
pnpm keepseam source-subscribe fixtures/mcp/catalog-after.json --kind mcp --baseline fixtures/mcp/catalog-before.json --state "$KEEPSEAM_STATE"
pnpm --silent keepseam source-observe --once --state "$KEEPSEAM_STATE" --json
pnpm --silent keepseam source-subscriptions --state "$KEEPSEAM_STATE" --json
pnpm --silent keepseam source-history --state "$KEEPSEAM_STATE" --json
```

`source-subscribe` also supports `json-schema` with a required `--direction`, `json-example`, and `documentation` for `.md`/`.txt` files. Documentation can explicitly enable `--normalize-line-endings`; no other presentation filtering is implied. Text is never rendered, links are not fetched, and examples are never executed. Changed prose is review evidence, not proof of a deployed breaking change.

The SDK exposes `registerSourceSubscription`, `observeSourcesOnce`, `listSourceSubscriptions` and `listSourceObservations`. Pass `consumerRoot` when binding evidence to a checkout so state placement can be checked; state must remain outside and cannot contain that checkout. These observations preserve source evidence without queuing migrations. The OpenAPI worker has the separate impact and approved execution workflow described above; MCP consumer impact is an explicit analysis step below.

Local source state uses `source-observations.sqlite3` alongside the core worker database in the validated private state directory. Baselines remain immutable, snapshots retain exact bytes, and sequential transitions retain rollbacks such as A→B→A→B. Identical repeated evidence is deduplicated. Transactions and five-minute ownership claims prevent stale observations from committing. Failures preserve the last successful observation. Limits are 100 subscriptions, 1,000 transitions and 64 MiB of snapshots/reports. Adoption and deployment remain unknown. No automatic pruning removes pending evidence.

To inspect a consumer's MCP calls, supply a local JSON array of explicit bindings. For a checkout containing the fictional `consumer-before.mjs` example:

```json
[{"file":"consumer-before.mjs","receiver":"client","serverId":"fictional-commerce-tools","authContextId":"fixture-team-reader"}]
```

```sh
pnpm --silent keepseam mcp-impact fixtures/mcp/catalog-before.json fixtures/mcp/catalog-after.json --consumer /projects/mcp-consumer --bindings /private/mcp-bindings.json --json
```

`analyzeMcpImpact({basePath, revisionPath, consumerRoot, bindings})` returns captured file digests, calls, input field names, direct reads below `response.structuredContent`, and associations to changed tools. A binding is an operator declaration, not proof of a live connection. Each binding names one exact relative file and receiver. Unbound clients, shadowing, reassignment, dynamic tool names/arguments, aliases and indirect parser flows remain unresolved. Inconsistent server/protocol/authorization/capability context or incomplete catalogs prevent confident associations. No consumer imports or MCP tools execute, no recipe is generated, and the result always requires review. CLI exit `1` includes breaking/inconclusive contracts, unresolved calls, inspection issues and unmapped changes; `0` does not establish application compatibility.

## Observe an explicit HTTPS source

Create a private local policy file using the provider's actual URL and exact permitted origin. This **fictional** example is not a reachable provider:

```json
{"url":"https://provider.example.invalid/openapi.json","allowedOrigins":["https://provider.example.invalid"],"contentKind":"json"}
```

```sh
pnpm keepseam http-subscribe /private/source-policy.json --baseline /contracts/base.json --consumer /projects/consumer --provider-base-url https://provider.example.invalid --engine "$KEEPSEAM_ENGINE" --state "$KEEPSEAM_STATE"
pnpm keepseam worker --once --state "$KEEPSEAM_STATE" --engine "$KEEPSEAM_ENGINE" --http
```

For normalized MCP catalogs, JSON schemas/examples or raw documentation, use `source-http-subscribe /private/source-policy.json --kind KIND --baseline LOCAL_FILE --state "$KEEPSEAM_STATE"`, then `source-observe --once --state "$KEEPSEAM_STATE" --http`. JSON schemas also require `--direction input|output`; documentation requires `contentKind: "text"` and a local `.md`/`.txt` baseline. Text and HTML are retained as text without rendering, links or execution. Fetching a JSON catalog is not an MCP transport connection or automatic `tools/list` pagination.

The SDK equivalents are `prepareHttpSource`, `registerHttpSubscription` for OpenAPI, `registerHttpSourceSubscription` for the other profiles, and observation with `allowHttp: true`. Registration is offline. A registered remote source observed without explicit HTTP enablement fails with `http-not-enabled`; it cannot be mistaken for a fresh check. `captureHttpSource` is also available for a single bounded capture without persistence.

The built-in transport accepts HTTPS on port 443, credential/query/fragment-free URLs and explicit origin allowlists. It validates resolved addresses against its public-network profile and pins the chosen address for the TLS connection; private/reserved addresses, redirects and compression are rejected. TLS verification remains enabled. There is no proxy, cookie jar, automatic retry, crawl or environment-based credential discovery. Captures allow up to 4 MiB and 30 seconds, with smaller configurable limits. Trusted resolver/transport overrides are useful for customer integrations and tests, but are not networking sandboxes.

Private sources require a non-public opaque `authContextId` in the policy and an SDK `httpCredentials(source)` callback returning `{origin, authContextId, getAuthorization(context)}`. The callback obtains credentials from the customer's chosen store; Keepseam does not serialize the callback or token. Authorization is sent only to that configured origin. Change the context ID when permission scope changes; token rotation within the same scope need not invalidate the cache. The CLI currently observes public sources only and does not accept tokens in arguments or policy files.

Snapshots preserve exact bytes. ETag/Last-Modified and the authorization context are retained locally; a `304` reuses only a verified matching snapshot with a previously sent validator. Observers acquire ownership before capture and commit the bytes, conditional cache, history and any OpenAPI review job in the same SQLite transaction after successful comparison. Failed downloads, unsupported contracts, lost ownership and persistence errors preserve the last successful evidence. No shared filesystem mirror sits between download and comparison. Existing core state migrates from schema 1/2 to 3; source-observer state migrates from schema 1 to 2 without resetting history.

OpenAPI job planning/validation uses the last successfully observed HTTPS snapshot and rejects jobs superseded by newer successful captures. Those steps do not silently contact the provider. Cached evidence is not proof of present-time provider behavior: explicitly observe again before reviewing a migration, and inspect its observation timestamp. Provider capture, customer adoption and production deployment remain distinct states.

## Exercise a fictional payments provider

`fixtures/payments/` describes a made-up, read-only payment lookup API, not PayPal or another live provider. Version `2026-01` returns integer `totalCents`; `2026-02` retires the old header with HTTP 410, requires the caller's existing currency and returns a nested decimal amount. Both contracts explicitly define the relationship between major and minor units. The example migration uses integer arithmetic, rejects unsupported precision or unsafe values, and preserves `{reference, amountMinor, currency}`. The SDK does not infer this business decision from property names.

After `pnpm build`, run the portable scenario checks:

```sh
node --test test/payments-scenarios.test.mjs
```

The check starts an actual HTTP server on loopback in each selected fixture, without replacing `fetch`. It proves that the original client passes against version A, fails independently in request construction and parsing against version B, and that the reviewed recipe produces the expected passing candidate. It also verifies missing business decisions block validation and selected tests cannot be edited to manufacture success. The synthetic fixtures share port 43127 and are run sequentially; do not run both fixture files together on the same host.

On the prepared Linux x64 Docker host, run:

```sh
node --test --test-concurrency=1 integration/payments-validation.test.mjs integration/http-provider.test.mjs
```

The first integration creates a real worker subscription and review job, separately approves and queues the migration, and executes baseline/candidate tests with the fixed Docker profile. The provider and its assertions live in the selected test file, so the recipe cannot change either. The consumer checkout and test bytes remain unchanged, container cleanup is verified, and a consumed approval cannot be replayed. Cases include encoded IDs, explicit EUR/USD currency, exact cents including `0.29`, zero and safe-integer boundaries, additive fields, malformed JSON/money, currency mismatch and HTTP 401/410/429/503. Error responses deliberately resemble valid payments and must still fail; `Retry-After` never triggers an implicit retry.

The second integration exercises the actual Node HTTPS transport against a local TLS server, with an ephemeral one-day certificate generated by the host's OpenSSL. A trusted fixture adapter routes the socket to loopback while preserving TLS verification; production still rejects private addresses. It checks exact captures, conditional 304 responses, a changed contract, invalid CA/hostname, redirects, compression, size limits, timeouts and cancellation. This verifies transport behavior on a controlled route, not public DNS or a live provider. The host needs `/usr/bin/openssl`; missing prerequisites fail explicitly.

Both Docker tests use `--network=none`, a non-root user and a read-only snapshot. Loopback communication stays inside each container, without published ports, provider accounts or real credentials. The existing `pnpm test:isolated` CI job includes these tests automatically.

## Integration versions and function boundaries

Validate the fictional catalog with `integration-check fixtures/integration-manifest.json --json`, or use `normalizeIntegrationManifest(input)`. It separates source provenance, endpoint/environment, known versions and effective versions. API, SDK, webhook, MCP protocol and MCP server versions are different axes. Support and retirement dates reference evidence; unknown dates use `null` and an explanation. Coverage is always `listed-only`.

Optional boundary metadata annotates an existing function without introducing a proxy:

```js
import { readFile } from 'node:fs/promises';
import { defineIntegrationBoundary, getIntegrationBoundary } from 'keepseam-client';

const manifest = JSON.parse(await readFile('fixtures/integration-manifest.json', 'utf8'));
function parseOrder(response) {
  return { id: response.id, total: response.total };
}
const registered = defineIntegrationBoundary(manifest, parseOrder, 'read-order');
console.assert(registered === parseOrder);
console.log(getIntegrationBoundary(registered).boundaryId);
```

The function retains its identity, `this`, return values, promises and exceptions. Registration neither enforces the referenced schema nor repairs production traffic. JSON pointers are metadata references, not automatically resolved contracts. A manifest location never authorizes fetching it. Metadata is held in-process; importing a consumer to discover registrations would execute it, so static scanning does not do that. Business requirements and internal invariants still need review and tests.

## Optional model proposals

The harness accepts a customer-owned adapter through `prepareModelProposal`, `approveModelProposal` and `proposeMigrationWithModel`. Preparation binds the adapter's ID, local/remote declaration, destination and policy ID to selected source/test files, evidence and unresolved business decisions. Each selected file carries its SHA-256 and role. Tests are read-only context. No files, environment variables or credentials are discovered implicitly.

Review the full prepared request before calling `approveModelProposal({ request, expectedRequestId: request.id })`. For a remote adapter, authorization additionally requires `allowRemote: true`; there is no silent remote fallback. Call `proposeMigrationWithModel({ request, consent, adapter })`, where `adapter.propose(context, { signal, maximumOutputBytes })` returns a JSON recipe string using the customer's configured model client. Model credentials and transport belong to that adapter, not to Keepseam Cloud. No model weights or client packages are installed.

The consent is bound to the exact in-memory request, lasts at most 15 minutes and is consumed once. It deliberately cannot survive serialization or restart. Default context/output budgets are 256 KiB, capped at 1 MiB; default deadline is 30 seconds, capped at 120 seconds. There is one proposal attempt. Recognizable secret patterns and caller-provided `sensitiveValues` are rejected before disclosure and in output; this does not guarantee complete secret detection.

The output must pass the existing exact-edit recipe and syntax checks. It cannot select new files, edit selected tests, answer business decisions, execute commands or grant approval. The harness adds an unresolved `model-semantics` decision so the proposal requires human review before the separate validation flow. Validation remains `not-run`. The adapter is trusted customer code: its declared location does not prove its actual networking, and a timeout/AbortSignal cannot preempt CPU or stop a noncooperating callback. Run untrusted adapters in customer-controlled isolation.

## Persistent local development with Compose

This development environment runs a **fictional, read-only payments provider** and a separate consumer application. The SDK worker runs on the developer's host and persists subscriptions, review jobs, approvals and outcomes in SQLite. It uses the existing public SDK APIs; importing Keepseam does not launch these services. No real payment account, Cloud account, model or GitHub credential is required.

Use **one Linux x64 host** for the complete workflow, including the worker and its state. On Windows, run the commands inside a Docker-integrated WSL distribution, from a checkout in that distribution's Linux filesystem. Windows drive mounts without POSIX permission metadata cannot preserve the worker's required private state permissions. Keep Node, pnpm and `node_modules` for that operating system; do not share dependency installations or the generated state between Windows and Linux. Inspection-only development remains available on Windows, but approval/validation uses the supported Linux profile.

With Node 24, pnpm 11.19.0, Docker Engine and Compose available in that shell:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm engine:setup
pnpm dev:local seed
docker compose up -d --wait
```

The first Compose start downloads the pinned Node image if it is absent. Both services run as an unprivileged user with read-only mounts/filesystems, resource limits and health checks. Only loopback host ports are published. No Docker socket, host home directory or credentials enter the application containers. The consumer shares the provider's development network namespace so its unchanged fixture code can call `127.0.0.1:43127`. The host ports are deliberately different from test-suite ports:

| Endpoint | Purpose |
| --- | --- |
| `http://127.0.0.1:43227/health` | Provider health and active API version |
| `http://127.0.0.1:43227/openapi.json` | Current fictional provider contract |
| `http://127.0.0.1:43228/health` | Consumer process health |
| `http://127.0.0.1:43228/payments/demo-eur?currency=EUR` | Application result for the seeded EUR payment |
| `http://127.0.0.1:43228/payments/demo-usd?currency=USD` | Application result for the seeded USD payment |

`work/local-dev/provider/payments.json` contains editable fictional seed data. `work/local-dev/consumer` contains the editable consumer and its unchanged tests. `work/local-dev/state` contains private worker state outside that consumer. `seed` creates missing fixture files once and preserves current versions, data, source edits and existing state. A marker rejects accidental reuse from a different OS/path. Everything under `work/` stays out of Git. Restart the consumer after editing its source; development does not rewrite application files automatically.

Start observation explicitly in another terminal:

```sh
pnpm dev:local worker
```

This development supervisor uses finite SDK loops, checks every three seconds, prints each ten-cycle result and stops cleanly on Ctrl+C or an observation failure limit. It grants no approval and processes no execution queue. `pnpm dev:local observe` performs one cycle instead. The observer subscribes to the provider's exact local `current.json`; it does not weaken the production HTTPS observer's prohibition on private addresses to access Compose.

Try a provider retirement while the services remain running:

```sh
pnpm dev:local version v2
pnpm dev:local observe
pnpm dev:local jobs
```

The old consumer now returns HTTP **502**, with `upstreamStatus: 410`. The provider's contract and behavior switch together because both read the same atomically replaced contract. The worker retains the v1 configured baseline and creates a review job for the changed evidence; repeated observations deduplicate it. Use the job identifier for `version: "2026-02"`:

```sh
pnpm dev:local plan <job-id>
```

Inspect the source changes, currency/amount decisions, test selection, isolation profile and request `id`. Planning does not execute or approve anything. To authorize that exact fictional request and validate it:

```sh
pnpm dev:local validate <job-id> <reviewed-request-id>
pnpm dev:local executions
```

`validate` rejects stale request IDs, creates an explicit single-use SDK approval, queues that request and invokes the existing isolated Docker runner from Linux. Its child containers have no network, secrets or Docker socket. Their selected tests start their own real HTTP fixture internally. The separate long-running Compose provider remains available for manual development; successful isolated validation does not certify every behavior of that live process.

Expect the original v2 tests to fail, the candidate's **25 cases** to pass, and the outcome to be `improved`. The returned `attemptDirectory` holds separate baseline/candidate copies and private evidence. The running consumer remains broken until you deliberately adopt the reviewed edit. For this fictional development checkout only, review the candidate file, copy its `payments.mjs` over `work/local-dev/consumer/payments.mjs`, and run `docker compose restart consumer`. The same application endpoint should again return `{ "reference": "demo-eur", "amountMinor": 2599, "currency": "EUR" }`. This explicit manual adoption is not a general SDK apply or GitHub-publication feature.

`docker compose down` stops/removes the services while retaining the host seed and SQLite data. `docker compose up -d --wait` resumes them. Use `docker compose logs --tail 50` and `docker compose ps` for service diagnostics. There is no automatic reset/deletion command: use a separate clean checkout for a fresh scenario or restore only the fictional files you intentionally edited. Do not point this development setup at real customer data or deploy it as a production application.

## Run the worker explicitly

```sh
pnpm keepseam worker-loop --state "$KEEPSEAM_STATE" --engine "$KEEPSEAM_ENGINE" --cycles 10 --interval-ms 60000
```

The finite loop defaults to one cycle and a 60-second interval, allows 1–1,000 cycles and 1-second–1-hour delays, and never starts on import. It observes the OpenAPI job workflow. Add `--http` to enable registered public HTTPS sources, or pass explicit credentials through the SDK. Add `--run-approved` only to process already queued, authorized validation jobs; it grants no new approval. Non-OpenAPI source observations use their explicit `source-observe --once` command or SDK function. For persistent observation of both profiles under a native OS manager, use the [worker service operation guide](worker-service.md).

`runWorkerLoop(options)` accepts an AbortSignal. SIGINT/SIGTERM in the CLI prevents another phase/cycle and waits for the current operation to finish safely. It does not abandon a running validation container. Observations are sequential, with bounded backoff only for observation failures; execution failures/interruption stop the loop without replay. It does not install a service, resume uncertain publication or run recovery automatically. Cross-process ownership remains enforced by the existing database leases.

## Inspect dependency and advisory evidence

```sh
pnpm --silent keepseam deps-scan /projects/consumer/package-lock.json --json
pnpm --silent keepseam deps-audit /projects/consumer/package-lock.json --advisories /private/advisories.json --json
```

The initial dependency profile reads npm `package-lock` v2/v3, with direct, nested, scoped and transitive records. It separates declared selectors from recorded versions; the lockfile does not prove installed files or deployment. Unsupported links, aliases, sources and ambiguous versions remain unresolved. Registry URLs, credentials, integrity values and raw selectors are excluded from output. No package scripts, installations or registry requests run.

Supply an explicit advisory catalog, for example this **fictional** entry:

```json
{"schemaVersion":1,"advisories":[{"id":"EXAMPLE-1","ecosystem":"npm","package":"fictional-client","affectedVersions":["1.2.3"],"sourceURL":"https://example.invalid/advisories/EXAMPLE-1","withdrawn":false}]}
```

`analyzeNpmAdvisories({ lockfilePath, advisoryPath })` correlates only exact listed versions. It distinguishes affected, unlisted, unresolved and withdrawn entries. An unlisted version is not an assertion that no vulnerabilities exist, and an affected match does not establish exploitability. Limits are 4 MiB, depth 64, 5,000 dependency entries, 1,000 advisories and 20,000 correlations. pnpm/yarn lockfiles and online advisory/range resolution require another profile; do not rename those files to imply support.

## Share bounded status, not local artifacts

Import the separately versioned status contract from `keepseam-client/protocol`:

```ts
import { encodeCloudStatusEvent, decodeCloudStatusEvent, negotiateCloudProtocol } from 'keepseam-client/protocol';
```

Version 1 accepts exact runner/maintenance event shapes, opaque SHA-256-form identifiers, canonical timestamps, bounded counts, enumerated states and reasons. Unknown fields, source text, logs, schemas, URLs, commands, prompts and arbitrary labels are rejected. Messages are limited to 4 KiB. `deriveCloudIdentifier(localId, installationId)` scopes already opaque IDs to an installation; hashing a predictable path does not make it confidential.

The encoder is an allowlist, not a redactor or an authentication system. It neither opens a connection nor approves an action. The separate `generateCloudWorkerIdentity`, `createCloudTransport` and `syncWorkerToCloud` APIs implement identity generation, key-bound delivery and a durable local status outbox. Cloud independently validates the protocol, approval and current revocation. This authenticates the reporting installation, not the truth of every reported outcome. Do not send local comparison reports, proposals, recipes or journals as status messages.

## Connect an approved worker to Cloud

This is an optional SDK workflow. It requires a running Keepseam Cloud, a customer organization/project and a current owner/admin with a registered passkey. A platform employee grant alone cannot enroll a customer worker. The standalone local worker continues to operate without Cloud.

Use the built checkout or the private local archive described in the [README](../README.md#install-into-another-local-project). There is no public package release or generic `keepseam cloud-*` command. Save the following example scripts under this checkout's ignored `work/` directory, or in your own ESM application with the private package installed. They import the public `keepseam-client` entry points. Keep identity, credentials and both state directories on customer-controlled storage outside every consumer checkout. On POSIX, use owner-only directory/file permissions; on Windows, verify that the chosen directory's inherited ACL grants access only to the intended account. The example file modes do not change existing directory permissions or Windows ACLs.

### Generate the local identity

Set `KEEPSEAM_CONNECTION_DIR` to a dedicated private directory. For example:

```powershell
$env:KEEPSEAM_CONNECTION_DIR = Join-Path $HOME '.keepseam-connection'
```

```bash
export KEEPSEAM_CONNECTION_DIR="$HOME/.keepseam-connection"
```

Save as `work/generate-cloud-identity.mjs`, then run `node work/generate-cloud-identity.mjs`:

```js
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateCloudWorkerIdentity } from 'keepseam-client';

const directory = process.env.KEEPSEAM_CONNECTION_DIR;
if (!directory) throw new Error('Select a private connection directory.');
await mkdir(directory, { recursive: true, mode: 0o700 });
const identity = await generateCloudWorkerIdentity();
await writeFile(join(directory, 'identity.private.json'), JSON.stringify(identity),
  { flag: 'wx', mode: 0o600 });
const publicIdentity = {
  installationId: identity.installationId,
  publicJwk: identity.publicJwk,
  fingerprint: identity.fingerprint,
};
await writeFile(join(directory, 'identity.public.json'), JSON.stringify(publicIdentity, null, 2),
  { flag: 'wx', mode: 0o600 });
console.log('Public identity saved; compare its fingerprint during enrollment.');
```

`identity.private.json` contains the signing key and stays local. Only `identity.public.json` is suitable for the panel. Exclusive file creation prevents accidentally replacing an existing identity; retain its original key rather than generating another for the same connection. Importing/generating identity makes no Cloud request.

### Enroll, approve and assemble credentials

1. In the customer workspace, select the intended organization and project. Create a project first if necessary. Open Workers → **Connect worker / Conectar worker**, verify your passkey when requested and paste only `identity.public.json`. The form rejects a private JWK.
2. Save the displayed connection JSON as `enrollment.private.json` in the same private directory. It contains `baseUrl`, `installationId`, the opaque wire `projectId` and `clientSecret`. The secret is displayed once; losing it requires an explicitly enrolled replacement, not a request to reveal it again. The wire project ID differs from the project's database UUID.
3. Open the new worker's connection panel. Compare its fingerprint against `identity.public.json` on the worker machine, check the confirmation and activate it. A pending or mismatched key cannot obtain a token.
4. Combine the displayed connection fields with the original private JWK **locally**, using the script below. Never upload the combined file to the panel or paste its contents into a terminal command, issue or log.

Save as `work/assemble-cloud-credentials.mjs`, then run `node work/assemble-cloud-credentials.mjs`:

```js
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCloudTransport } from 'keepseam-client';

const directory = process.env.KEEPSEAM_CONNECTION_DIR;
if (!directory) throw new Error('Select the existing private connection directory.');
const identity = JSON.parse(await readFile(join(directory, 'identity.private.json'), 'utf8'));
const enrollment = JSON.parse(await readFile(join(directory, 'enrollment.private.json'), 'utf8'));
if (identity.installationId !== enrollment.installationId) throw new Error('Enrollment identity mismatch.');
const credentials = {
  baseUrl: enrollment.baseUrl,
  installationId: identity.installationId,
  projectId: enrollment.projectId,
  clientSecret: enrollment.clientSecret,
  privateJwk: identity.privateJwk,
  allowLocalHttp: enrollment.baseUrl === 'http://localhost:43300',
};
createCloudTransport(credentials);
await writeFile(join(directory, 'credentials.private.json'), JSON.stringify(credentials),
  { flag: 'wx', mode: 0o600 });
console.log('Connection configuration saved locally; no token requested.');
```

The example permits HTTP only for the explicit local development origin `http://localhost:43300`. Other origins require HTTPS unless you deliberately configure another supported loopback origin. `baseUrl` is an exact origin with no trailing slash/path/query. The transport refuses redirects. `createCloudTransport` validates configuration without connecting; token exchange happens on `send`.

### Bind only selected local integrations

Use `pnpm --silent keepseam subscriptions --state "$KEEPSEAM_STATE" --json` locally to select an existing subscription. Its 64-character local ID is distinct from the Cloud integration UUID. Derive the public binding ID with the approved installation:

```js
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deriveCloudIdentifier } from 'keepseam-client/protocol';

const directory = process.env.KEEPSEAM_CONNECTION_DIR;
const localSubscriptionId = process.env.KEEPSEAM_LOCAL_SUBSCRIPTION_ID;
if (!directory || !localSubscriptionId) throw new Error('Select the connection and local subscription.');
const identity = JSON.parse(await readFile(join(directory, 'identity.public.json'), 'utf8'));
console.log(deriveCloudIdentifier(localSubscriptionId, identity.installationId));
```

Set `KEEPSEAM_LOCAL_SUBSCRIPTION_ID` to the selected local ID and run this script from the checkout/application. Its output is an opaque public ID, not a path or credential. In Cloud, create/select an integration under the worker's project, enable it and explicitly allow metadata sharing. In the active worker's **Bind integration / Vincular integración** form, select that Cloud integration and paste the derived ID. Repeat only for subscriptions you intend to share. Binding is immutable; a disabled integration or withdrawn sharing permission rejects further projection.

### Synchronize status explicitly

Save the following as `work/sync-cloud.mjs`. Set `KEEPSEAM_LOCAL_STATE` to the existing local worker state directory and `KEEPSEAM_CLOUD_STATE` to a separate dedicated outbox directory, both outside the consumer. Use the same connection directory and selected subscription from the preceding steps:

```js
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { syncWorkerToCloud } from 'keepseam-client';

const directory = process.env.KEEPSEAM_CONNECTION_DIR;
const statePath = process.env.KEEPSEAM_LOCAL_STATE;
const cloudStatePath = process.env.KEEPSEAM_CLOUD_STATE;
const subscriptionId = process.env.KEEPSEAM_LOCAL_SUBSCRIPTION_ID;
if (!directory || !statePath || !cloudStatePath || !subscriptionId) {
  throw new Error('Select connection, worker state, Cloud state and an approved subscription.');
}
const credentials = JSON.parse(await readFile(join(directory, 'credentials.private.json'), 'utf8'));
const result = await syncWorkerToCloud({
  statePath,
  cloudStatePath,
  credentials,
  integrationIds: [subscriptionId],
});
console.log(result);
```

Run `node work/sync-cloud.mjs` after observing locally. `integrationIds` takes 1–100 unique **local** subscription IDs that already exist in `statePath`; do not pass derived IDs or Cloud UUIDs. For multiple subscriptions, supply an explicitly reviewed list and bind each one in Cloud first. Sync reads local jobs/execution outcomes, emits changed summaries plus a runner status, and returns counts/state. It does not observe providers, approve jobs, run tests, install a service or publish a PR.

The [real API laboratory](../dev/real-apis/README.md#connect-the-actual-worker) already wraps this SDK flow with `pnpm dev:apis cloud-sync <private-credentials-file>` and `pnpm dev:apis worker <private-credentials-file>`. Pass the path to the combined credentials file, never the secret itself. Those helpers intentionally select only the lab's Notion subscription; they do not discover and share every local integration.

### Sync results, retries and limits

| Result or limit | Meaning and operation |
| --- | --- |
| `synced` | Current outbox is empty after acknowledged sends; not proof of provider compatibility, deployment or Cloud-wide freshness. |
| `pending` | The run reached its 50-send budget with queued work remaining. Invoke sync again with the same identity, state and approved integration list. |
| `busy` | Another process owns the 30-second renewable lease. Let it finish; a crashed owner can be replaced after expiry. Do not run competing copies of the same state. |
| Network/authorization/status error | The call throws a bounded error code and keeps unacknowledged events. Inspect connection activation, expiry, bindings and clock; retry without deleting or editing SQLite. No automatic execution retry is granted. |
| `cloud.sqlite3` | Bound to its installation and wire project, with exact events, next sequence and projected-summary digests. It contains no credentials. A lost acknowledgement reuses the identical event ID, sequence and timestamp. |
| Capacity | At most 1,000 pending events, 50 sends per invocation and sequence numbers 0–1,000,000 inclusive. Exhaustion is explicit, with no automatic pruning or reset; preserve evidence and enroll a replacement when necessary. |
| Credentials | Enrollment lasts at most 90 days; Cloud access tokens last at most five minutes. Token issuance is limited to ten per minute and fifty live tokens per installation. Avoid tight retry loops; repeated standalone sync invocations obtain new tokens. |
| Revocation | Cloud rejects the revoked connection and its existing tokens. It cannot recall a locally running job, and personal account closure does not implicitly revoke organization-owned workers. |

The server retains the latest 1,000 matching receipts and requires exact ordered sequences. Do not clone an active outbox into a second installation, delete its sequence or manually drop an event to bypass a rejection. Pending maintenance events require the original local sharing selection; if consent is withdrawn, they are not sent automatically. There is no general outbox-abandonment or remote key-rotation protocol in this version.

For maintenance, `recordedAt` is the most recent selected local execution's update time, or the job's creation time if there is no execution. Runner status uses its enqueue time. Offline retries preserve both. Cloud's first reported-state timestamp and its latest receipt timestamp are distinct; protocol v1 does not update the subscription's provider-observation time. Future timestamps beyond two minutes are rejected, so correct the machine clock rather than rewriting queued evidence. Selected/passing test counts refer to selected test targets, not individual framework cases. Cloud displays summaries and can send opted-in attention emails; execution, publication, merge and deployment keep their separate local authorization requirements.
