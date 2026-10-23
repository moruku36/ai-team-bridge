# Interface and limitations

See [README.md](README.md) for an overview and [SAFETY.md](SAFETY.md) for the security model.

## Request fields

| Field | Required | Values |
|---|---|---|
| `id` | yes | UUID (version 1–5). Reserved permanently on first send. |
| `provider` | yes | `claude` or `antigravity`. |
| `prompt` | yes | Nonempty UTF-8 text, at most 64 KiB, without NUL. |
| `route` | no | `local` (default) or `cloud` (Claude only). |
| `model` | no | `sonnet` for Claude, `gemini-3.8-flash-medium` for Antigravity. No other model is accepted. |
| `timeoutSeconds` | no | Integer 1–600, default 120. |
| `captureResult` | no | Boolean. Local route only. Stores the answer in a private folder. |
| `expectResponse` | no | String compared with the trimmed answer. Not allowed on the cloud route. |
| `session` | cloud only | Exact existing `https://claude.ai/code/session_…` or `cse_…` URL. |
| `remoteScope` | cloud only | `{reviewed: true, description}` describing the reviewed per-task scope. |
| `taskScope` | Antigravity only | `{reviewed: true, acceptInheritedPermissions: true, acknowledgeInstructionScope: true, mode: "plan" \| "accept-edits", description}`. |

Any other field is rejected. Arbitrary tools and flags are never accepted.

## Execution

- Prompts travel on stdin. Processes are launched from argument arrays without a shell.
- Existing subscription authentication is checked with read-only CLI commands. No credentials are created.
- An atomic UUID reservation prevents duplicate submissions, even after a failure. Keep the same request root and UUID, and do not resubmit pending work to enable diagnostics.
- Output is limited to 2 MiB. On timeout the bridge stops the child process it owns, with a 1.5-second grace period. Descendants or remote work may survive, and cancellation does not establish rollback or completion.

## States and exit codes

| State | Meaning |
|---|---|
| `accepted` | Cloud acknowledgment only. |
| `executed` | A local final answer. |
| `verified` | A local final answer that also matches `expectResponse`. |
| `unknown` | Timeout, cancellation, partial or malformed output, or the output limit. |
| `rejected` | A provider error, or private storage was unavailable. |

Exit codes: `0` for recognized success or acknowledgment, `2` for `unknown`, `rejected`, or a capture failure, and `1` for validation or preflight failure.

Logs keep allowlisted metadata only, never prompts or response bodies. The private `result.json` stores a response hash, and `read-result` checks that hash before returning the response.

## Diagnostics v2

Diagnostics keep an allowlisted provider error envelope and pattern-redacted stderr, and only after the core privacy check has passed for a local `captureResult` request. A provider `is_error` never becomes a completion.

Limits: 16 error entries, 4096 characters per message, and 8192 sanitized stderr characters. Common credentials, authorization headers, emails, URLs, and identifiers are redacted. Pattern redaction is imperfect, so diagnostics remain private and must not be published.

## Integrity and scope

[`SOURCE-MANIFEST.json`](SOURCE-MANIFEST.json) records SHA-256 hashes of the tracked files, and `npm run manifest:check` verifies them. [`diagnostics-v2-manifest.json`](diagnostics-v2-manifest.json) preserves the hashes of the production core and diagnostic sources as validated for v2.1.0.

Tests contain synthetic inputs only, and neither packaging nor the offline tests run live agent work. Success of local transport and readback does not establish the outcome of every long review or of remote cloud work.
