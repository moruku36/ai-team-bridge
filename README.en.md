# ai-team-bridge

A Windows bridge for bounded requests to already installed and authenticated Claude Code and Antigravity CLI. Local final responses can be saved and read back with SHA-256 verification. No npm dependencies are needed.

[日本語](README.md) · [Specification](SPEC.md) · [Safety](SAFETY.md)

## Requirements

- Windows, Node.js 18+, and PowerShell 7.
- Existing subscription login to the provider CLIs. Validated with Claude Code 2.1.287 and Antigravity 1.2.14. Provider limits and terms still apply.
- Standard CLI installation paths under the current user's `%USERPROFILE%`: `.local\bin\claude.exe` and `AppData\Local\agy\bin\agy.exe`.
- An approved normal Windows execution context when a restricted shell cannot reach existing authentication or local services. This project does not change networking or permissions to bypass that restriction.

It does not create credentials, start OAuth, configure a paid API, install providers, or set up a daemon. Models are limited to the inventory-verified `sonnet` and `gemini-3.8-flash-medium`; availability can change. Requested model and observed backend model are recorded separately. Missing backend metadata is `UNKNOWN`.

## Usage

Offline tests do not invoke either provider:

```powershell
node --test test/wrapper.test.mjs test/failure-diagnostics.test.mjs
```

Review a synthetic example, replace its placeholder with a fresh UUID, and save it as a local request. Sending invokes the provider and consumes its normal usage allowance.

```powershell
Copy-Item examples/claude.local.example.json request.json
$request = Get-Content request.json -Raw | ConvertFrom-Json
$request.id = [guid]::NewGuid().ToString()
$request | ConvertTo-Json -Depth 10 | Set-Content request.json -Encoding utf8NoBOM
node wrapper-diagnostics-v2.mjs send request.json
node wrapper-diagnostics-v2.mjs status $request.id
node wrapper-diagnostics-v2.mjs read-result $request.id
```

Use `examples/antigravity.local.example.json` for Antigravity only after reviewing inherited permissions and the task scope. Its supported CLI has no verified per-invocation granular tool allowlist or all-tools-off switch. `plan` and the scope text are instructions, not a hard permission boundary.

`wrapper.mjs` is the core entry; `wrapper-diagnostics-v2.mjs` adds private failure diagnostics with the same interface. Keep an existing request root and its UUID reservations when integrating the exported API. Never resend uncertain work to enable diagnostics.

## Validation and limits

Local short-response capture and hash-checked readback were tested with both providers. Operational validation also confirmed 12 substantive Claude review responses through readback and hash checks. Private review content is excluded. The 32 offline tests cover request validation, duplicate prevention, process handling, capture, and failure diagnostics; they do not replace live provider checks.

Existing Claude cloud-session sends confirm queue acceptance only. Cloud response retrieval and remote completion are unverified. There is no equivalent Antigravity cloud route here, automated quota routing, provider fallback, or continuous worker.

Prompts are limited to 64 KiB UTF-8. Timeouts are 1–600 seconds, default 120. Output is capped at 2 MiB. Cancellation targets the owned child; descendants or remote work can survive. No automatic retry occurs. `accepted` is an acknowledgment, `executed` is a local final answer, `verified` additionally matches a supplied string, and `unknown` does not establish completion. Hash integrity or exact string matching does not establish answer quality.

## Private artifacts

With `captureResult: true`, generation waits for the new request directory's private ACL check. Access is retained for the executing Windows user, SYSTEM, and administrators. Run as the intended human user. A different account or service can create artifacts the intended user cannot access. Check that user's read/delete access in the actual deployment context; do not widen sandbox permissions silently.

Responses and diagnostics remain in `data/requests/` until explicitly removed. There is no automatic retention or cleanup policy. Diagnostic redaction is pattern-based and imperfect: keep those files private. See [SAFETY.md](SAFETY.md).

Only source, synthetic examples/tests, documentation, and manifests are published. No runtime requests/results, authentication records, personal quotas, real session URLs, private notes, or owner-specific absolute paths are included. No license grant is added; public visibility does not imply MIT or another license.
