# Quota snapshots and task routing

Status: implemented and covered by offline tests with synthetic fixtures only. **Real routing has not been live-verified.** No provider, auth store, network endpoint or Windows ACL helper is used by the tests. No paid setup, new dependency, service, daemon, startup change or persistent permission is introduced; only existing subscription logins already used by `wrapper.mjs` are involved.

## Files

- `quota-snapshots.mjs`: snapshot validation (`normalizeSnapshot`), injected collectors (`collectSnapshots`), file import (`importSnapshotFile`), pool indexing.
- `task-router.mjs`: policy/task validation, pure dry run (`routeQueue`), single-task dispatch (`dispatchTask`).
- `router-cli.mjs`: `dry-run` (default) and `execute` commands.
- `examples/*.example.json`: synthetic queue, snapshot and policy. The snapshot is marked `mock`, so it can never authorize a live call.

## Quota collection: manual blocker

No automatic collector is shipped, because none could be verified safe:

- Win-CodexBar 0.60.3 (`codexbar.exe` / `codexbar-cli.exe`) documents `usage --provider P --json --source auto|web|cli|oauth` and a one-shot `dashboard --identity redacted` that fetches every enabled provider.
- In the public v0.60.3 source the Claude provider's `SourceMode::Cli` falls back to OAuth after some CLI failures, and the Codex provider fetches OAuth-backed usage. Running these would touch credential-backed fetches that this project does not authorize.
- Extracting browser cookies, keychain or token stores, scraping undocumented endpoints, reading another tool's config or credentials, and inventing cache/export flags are all out of scope.

Sources: <https://github.com/nesszer/Win-CodexBar> and <https://github.com/nesszer/Win-CodexBar/blob/v0.60.3/rust/src/providers/claude/mod.rs>.

Accepted inputs today:

1. A **manual snapshot** you typed or reviewed yourself (`source: manual`, `reviewed: true`).
2. A **supported export** adapted by an injected collector object `{id, source: 'supported-export', collect()}`, whose snapshots carry `provenance: {adapter, scopeVerified: true}`. No such adapter exists or is verified yet; the plug-in point is `collectSnapshots`. File import rejects `supported-export`.
3. A **mock** (`source: mock`) for demos and tests. A mock is identified, may appear in dry runs (flagged `liveAuthorized: false` and warning `mock_quota_not_live`), and never authorizes execution.

## Snapshot schema

A snapshot file is `{schema: 1, snapshots: [...]}` (max 64, 256 KiB). Each snapshot:

- `schema` 1; `source` `manual|mock|supported-export`; `reviewed: true` (manual only); `provenance` (supported-export only).
- `provider` `claude|antigravity|codex`; `accountScope` an opaque local alias (letters, digits, `_`, `-`; never an email or real account id); `modelScope` a label such as `sonnet`.
- `observedAt`: ISO-8601 with explicit `Z` or offset.
- `windows[]`: `name` (for example `session`, `weekly`, or a model-specific name), `remainingPercent` (finite, 0-100), `resetsAt` (explicit offset, after `observedAt`), `resetTimezone` (IANA zone whose offset at `resetsAt` must match the written offset).

Unknown fields (account, billing, raw errors) are stripped by a strict allowlist and not retained. Any invalid value rejects the whole snapshot with a static reason code; the raw value is never echoed. A pool is `provider + accountScope + modelScope`: native Claude, Claude inside Antigravity and Codex are separate pools and are never merged. Differing duplicates of a pool block that pool (`conflicting_snapshots`).

## Policy (reviewed by the caller)

`{schema: 1, reviewed: true, preference?, providers: [...]}`; the provider order is the ordinary routing order. Dispatch entries need `provider`, `mode: dispatch`, `accountScope`, `modelScope`, `roles`, `maxSize`, `maxAgeSeconds`, `requiredWindows`, and `reservePercent` for every required window. Every required window must be present, unexpired, non-exhausted and fit demand plus reserve. Handoff entries need `provider`, `mode: handoff`, `roles`, `maxSize`.

