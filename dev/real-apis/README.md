# Real API maintenance laboratory

This application uses the public SelfManagedApi SDK (`import … from 'self-managed-api'`), its persistent worker and its approval/validation flow. Ten official public sources are fetched through the normal bounded HTTPS observer. Downloaded documents and worker evidence stay in ignored `work/real-apis` and are never executed.

Provider operations use a deliberately closed, simulated transport. No provider API keys, payments, orders, uploads or real messages are involved. The Notion SDK versions are genuine, pinned development dependencies: `4.0.2` and `5.27.0` (MIT, Node >=18). They are not runtime dependencies of the distributed SelfManagedApi client.

## Run

Use Node 24, the repository's pinned pnpm and the comparator installed by `pnpm engine:setup`:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm engine:setup
pnpm dev:apis seed
pnpm dev:apis catalog
pnpm dev:apis inventory
pnpm dev:apis fetch-docs
pnpm dev:apis observe
pnpm dev:apis serve
```

The consumer binds only to `127.0.0.1:43230`. Inspect `/integrations`, `/notion/native`, `/notion/sdk` and `/integrations/<provider-id>`. The transport rejects any request outside its fixed catalogue. Its server cannot be used as an open proxy. `serve` belongs to this development fixture, not the customer SDK runtime.

The initial Notion exercise selects `2022-06-28`. Both the native call and actual legacy SDK return the same internal page IDs and pagination. In another terminal:

```sh
pnpm dev:apis version 2025-09-03
pnpm dev:apis observe
pnpm dev:apis jobs
pnpm dev:apis plan JOB_ID
```

The old consumer now fails in the **local simulation**. This is not a claim that Notion has shut down all requests on the old version. The worker matches the removed native call path to a locally authored, partial OpenAPI projection of the documented transition. The recipe changes the path, version header and SDK call; it requires an explicitly selected `dataSourceId`, preserves pagination and rejects malformed output. SDK call analysis is explicit through the application boundary and dependency declaration; the scanner does not claim to infer all SDK internals. `defineIntegrationBoundary` associates the function with the manifest without changing its behavior.

The recipe never treats a database ID as a data source ID, chooses the first source automatically or upgrades a package silently. The SDK dependency update remains a separately reviewed application change. Source documents can describe requirements, but cannot authorize execution or override local policy.

`plan` shows the exact proposal, decisions and discovered test. Execute only the reviewed request:

```sh
pnpm dev:apis validate JOB_ID REVIEWED_REQUEST_ID
pnpm dev:apis executions
```

Validation requires Linux x64 with the documented local Docker socket and pinned image. Initialize a separate lab on a Linux filesystem; Windows and Linux state must not be moved between hosts. The baseline and candidate run the same four contract tests in isolated containers with no network. A failing baseline and passing candidate is recorded as `improved`, not automatically deployed. The live checkout remains unchanged. Unit tests separately exercise both genuine SDK majors against the closed provider transport; Docker validation exercises the SDK port without installing third-party packages inside the sandbox.

## Sources and coverage

Source selection was reviewed on 2026-10-08. `catalog.mjs` records the exact retrieval URLs. Each capture records its time, hash and byte count locally; subsequent observations preserve the configured baseline. Mutable vendor pages are observations, not pinned release artifacts. HTML/prose changes require review and can include cosmetic changes. No claim of complete vendor coverage or automatic interpretation is made.

| Provider | Official source | Exercise / decision |
| --- | --- | --- |
| Stripe | [Upgrade guide](https://docs.stripe.com/upgrades), [official SDK README](https://github.com/stripe/stripe-node) | Request version, SDK version and webhook version are separate. Captures the public SDK README. |
| PayPal | [Deprecated resources](https://developer.paypal.com/api/rest/deprecated-resources/) | Payments v1 to Orders v2 needs payment-workflow decisions. No automatic rewrite. |
| Amazon SP-API | [Release notes](https://developer-docs.amazon.com/sp-api/docs/sp-api-release-notes), [Catalog Items model](https://github.com/amzn/selling-partner-api-models/blob/main/models/catalog-items-api-model/catalogItems_2022-04-01.json) | Old path, marketplace and parser dependencies. The Swagger 2 model is observed as text, not falsely accepted as OpenAPI 3. |
| GitHub | [API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions) | Explicit request header; an older version is not necessarily unsupported. |
| Slack | [files.upload retirement](https://docs.slack.dev/changelog/2024-04-a-better-way-to-upload-files-is-here-to-stay/) | A multi-step replacement cannot be solved by replacing a URL. |
| Notion | [2025-09-03 migration](https://developers.notion.com/guides/get-started/upgrade-guide-2025-09-03) | Full local native/SDK failure, proposal and validation exercise. This is a selected historical transition, not a recommendation to target the latest API. |
| Shopify | [API versioning](https://shopify.dev/docs/api/usage/versioning) | Effective response version and GraphQL fields matter beyond the URL. Shop hostname is fictional and never contacted. |
| Twilio | [API overview](https://www.twilio.com/docs/usage/api) | Date-shaped path does not itself prove retirement. |
| SendGrid | [Web API v3](https://www.twilio.com/docs/sendgrid/api-reference/how-to-use-the-sendgrid-v3-api) | Required payload and permissions matter even without URL changes. No email is sent. |
| Discord | [API reference](https://docs.discord.com/developers/reference) | Version, permissions and rate-limit requirements remain separate evidence. No bot token is needed. |

All ten have discoverable native call paths and explicit manifests. Only the Notion exercise currently has a complete reviewed migration recipe; the other nine are discovery/documentation scenarios, not nine fabricated successful migrations. No third-party documentation is committed to the repository.

## Run the local worker

```sh
pnpm dev:apis worker
```

The loop checks local contracts every 15 seconds and public documentation every 15 minutes. Local observation/state failures stop this development supervisor visibly. Review jobs remain local until an explicitly approved action runs. This worker does not need an account or enrollment.

## Verification

- `test/real-api-lab.test.mjs`: ten manifests/native paths, unknown decision blocks planning, real old/new SDK requests, native path/header migration, pagination and missing-source rejection.
- `integration/real-api-validation.test.mjs`: real persistent job, exact approval, unchanged tests, failing baseline/passing candidate, container cleanup and approval replay rejection.
- Existing source observer tests cover source budgets, SSRF restrictions, failures and hostile documentation; the lab does not disable those controls.

For a fresh experiment, seed another owned lab directory through `seed(root)` or use a separate checkout. The commands preserve existing state and do not include a destructive reset.
