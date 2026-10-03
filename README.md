# ai-team-bridge

[English](README.md) · [日本語](README.ja.md) · [Specification](SPEC.md) · [Safety](SAFETY.md)

## Why this exists

The owner's public [multi-ai-workflow](https://github.com/moruku36/multi-ai-workflow) design uses a Dottie/Codex-centered orchestration environment, with selected work offloaded to Claude Code and Antigravity/Gemini. Copying prompts and replies between tools by hand was cumbersome.

This bridge is a small Windows tool that sends bounded, reviewed requests to Claude Code and Antigravity CLI, captures local responses, and verifies them on readback. It uses Node.js built-ins only. The linked multi-ai-workflow repository is architectural context only.

## Where it fits in the workflow

multi-ai-workflow describes bounded assignment, independent review, and verification before integration. Windows is the primary local base. In that design:

- Dottie is the PM/orchestrator.
- Claude drafts or implements assigned work.
- Antigravity/Gemini handles selected work.
- Codex coordinates or independently verifies, according to the selected workflow.

Task routing assigns who works; execution controls determine which actions are allowed. This bridge is a local transport and result-handoff component of that design. The optional bounded router enforces reviewed quota snapshots and task policy; it does not determine or expand roles or agent permissions.

## Requirements

- Windows, Node.js 18+, and PowerShell 7.
- Existing subscription login to the provider CLIs. Validated with Claude Code 2.1.287 and Antigravity 1.2.14. Provider terms and limits still apply.
- Standard CLI installation paths under the current user's `%USERPROFILE%`: `.local\bin\claude.exe` and `AppData\Local\agy\bin\agy.exe`. Other locations are not discovered automatically.
- A normal, approval-reviewed Windows execution context when a restricted shell cannot reach existing authentication or local services. This project does not change networking or permissions to bypass such a restriction.

It does not create credentials, start OAuth, configure a paid API, install providers, or set up a daemon. Models are limited to the inventory-verified `sonnet` and `gemini-3.8-flash-medium`; availability can change. The requested model and the observed backend model are recorded separately, and missing backend metadata is `UNKNOWN`.

## Usage

Offline tests do not invoke either provider and need no dependency installation:

```powershell
node --test test/wrapper.test.mjs test/failure-diagnostics.test.mjs
```

The examples are synthetic. Review the content and scope, replace the placeholder with a fresh UUID, and save it as a local request. Sending invokes the provider and consumes its normal usage allowance. A UUID cannot be resent, even after a failure or timeout.

```powershell
Copy-Item examples/claude.local.example.json request.json
$request = Get-Content request.json -Raw | ConvertFrom-Json
$request.id = [guid]::NewGuid().ToString()
$request | ConvertTo-Json -Depth 10 | Set-Content request.json -Encoding utf8NoBOM
node wrapper-diagnostics-v2.mjs send request.json
node wrapper-diagnostics-v2.mjs status $request.id
node wrapper-diagnostics-v2.mjs read-result $request.id
```

Use `examples/antigravity.local.example.json` for Antigravity only after reviewing inherited permissions and the actual task scope; set the `taskScope` acknowledgments only then. The supported CLI has no verified per-invocation granular tool allowlist or all-tools-off switch, so `plan` and the scope text are instructions, not a hard permission boundary.

`wrapper.mjs` is the core entry; `wrapper-diagnostics-v2.mjs` adds private failure diagnostics. Both use the same request format and the same `send` / `status` / `read-result` commands. Keep an existing request root and its UUID reservations when integrating the exported API, and never resend uncertain work just to enable diagnostics.

## Validation and limits

- Local paths and short responses were verified with both providers: capture, hash check, and readback.
- 12 substantive Claude review responses were verified through readback and hash checks. The requests and responses are not published.
- 133 offline tests cover request validation, duplicate prevention, process handling, result retention, and diagnostic suppression and redaction. They do not replace live provider checks.

For existing Claude cloud sessions, only queue receipt is confirmed. Receipt is not reply retrieval; cloud replies and remote completion remain unverified. There is no equivalent Antigravity cloud route. Bounded routing from reviewed normalized snapshots is implemented; automatic complete quota-to-routing, provider fallback and a continuous worker are not implemented.

Prompts are limited to 64 KiB of UTF-8. Timeouts are 1–600 seconds, default 120. Output is capped at 2 MiB. A UUID is reserved per request and there is no automatic retry. Cancellation targets only the owned child process; descendants or remote work may survive. `accepted` is an acknowledgment, `executed` is a local final answer, `verified` additionally matches a supplied string, and `unknown` does not establish completion. String or hash matching is not semantic accuracy.

## Private artifacts

With `captureResult: true`, generation starts only after the ACL check on the new request directory succeeds. Access is retained for the executing Windows user, SYSTEM, and administrators. Run as the intended user: a different account or service can create artifacts that user cannot read. Confirm that user's read and delete access in the actual deployment context, and do not widen sandbox permissions silently.

Captured output is private. Responses and diagnostics stay in `data/requests/` until explicitly removed; there is no automatic expiry or deletion. Diagnostic pattern redaction is imperfect, so never publish diagnostic files. See [SAFETY.md](SAFETY.md) and [SPEC.md](SPEC.md).

## Public content

This repository contains only source, synthetic examples, tests, and documentation. It contains no real requests or responses, credentials, quota or account records, real session URLs, or personal absolute paths. No license is granted; public visibility does not imply MIT or any other license.

## On-demand usage and routing

See [official usage collection](docs/OFFICIAL-USAGE.md) for the bundled connected-terminal host, empty trusted workspace requirements, output redaction and bounded cleanup. AGY paging/exit passed live; Claude host lifecycle now passed live with graceful verified exit; its rate-limited quota display remained unknown. Missing freshness or exact resets remain unknown. [Quota routing](docs/QUOTA-ROUTING.md) accepts separately reviewed normalized snapshots; collection alone never authorizes dispatch. Run the full synthetic suite with `node --test`.

## Reviewed observation selection

[Usage-to-queue dry runs](docs/USAGE-SELECTION.md) select review candidates from recent reviewed known percentages while preserving unknown backend/reset evidence. No inferred deadline or execution permission is produced. Collection needs the connected host; the selector CLI runs on reviewed local JSON. CodexBar/Codex normalization is unsupported.
