# Live API validation pilot

This opt-in development workflow exercises a documented change against the real GitHub API, then uses the public SelfManagedApi SDK to observe, propose, validate and publish an explicitly approved draft. It is separate from the simulated operations in the ten-provider documentation laboratory. Nothing runs automatically in ordinary SDK imports or CI.

GitHub's [2026-03-10 breaking changes](https://docs.github.com/en/rest/about-the-rest-api/breaking-changes#version-2026-03-10) change directory-listing submodules from `type: "file"` to `type: "submodule"`. The pilot reads the public `git/git` repository, whose root includes `sha1collisiondetection`. Both API versions remain selectable; this is a deliberate version upgrade, not a claim that the older version was retired.

## Evidence and boundaries

- Public calls use no token, retries or writes. Captures are bounded to 1 MiB/15 seconds and must contain the exact selected API-version header. A response cached for another version is rejected. Two documented `ref` selectors identify the same source tree; all entry paths and blob SHAs must match before comparing versions.
- Original response bytes, hashes and timestamps stay in an ignored directory. A fresh directory is required for each capture. There is no synthetic fallback when a provider fails or changes behavior.
- The OpenAPI document is a **locally authored partial projection** of official documentation and observed responses. The SDK does not automatically turn prose into a trustworthy schema. The scanner maps the native call; indirect parser tracing can remain unresolved.
- The recipe is explicitly authored and reviewed. It accepts the new type and selects the new API version while preserving the internal `{path, directory, downloadable}` model. A submodule stays non-downloadable. No model is used or implied.
- Docker replays actual captured public responses, with three unchanged Node tests and no network. Baseline failure and candidate success prove this selected migration, not every behavior of GitHub. A separate fresh live request checks the candidate parser after validation.
- The GitHub publication adapter creates the draft directly. Its credential never enters consumer execution. The fixture branch must not be merged into product `main`.

## Prepare and inspect

Use the repository's documented Node/engine dependencies. Run validation and publication from a stable Linux x64 path with the supported Docker host and Git executable. Keep the runtime, captures, consumer and state as separate directories; do not move a worker database between Windows and Linux.

```sh
node dev/live-validation/capture.mjs work/capture-unique
node dev/live-validation/cli.mjs seed /private/pilot-unique work/capture-unique
node dev/live-validation/cli.mjs observe /private/pilot-unique
node dev/live-validation/cli.mjs plan /private/pilot-unique
```

`seed` requires a new canonical directory and copies only reviewed pilot templates plus data-literal replay input. It does not initialize or push Git. `observe` uses the real SDK/worker store and creates one review job. `plan` shows exact edits, selected tests, image, execution policy and request ID without authorizing execution. `SELF_MANAGED_API_ENGINE` can select an already trusted absolute engine path.

## Validate and prepare publication

Initialize and commit the generated consumer as a disposable `feat/live-base` branch in a separate repository that you control. Set the destination in `environment.mjs` before reviewing or publishing. Review its five files before pushing. Do not use the main project checkout as the pilot consumer.

```sh
node dev/live-validation/cli.mjs validate /private/pilot-unique REVIEWED_REQUEST_ID
node dev/live-validation/cli.mjs candidate /private/pilot-unique COMPLETED_INTENT_ID
node dev/live-validation/cli.mjs verify-live /private/pilot-unique REVIEWED_CANDIDATE_ID
```

`validate` explicitly authorizes only the exact displayed request, runs the SDK's queue and isolated validator, and requires `improved`. It leaves the consumer unchanged. `candidate` additionally verifies committed Git blobs and retained validation evidence. `SELF_MANAGED_API_GIT` can select a compatible absolute Git executable. No provider data or test is edited to force a pass.

Push the reviewed baseline only to its fixture branch after authorization. For the SDK's API publication, inject `GH_TOKEN` into the process through the operator's secret manager. Use a repository-scoped credential with metadata read, contents write and pull-request write. Do not put tokens in command arguments, files, terminal output or the consumer.

```sh
node dev/live-validation/cli.mjs review /private/pilot-unique
node dev/live-validation/cli.mjs publish /private/pilot-unique REVIEWED_PUBLICATION_REQUEST_ID
```

`review` performs read-only destination/base checks. `publish` is a distinct explicit approval and write: the SDK creates immutable objects, a new `feat/api-…` branch and a draft PR against `feat/live-base`. It does not merge, deploy or overwrite branches. If a write is uncertain, preserve the request and receipt, and use `reconcile` with the same request ID; never repeat `publish` blindly. Record and review the returned PR URL through the normal project workflow.

Keep all capture, approval and recovery evidence until the pilot is reviewed. This workflow deliberately has no destructive reset or automatic fixture-branch deletion.
