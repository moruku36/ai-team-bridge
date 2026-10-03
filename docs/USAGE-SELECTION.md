# Reviewed usage observations to queue dry runs

This is an advisory bridge to the existing queue/policy checks. It has no executor or execute command. Collection still needs the connected terminal host and previously trusted empty folder; the selector runs in ordinary Node on reviewed local JSON. CodexBar/Codex normalization is unsupported.

| Path | Required evidence | Output |
|---|---|---|
| Strict export preview | Reviewed mapping, fresh known required-window percentages, exact resets with matching timezone | Preview for separate review and unchanged strict router dry run |
| Advisory selection | Reviewed mapping, fresh known required-window percentages; unknown backend/reset explicitly allowed | Selected-for-review only, no dispatch or deadline ordering |
| Dispatch on unknown reset | Unsupported | Strict live conditions unchanged |

The existing router already uses observedAt, without requiring backend fetchedAt. Unknown backendAt need not make all observations useless. The explicit unknownBackend policy accepts observed freshness for review while disclosing unknown upstream freshness; it cannot prove uncached provider data. Use require-backend-time to reject that uncertainty.

Observation age, backend age and resets stay separate. The policy permits at most 120 seconds of observation age and may only lower it. A known stale backend timestamp, future observation, last-known display, rate limit, incomplete window, inconsistent percentage, conflict or unknown category blocks selection.

Exact resets, known timezone and rounded relative minutes are retained separately. No omitted date/year/zone is filled from the clock. Unknown or relative resets do not supply deadline priority or assumed replenishment. Result expiry means observation expiry, not provider reset. Known expired resets and resets before estimated completion still block.

## Use it now

1. Collect with collectConnectedUsage() as described in [official usage](OFFICIAL-USAGE.md). Preserve only its allowlisted result.
2. Review actual account/model-to-shared-pool applicability. Copy [selection policy](../examples/usage-selection-policy.example.json) and [routing policy](../examples/usage-routing-policy.example.json) into private files and review aliases, estimates and reserves. Wrap observations as {"schema":1,"reviewed":true,"observations":[...]}. Review flags are operator assertions, not account discovery.
3. Run the existing scoped queue through the dry run:

    node usage-selection-cli.mjs dry-run --observations reviewed-observations.json --queue reviewed-queue.json --routing-policy reviewed-routing-policy.json --selection-policy reviewed-selection-policy.json

This uses the actual clock and never refreshes, resends or dispatches. Stale/rate-limited observations remain blocked. The synthetic demonstration alone uses a fixture clock:

    node usage-selection-cli.mjs dry-run --observations examples/usage-observations.example.json --queue examples/usage-queue.example.json --routing-policy examples/usage-routing-policy.example.json --selection-policy examples/usage-selection-policy.example.json --now 2031-04-02T12:00:00Z

It selects one AGY task and one Claude task for review, with execution booleans false. Never backdate real evidence to make it pass.

## Gates and shared pools

The selector reuses the unchanged router with empty snapshots for task/classification/approval/role/size/wrapper checks. Only the exact no_snapshot enum is removed for advisory selection; every other reason survives. Required-window estimates are separately checked because empty-snapshot evaluation cannot check them.

Native Claude maps only to native-all-models with fixed Sonnet. AGY Gemini Medium maps only to gemini-shared, without copying its Claude/GPT budget or merging native Claude. Duplicate observations conflict instead of choosing a convenient latest record.

Queue and permitted policy order are retained. The new example puts AGY first and uses its actual five-hour/weekly windows; that is an example choice, not an always rule or a change to the old policy. The example adds one percentage point of rounding margin to existing reserves. Batch estimates are keyed by shared provider/account/pool/window; they are neither global locks nor predicted future capacity.

Provider-specific scope remains required: Claude disallows taskScope; AGY requires reviewed plan scope. The example uses separate scoped tasks, without relaxing wrappers or role ceilings.

Every frozen advisory result is schema 2, tagged advisory-selection, with executePermitted:false and dispatchAuthorized:false. It contains no strict snapshot and the existing snapshot boundary rejects it. A candidate is not an accepted or completed job.

## Exact-reset preview

    node usage-selection-cli.mjs export-strict-preview --provider claude --observations reviewed-observations.json --routing-policy reviewed-routing-policy.json --selection-policy reviewed-selection-policy.json

This refuses any rejected source record, non-exact required reset or routing age ceiling larger than the reviewed observation age. Exact evidence calls unchanged normalizeSnapshot(), with manual review assertion and unknown backend freshness disclosed separately. The schema-2 outer preview is not a snapshot. Its inner snapshot needs separate review before the existing strict router rechecks actual-time freshness, reset boundaries, reserves, approvals and scope.

This is practical queue triage, not complete automatic quota-to-routing. Collection needs the connected host, scope/evidence review remains manual, and unsupported CodexBar/Codex data is never silently imported.
