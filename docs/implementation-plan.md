# Plumber implementation plan

Status: planning baseline. This document describes intended behavior and acceptance criteria; it does not report implemented features or successful tests.

## 1. Product boundary

Plumber serves teams consuming multiple external APIs and MCP servers. There are two products: this installable SDK/CLI/optional worker, and [Plumber Cloud](https://github.com/Altitud-Studio-S-L-U/plumber-cloud), comprising the landing page, panel, accounts, subscriptions, coordination, and notifications.

The installable works on customer-controlled computers, CI, or self-hosted infrastructure. Its core can operate without a cloud account. The worker is an explicit execution mode, not a background process started merely by importing the SDK. Production application traffic does not pass through Plumber.

The cloud coordinates maintenance without receiving customer code. It can observe public sources once for multiple subscribers; private sources and repository analysis stay with the customer. GitHub remains the customer's code host. A customer may authorize a remote AI provider, contacted directly by the runner, or use a local model. These are distinct data recipients.

The core proof is a provider change that requires updating a consumer call and its own parser while preserving the application's internal contract. Supporting many source formats is secondary to demonstrating that complete workflow.

## 2. Scope and non-goals

Initial consumer discovery targets TypeScript and JavaScript: imports, native HTTP calls, supported SDK usages, MCP invocations, validation, parsing, and conversions into application models. Static analysis must report uncertainty for dynamic URLs, generated code, reflection, and indirect dispatch. Discovery is evidence of identified usages, not proof that every usage was found.

Preserve existing integration styles. Optional SDK decorators or explicit integration registration can identify boundaries and internal invariants, but existing applications must not require annotation. An external schema describes the provider boundary; an internal contract describes what the application expects. Neither replaces the other.

Initial non-goals include automatic merge or deployment, arbitrary-language migration, a universal runtime proxy, complete inference of undocumented semantics, a new API-description standard, enterprise infrastructure automation, and installation of model weights by default. Generating provider schemas is an expansion path, not a prerequisite for consumer independence.

## 3. Sources and evidence

Each adapter produces a bounded snapshot with source identity, retrieval context, timestamps, declared version, content digest, completeness, and evidence references. Credentials never appear in snapshots or logs.

| Source | Intended behavior | Important limit |
| --- | --- | --- |
| OpenAPI | Read local or authorized remote documents; resolve permitted references; compare structures using pinned local `oasdiff` | Structure does not establish units, business meaning, or deployed behavior |
| JSON and JSON Schema | Preserve whether input is a declared schema or an example; compare declared contracts | Inferring a schema from examples cannot prove required fields or exhaustive variants |
| Documentation and changelogs | Track selected pages/sections, filter presentation changes, retain supporting evidence | Changed prose does not establish a deployed breaking change |
| SDK releases | Relate installed lockfile versions, types, release notes, and usage | Package and remote API versions are different facts |
| Database metadata | Use explicitly configured read-only access to schema/catalog metadata, with timeouts | No row sampling by default; database structure is not an API's authorization or public contract |
| NestJS/FastAPI exports | Consume existing OpenAPI exports; later offer explicit framework-assisted export workflows | Loading application modules is execution and can have side effects |
| MCP | Capture complete tool catalogs, input schemas, available output schemas, and relevant server/protocol context | Auth context, pagination, capabilities, and missing output schemas affect interpretation |

Remote references, redirects, downloads, and parsers require size, depth, time, and destination limits. Remote documents cannot authorize local-file reads, shell commands, new credentials, or broader network access. A failed or incomplete capture must not look like mass removal of operations.

Framework export that starts or imports an application requires authorization and isolation. Private DB and MCP credentials remain local. MCP observation must not invoke arbitrary tools to discover their behavior; any contract probe needs an explicitly permitted non-destructive operation and environment.

Keep provenance separate from confidence: declared contract, observed behavior, documentation claim, and inferred interpretation. AI-generated interpretations retain evidence references and uncertainty. Missing evidence produces a review requirement, not an invented migration rule.

## 4. Effective versions and compatibility

Track the version actually consumed: endpoint and environment, account-level API version where known, relevant request version headers, enabled capabilities, installed SDK version, and the repository revision analyzed. Latest documentation is not automatically the consumer's target.

MCP captures retain negotiated context and an opaque authorization-context identifier without storing credentials. A permission change must not automatically be classified as a provider deleting tools.

Distinguish observed, analyzed, proposed, validated, and adopted versions. Opening a PR does not mean its change was installed; merge does not establish production deployment. Adoption reflects the repository state actually verified, with deployment status unknown unless a later explicit integration provides evidence.

Classify compatibility in the correct direction: request requirements and response guarantees differ. Renaming a response field can affect a parser even when a generated client still compiles. Changes in units or meaning may need migration with no structural schema difference.

Maintain a source manifest per provider/product: execution domains, documentation and release locations, version selectors, security feeds, observation method, coverage, and support dates. Start with Stripe, Amazon SP-API, a manually configured HTTP integration, and controlled MCP fixtures. Record all known versions without claiming exhaustive coverage. Prefer provider events and conditional feeds; bounded polling and periodic reconciliation cover sources without a publishing integration.

For an SP-API retirement, identify affected operation versions, marketplace/region, effective calls, and installed SDK separately. An old SDK can remain compatible; a new SDK cannot revive a retired endpoint. The plan lists replacement operations, prerequisites, permissions, deadline evidence, and required consumer/parser changes. If no compatible replacement exists, report a business decision instead of fabricating an adapter. For Stripe, track API, SDK, account/request configuration, and webhook versions independently. [SP-API deprecations](https://developer-docs.amazon/sp-api/lang-US/docs/sp-api-deprecations), [Stripe versioning](https://docs.stripe.com/api/versioning).

Resolve package advisories against lockfile versions and relevant transitive dependencies. Distinguish a known affected dependency from proven exploitability and from a provider's unrelated endpoint change. Security urgency affects prioritization, not the authorization boundary; active penetration testing is outside the default scanner.

## 5. Runtime, packages, and contracts

Use Node.js 24, TypeScript, and pnpm. Keep responsibilities within one repository: engine, source integrations, code discovery/migration, SDK/CLI/worker entry points, and shared contracts. Split packages only around actual consumers or release boundaries; do not introduce a service framework or generic repository abstraction.

Use SQLite through `better-sqlite3` for local durable state. Verify native-module compatibility and distribution on the supported Node/OS combinations before promising installation support. Use a pinned `oasdiff` executable locally, with verified release provenance/checksum and an explicit platform acquisition strategy. Users must not need an unplanned Go toolchain or an unverified download during a migration.

This repository owns the shared protocol as a versioned package. Cloud consumes a declared package version through the chosen registry, never a sibling filesystem import. There is no third repository. Package scope, registry, and distribution permissions remain subject to availability and setup; no unpublished package name is presented as installable.

Shared contracts cover subscriptions, source references, change evidence, runner capabilities, impact summaries, plan summaries, authorization, job states, sanitized results, and compatibility negotiation. Full local artifacts are separate types from permitted cloud messages. Validate inbound and outbound data, reject unknown fields where appropriate, and maintain protocol fixtures consumed by both repositories.

Version protocol changes explicitly. An incompatible runner should report an upgrade requirement and preserve pending work, rather than partially accepting a job.

## 6. Local state and privacy boundary

Persist source snapshots, consumer baselines, plans, approvals, execution attempts, validation evidence, and Git references in customer-controlled state. Keep state and secrets outside the mutable consumer checkout. Honor an existing project work location for isolated intermediate artifacts; otherwise use an explicitly managed location. Cleanup targets only artifacts owned by a recorded run.

The cloud message allowlist contains opaque identifiers, public-source evidence where permitted, timestamps, counts, typed reasons, conclusions, and authorized GitHub links. Exclude source code, patches, file contents, prompts, raw traces, unrestricted error messages, private schema bodies, and PR/comment bodies. Filtering happens before transmission. Regex redaction alone is insufficient.

Optional synchronized inventory fields include explicitly approved display labels, public provider/version identifiers, and selected public operation identifiers. Private operations use opaque identifiers; private routes, schemas, and literal test commands remain local. The panel receives validation-task identifiers and permitted labels, while the complete commands belong to the local approval plan.

The runner publishes and reads GitHub directly. It does not send raw GitHub webhooks to the SaaS: comments, checks, and PR bodies can contain code. The cloud panel links to GitHub for code review. Slack receives the same permitted summaries, not test logs or snippets.

Tests must verify the outbound boundary using distinctive fixture content in code, errors, prompts, and private documents. Include rejection of extra fields and accidental serialization of local artifacts. Disable telemetry and crash-report paths that could bypass that contract. Encryption after upload would not satisfy the no-code requirement.

## 7. Impact, plan, authorization, execution

The default workflow is:

1. Observe a complete source snapshot and determine the applicable version transition.
2. Inspect the consumer without running its code. Identify calls, SDK paths, parsers, adapters, internal invariants, and unresolved references.
3. Produce an impact assessment and a plan: proposed operations, affected scope, evidence, risks, validation commands, required network access, model policy, and resource budget.
4. Obtain authorization for that plan before code modification or repository execution. Bind it to the repository, base revision, change evidence, and local policy version.
5. Prepare an isolated checkout and execute only permitted steps. Generate a patch and run relevant validation.
6. Present the detailed result locally; publish a PR directly from the customer environment when the authorization permits it.
7. Track review/CI/merge and reconcile adoption against actual repository revisions.

The cloud approval screen authorizes scope and execution from a summary; it does not claim to review unseen code. Approval expires when material scope, target revision, or policy changes. Default authorization is per plan. Future standing approvals would require explicit bounded policies, not inference from account signup.

In the alpha, expanding permissions, registering or replacing credentials, or changing the local policy ceiling requires local confirmation. An already approved execution or Git publication can run unattended in customer CI within that ceiling. Do not require a second interactive approval merely because the approved job moved from planning to execution.

Unknown behavior, unexpected files, broader dependency upgrades, or new network requirements stop execution for an updated plan. No silent expansion into unrelated cleanup or architectural rewrites. Keep the internal model stable where supported by evidence; when the provider change makes that impossible, explain the required application decision.

A PR describes the provider change, resulting consumer behavior, supporting evidence, validation performed, and unresolved limits. Failure is a first-class result. Draft publication of incomplete work must be authorized and clearly labeled; it never appears as a validated migration.

## 8. Deterministic processing and optional AI

Use deterministic capture, normalization, schema comparison, syntax analysis, state transitions, authorization, and Git bookkeeping. Exact known transformations should not require a model.

An optional lightweight model can classify documentary evidence and assist bounded changes. A more capable configured model may handle multi-file reasoning and custom parsers. Both return validated structured proposals; neither decides permissions, manufactures successful test results, or obtains publication credentials.

Without AI, observation and supported deterministic migrations remain usable. With remote AI, the runner sends only authorized context directly using customer credentials. With local AI, connect to an existing configured endpoint. Do not install weights, assume hardware availability, or silently fall back to a remote provider.

Evaluate interchangeable models on parser correctness, regression rate, unsupported-assumption detection, reviewer effort, peak memory, CPU/GPU requirements, latency, and cost per accepted migration. Escalation and repair attempts require bounded policy and budget. New evidence can justify another patch; repeatedly rerunning a failing test cannot establish correctness.

## 9. Runner identity and execution security

Cloud identity integrates with the cloud product's maintained Better Auth-based authentication. A runner has a separate per-installation API key and locally generated key pair. Enrollment requires a short-lived challenge, proof of possession, and approval of the public-key fingerprint displayed locally and in the enrollment flow. The private key stays in the customer's credential store.

The API key alone must not register replacement keys or obtain usable unbound credentials. Integrate token issuance through Better Auth's OAuth provider using its documented client-credentials and DPoP capabilities. Issue short-lived, scoped tokens bound to the approved key; verify proof and binding on every protected request. The identity spike must verify current APIs, binding to the enrolled key thumbprint, audience, expiry, method/URI, a shared replay store, applicable nonces, and installation revocation checks on each request. Do not label a custom API-key signature protocol as DPoP.

Revoke installations and credentials with a documented maximum enforcement delay, including already-issued tokens. Rotation requires existing proof or a newly approved enrollment. No hardware identity or anticloning guarantee is claimed: copying both software secrets can copy the identity. DPoP does not authenticate arbitrary job content or protect against a compromised control plane. See [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html).

The intended Cloud guarantee is denial at the next authorization decision after revocation, including for unexpired tokens. Offline local work cannot be recalled by token revocation; stop new Cloud work and reconcile cancellation separately from work already running.

Local policy lives outside the agent-writable checkout and fixes repositories, destinations, model providers, execution commands, limits, and publication permissions. Cloud jobs are typed requests, not shell scripts. They cannot broaden policy. A compromised cloud can still request allowed work, consume permitted resources, and misreport status; independent local confirmation or GitHub review is needed for stronger assurance of user intent.

Automatic change generation and test execution require a container or ephemeral customer CI environment. A child process or Git worktree is not a sandbox. Keep credentials, the home directory, host control sockets, and unrelated repositories outside that environment. Bound time, memory, writable paths, and network access. Dependency installation and application imports also execute code. Give publication credentials only to the separate publication step.

## 10. Scheduling, idempotency, and failure recovery

The worker uses outbound connections; no permanent public listener is required. Desktop execution is available only while the machine runs. CI/self-hosted runners provide continuity according to customer infrastructure. When disconnected, private observations become stale; public cloud observations may continue and queue work.

Use transactions and durable identifiers for source transitions and consumer attempts. Distinguish deduplication from ownership: prevent concurrent writers, record a job lease, and confirm current ownership before publication. After a crash, reconcile existing branches/PRs before retrying. A cloud timeout does not prove publication failed.

Do not overwrite human commits on a generated branch. A changed base requires applicability checks and renewed validation. New upstream versions are reconciled from the last adopted consumer state; they do not erase unfinished migrations. Retry transient transport failures within limits; stop on semantic uncertainty, invalid credentials, conflicting changes, or exhausted budgets.

Report source freshness, execution status, and adoption separately. Emit meaningful Slack transitions and update the existing run conversation rather than creating repeated alerts. Cloud subscription entitlements are enforced by the cloud; local clock changes must not extend the server-managed trial.

## 11. Validation and integrity

Use behavior-led TDD for consequential engine and protocol changes. First establish the relevant contract and reproduce the failure where feasible. Keep tests independent of the implementation's internal names. Never delete, skip, weaken, or rewrite a valid assertion to make a migration pass.

Discover the consumer's existing test tools, scripts, CI configuration, fixtures, and integration/contract tests without executing them. Put the selected commands and any required services in the approval plan. Record baseline failures and compare before/after on the same environment. A newly generated regression test complements existing coverage; it cannot replace a valid consumer contract. Missing credentials or unavailable services produce partial/unverified results, never synthetic success.

The canonical API fixture has versions A and B, a TypeScript consumer, a custom parser, and a stable internal model. The consumer passes against A, fails against B before migration, and passes relevant checks after the approved update. Add an ambiguous-unit-change fixture that requires review despite compatible numeric types.

The MCP fixture changes an explicit tool input contract and a declared output consumed by a parser. Confirm that changed authorization or an incomplete catalog does not masquerade as removed capabilities. Missing output contracts remain an explicit limitation.

Required acceptance coverage includes:

- Request/response compatibility direction, references, malformed inputs, and incomplete captures.
- Native calls, supported SDK paths, custom parsing, and unsupported dynamic usages.
- No repository execution or mutation before authorization; scope changes invalidate approval.
- Secret and code exclusion from cloud messages, model egress policy, and isolated execution boundaries.
- Bound-token misuse, replay, expiry, key mismatch, revocation, and cross-organization access denial.
- Duplicate events, simultaneous runners, stale bases, human commits, interrupted publication, and recovery without duplicate PRs.
- Existing failures distinguished from new regressions; validation results tied to the tested revision.

An end-to-end pilot must create a real PR in an authorized test repository, report sanitized cloud status, and update the configured Slack conversation. Controlled fixtures prove those scenarios only. Record checks that passed, failed beforehand, or could not run; compilation alone does not prove semantic compatibility with a live provider.

## 12. Delivery phases and release gates

| Phase | Deliverable | Exit criterion |
| --- | --- | --- |
| 0. Foundation | Clean repository structure, dependency/license review, shared protocol ownership, privacy contract, supported-platform matrix | Dependency and identity spikes resolve distribution and DPoP integration risks; contracts have agreed fixtures |
| 1. Observation | Local snapshots, pinned structural diff, effective-version tracking, TS/JS discovery | Repeatable evidence; incomplete sources and unsupported usages are reported without false removal claims |
| 2. Local migration | Impact/plan approval, isolated execution, API call plus parser migration | Before/after regression proof, preserved internal behavior, ambiguous case stopped correctly |
| 3. Connected alpha | Runner enrollment, shared package integration, direct GitHub PR, cloud state, Slack update, one MCP case | Both API and MCP scenarios complete the authorized workflow without code reaching the SaaS |
| 4. Reliability | Concurrency, recovery, revocation, stale sources, policy enforcement, installer validation | Failure scenarios preserve work and permissions; supported platforms install and run reproducibly |
| 5. Source expansion | Docs-driven evidence, read-only DB metadata, framework exports, further SDK patterns | Each addition demonstrates a real consumer workflow and bounded failure behavior |
| 6. Pilot and distribution | Customer pilots, compatibility policy, measured model economics, package publishing process | Review effort and accepted migrations justify expansion; release claims match verified scope |

Cloud landing/account work can proceed against the versioned contracts in parallel. Public onboarding, a 30-day no-card trial starting with the first runner, and hosting in a US region are cloud decisions; they do not justify exposing repository content or weakening local authorization.

Keep package names tentative until availability is checked. Both repositories begin private. Apache-2.0 public distribution of the installable is proposed and requires a deliberate licensing/publication step. This document supplies no license grant and claims no production readiness.