Role ceilings are fixed in code and a policy cannot widen them: Claude `draft, implementation`; Antigravity `draft, prototype`; Codex `coordination, verification, review`. Models are fixed (`sonnet`, `gemini-3.8-flash-medium`); there is no automatic tier upgrade. Codex is handoff only because no Codex executor is verified.

### Temporary Claude preference

`preference: {provider: 'claude', until: '2026-10-03T07:00:00+09:00'}` (that is 2026-10-02T22:00:00Z). Before `until` (strictly), Claude is tried first **only for tasks that already permit it and only if it is eligible**. At exactly `until` the preference is over and the policy order applies. This is a preference expiry, not a provider reset, not capacity and not permission to create tasks; an exhausted, stale or mismatched Claude pool is still blocked.

## Queue

`{schema: 1, tasks: [...]}` (max 100). The queue is an explicit finite list; nothing is generated and no conversation or file context is loaded. Each task has exactly: `id` (UUID), `prompt` (standalone UTF-8 text, at most 64 KiB), `classification` (`public|personal|corporate|confidential|secret`), `approval` (`not-required|required|approved`), `providers` (permitted list), `role`, `size` (`small|medium|large`), `permissionScope: 'text-only'`, `timeoutSeconds` (1-600), `estimates`, optional `allowExecute` (default false) and `taskScope` (Antigravity only).

`estimates` maps provider to `{durationSeconds, windows: {name: percentPoints}}`, positive finite numbers up to 100. Missing estimates for any required window block.

Only `public`, and `personal` with `approval: approved`, are eligible. Tasks with `approval: required` stay blocked until set to `approved`. **Classification is an operator assertion, not proof that the text is safe to send.** A best-effort pattern check blocks some obvious secret formats (private-key headers, common token shapes); it is not a scanner. Duplicate UUIDs, identical or conflicting, block every occurrence.

Antigravity tasks need the existing wrapper `taskScope` with its inherited-permission acknowledgments and `mode: plan`. Claude tasks ignore `taskScope`; local tools stay disabled.

## Dry run

```
node router-cli.mjs dry-run --queue examples/routing-queue.example.json --snapshots examples/quota-snapshot.example.json --policy examples/routing-policy.example.json --now 2026-10-02T12:00:00Z
```

`--now` exists for dry runs only (fixed demo timestamps); `execute` rejects it. Output: `{schema, dryRun, now, preferenceActive, decisions[], summary, snapshotImport}`. Each decision has `id`, `status` (`eligible|handoff|blocked`), reason codes, and candidates. Eligible decisions add `provider`, `model`, `fingerprint`, `quotaSource`, `liveAuthorized`, `executePermitted`, `preferenceApplied`, `warnings`. Handoff decisions add `adapterRequired: true`. Blocked decisions may add `deferUntil`, the earliest reset among constrained windows; it is a hint to take a new observation after that time, never assumed capacity.

The dry run is pure: it spawns nothing and reserves nothing. It uses size limits, estimated duration and demand, remaining percent, reserve, time to reset and freshness. Demands of eligible tasks are accumulated within the batch so tasks cannot overspend the same window. These batch reservations are dry-run estimates only, not a global cross-process quota lock: concurrent dispatches of different task UUIDs can use the same observation, so the caller must serialize dispatch and use fresh snapshots. No globally enforced provider budget is claimed. Reasons include `snapshot_stale`, `snapshot_future`, `window_missing`, `window_expired`, `window_exhausted`, `reset_before_completion`, `insufficient_headroom`, `missing_estimate`, `invalid_estimate`, `scope_mismatch`, `no_snapshot`, `conflicting_snapshots`.

## Execute

```
node router-cli.mjs execute --queue Q.json --snapshots S.json --policy P.json --task UUID --confirm-execute
```

