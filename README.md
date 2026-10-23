# ai-team-bridge

[English](README.md) · [日本語](README.ja.md) · [Specification](SPEC.md) · [Safety](SAFETY.md) · [Quota routing](docs/QUOTA-ROUTING.md) · [Windows quota CLI](docs/WINDOWS-QUOTA-CLI.md)

A small Windows command-line bridge that sends bounded, reviewed requests to **Claude Code** and **Antigravity CLI**, stores the answer privately on disk, and checks the stored answer against its hash when you read it back. It uses Node.js built-ins only and has no npm dependencies.

## Why this exists

The owner's public [multi-ai-workflow](https://github.com/moruku36/multi-ai-workflow) design uses an orchestration environment centered on Dottie and Codex, and hands selected work to Claude Code and Antigravity/Gemini. Copying prompts and replies between those tools by hand was slow and error-prone. This bridge replaces that copy-and-paste step with a local, auditable transport. The multi-ai-workflow repository is background on the architecture only. This project does not depend on it.

## Where it fits in the workflow

multi-ai-workflow calls for bounded assignments, independent review, and verification before integration, with Windows as the main local base:

- **Dottie** is the PM and orchestrator.
- **Claude** drafts or implements assigned work.
- **Antigravity/Gemini** handles selected work.
- **Codex** coordinates or verifies independently, depending on the workflow.

Task routing decides *who* works. Execution controls decide *what they may do*. This bridge only moves requests and results locally. It does not assign roles, does not grant or widen any agent's permissions, and does not enforce the organization's role split.

## Architecture

![Component overview](docs/diagrams/architecture.svg)

| Component | Role |
|---|---|
| `wrapper.mjs` | Core entry point. Validates a request, runs read-only login checks, reserves the UUID, launches the provider CLI with the prompt on stdin (no shell), and records the outcome. |
| `wrapper-diagnostics-v2.mjs` | The same commands as the core, plus private, redacted failure diagnostics for captured local requests. |
| `failure-diagnostics.mjs` | Allowlists provider error fields and redacts common secret patterns from stderr. |
| `private-output.ps1` | Restricts a new request folder to the current user, SYSTEM, and Administrators before any generation. |
| `task-router.mjs`, `router-cli.mjs` | Quota-aware routing: a pure dry run over an explicit queue, and an explicit single-task `execute`. |
| `quota-snapshots.mjs` | Strict validation and pooling of quota snapshots. |
| `windows-quota-collector.mjs`, `quota-collect-cli.mjs` | One-shot quota metadata collection through already installed, signed-in CLIs. |

### Request lifecycle

![send / read-result sequence](docs/diagrams/send-sequence.svg)

![Request states](docs/diagrams/request-states.svg)