Runs one task with at most one GENERATION (one existing-subscription provider call), using the real clock. `subscriptionPreflight` consists of read-only CLI checks and is not a generation. Requirements: the task is eligible now, `allowExecute: true`, the quota source is not `mock`, and `subscriptionPreflight` succeeds. Eligibility is re-evaluated after preflight and just before reservation. It is evaluated once more after the durable reservation and ledger writes, immediately before the executor call, using the real clock, the same provider and fingerprint, `executePermitted`, `liveAuthorized` and the cancellation signal. If that final check fails, the reservation is kept, the outcome is recorded as unknown/blocked-before-launch, nothing is launched, and the task is never rerouted or retried. A dispatch `modelScope` must equal the verified dispatch model (`sonnet` for Claude, `gemini-3.8-flash-medium` for Antigravity); a reviewed alias alone does not prove that a different model's quota applies, so any other label is rejected. `execute` fails closed when any snapshot import entry is rejected, with a static reason and no preflight or executor call. Dry run still lists the rejections but warns that a partial import cannot authorize a live call. The best-effort obvious-secret gate also covers an Antigravity `taskScope.description`, because it is sent to the provider with the prompt; classification remains an operator assertion and secret detection is not perfect. The existing wrapper then runs with `captureResult: true` through `executeWithDiagnostics`; only the task prompt is sent, never quota, policy or account data. There is no automatic retry and no fallback, including after unknown outcomes.

Output: `{schema, outcome, id, launched, reasons}`. `outcome` is `blocked`, `handoff_required` (Codex: adapter required, nothing spawned), `preflight_failed`, `canceled_before_dispatch` (also when preflight throws after cancellation), `rejected_before_launch`, `already_reserved`, `conflicting_task_payload` or `dispatched`. A dispatched result adds the wrapper's state, kept distinct from queue eligibility: `accepted|executed|verified|unknown|rejected`, plus `reason`, `exitCode`, `durationMs`, `resultCaptured`, `resultPath` and hashes. **Launch attempt versus final answer.** `executorEntered: true` means the executor was called; it is not evidence of output. `launched: false` with outcome `rejected_before_launch` is reported only for the known before-generation failure `rejected` / `private_storage_unavailable` (private output check failed, no provider started); status and reservation are preserved. Real provider failures and unknown outcomes stay conservative attempts and are never relabeled as completion. `executed` and `verified` are provider final-answer states, not proof of artifact integrity.

**Exit 0 requires private capture and readback.** After a captured result the router itself reads the file through the `capturedResult` validation exported by `wrapper.mjs` (request id, content SHA-256, allowlisted fields). Only a file directly inside `data/requests/<UUID>/` is read; other paths and path traversal are rejected. Provider and model must match the request and the response hash must equal the hash the executor returned. Only then is `readbackIntegrityVerified: true` returned and stored. The response and prompt are never included in router output or the ledger. On a capture failure (`captureFailure`, `resultCaptured: false`), a missing or unreadable file, tampering or a mismatched binding, `readbackIntegrityVerified` is `false` with a static `artifactFailure` (`artifact_capture_failed`, `artifact_path_invalid`, `artifact_unreadable_or_invalid`, `artifact_binding_mismatch`), the provider state and reservation are kept, and the CLI exits 2. Readback shows the stored bytes match the recorded hash. It does not prove cryptographic authenticity or that the answer is correct. Nothing is retried and no other provider is tried when capture is uncertain. Exit code 0 only for `executed` or `verified` with verified readback; otherwise 2 (1 for invalid input).

## Ledger, privacy and retention

A durable reservation is created atomically (`data/routing/<UUID>/`) before any launch and is never removed, including after failure, cancellation or unknown outcomes. It holds `reservation.json` (id, canonical task fingerprint, provider, model, quota source, time) and `outcome.json` (state, reason, relative result path, hashes, durations). It holds no prompt, response, raw error, quota or account data; it adds only `readbackIntegrityVerified` and a static `artifactFailure` code. Unknown or uncertain outcomes, including capture or readback failures, keep their reservation and are never retried automatically. The same id with a different payload is rejected; the same id again is blocked in every later invocation. To run a task again, an operator must deliberately create a new UUID after reviewing the earlier outcome.

Captured results and diagnostics stay in the existing `data/requests/<UUID>/` folder, which the wrapper protects with the existing `private-output.ps1` check. This feature adds no permissions. Access to captured results is the owner account's access on that machine. Retention is manual: delete the folders yourself when no longer needed; deleting a routing reservation re-enables resubmission and should be done knowingly.

`dispatchTask` accepts injected `executor`, `preflight`, `runner` and `privacyCheck` for offline tests. The CLI passes none of them and offers no time or bypass options.