The diagrams are rendered from Mermaid sources in [`docs/diagrams/`](docs/diagrams/) with [Pele](https://pele.run/).

## Requirements

- Windows, PowerShell 7, and Node.js **22.23.2 or later** (pinned in [`.nvmrc`](.nvmrc) and `package.json` `engines`).
- Provider CLIs already signed in with a subscription. Validated with Claude Code 2.1.287 and Antigravity 1.2.14. The provider's terms and usage limits still apply.
- The standard per-user install paths under `%USERPROFILE%`: `.local\bin\claude.exe` and `AppData\Local\agy\bin\agy.exe`. Other locations are not searched.
- A normal, approved Windows session. If a restricted shell cannot reach the existing login or local services, use an approved context instead. This project never changes networking or permissions to get around a restriction.

The bridge does not create credentials, start OAuth, configure a paid API, install providers, or run a background service. Only the inventory-verified models are accepted: `sonnet` for Claude and `gemini-3.8-flash-medium` for Antigravity. Their availability can change. The requested model and the model the provider reports are recorded separately, and a missing report is recorded as `UNKNOWN`.

## Quick start

Run the offline test suite. It never calls a provider and needs no installation:

```powershell
npm test
```

The examples are synthetic. Review the content and scope, replace the placeholder with a fresh UUID, and save the result as a local request. **Sending calls the real provider and uses your normal allowance.** A UUID can never be sent twice, even after a failure or a timeout.

```powershell
Copy-Item examples/claude.local.example.json request.json
$request = Get-Content request.json -Raw | ConvertFrom-Json
$request.id = [guid]::NewGuid().ToString()
$request | ConvertTo-Json -Depth 10 | Set-Content request.json -Encoding utf8NoBOM
node wrapper-diagnostics-v2.mjs send request.json
node wrapper-diagnostics-v2.mjs status $request.id
node wrapper-diagnostics-v2.mjs read-result $request.id
```

`request*.json` and `data/` are git-ignored, so local requests and results are not committed by accident.

Use `examples/antigravity.local.example.json` only after you have reviewed the permissions Antigravity inherits and the real task scope, and set the `taskScope` acknowledgments only then. The supported CLI has no verified per-call tool allowlist and no switch that turns all tools off, so `plan` mode and the scope text are instructions to the model, not an enforced permission boundary.

Both `wrapper.mjs` and `wrapper-diagnostics-v2.mjs` accept the same request format and the same `send` / `status` / `read-result` commands. When you build on the exported API, keep the existing request root and its UUID reservations. Never resend uncertain work just to turn on diagnostics.

## Quota collection and routing

- [Windows quota CLI](docs/WINDOWS-QUOTA-CLI.md): `quota-collect-cli.mjs` reads quota metadata once through existing Win-CodexBar 0.70.0 or Antigravity 1.3.5 installs. Its output is private, and it grants no routing permission by itself.
- [Quota routing](docs/QUOTA-ROUTING.md): `router-cli.mjs dry-run` evaluates an explicit queue against reviewed snapshots and policy without launching anything. `router-cli.mjs execute` runs exactly one named, eligible task and only with `--confirm-execute`. There is no autonomous routing, no provider fallback, and no background worker.

## Results and exit codes

| State | Meaning |
|---|---|
| `accepted` | A cloud session acknowledged the message. This is not a reply. |
| `executed` | The local provider returned a final answer. |
| `verified` | As `executed`, and the answer also matched `expectResponse`. |
| `unknown` | Completion could not be confirmed: timeout, cancellation, partial or malformed output, or the output limit. |
| `rejected` | The provider reported an error, or private storage could not be prepared. |

Exit codes: `0` for a recognized success or acknowledgment, `2` for `unknown`, `rejected`, or a capture failure, and `1` for validation or preflight failures. A string or hash match does not prove the answer is correct.

## Limits

- Prompts: up to 64 KiB of UTF-8. Timeout: 1–600 seconds, default 120. Output: up to 2 MiB.
- One UUID per request, with no automatic retry. Cancellation stops only the child process the bridge started. Its descendants or remote work may keep running.
- Local transport was verified with both providers (capture, hash check, readback), and 12 substantive Claude review responses were verified through readback. Those requests and responses are not published.
- For existing Claude cloud sessions, only queue receipt is confirmed. Cloud replies and remote completion are not verified, and there is no Antigravity cloud route. See [Cloud readback investigation](docs/CLOUD-READBACK.md).

## Private artifacts

With `captureResult: true`, generation starts only after the ACL check on the new request folder succeeds. Access is kept for the executing Windows user, SYSTEM, and Administrators. Run as the intended user: a different account or a service can create files that user cannot read. Confirm that user can read and delete the files in the real deployment, and do not quietly widen sandbox permissions.

Captured output is private. Responses and diagnostics stay in `data/requests/` until you delete them. Nothing expires or is deleted automatically. Diagnostic redaction is pattern-based and imperfect, so never publish diagnostic files. See [SAFETY.md](SAFETY.md) and [SPEC.md](SPEC.md).

## Development

- `npm test` runs every offline test under `test/`.
- `npm run manifest:check` confirms that [`SOURCE-MANIFEST.json`](SOURCE-MANIFEST.json) matches the tracked files. After an intentional change, run `npm run manifest:update` and commit the result.
- [`.gitattributes`](.gitattributes) keeps LF line endings on every platform, so hashes are the same on Windows checkouts and in CI.
- GitHub Actions runs the tests and the manifest check on Windows for every push and pull request.

## Public content

This repository contains only source code, synthetic examples, tests, and documentation. It contains no real requests or responses, credentials, quota or account records, real session URLs, or personal absolute paths. No license is granted: the repository being public does not mean it is under MIT or any other license.
