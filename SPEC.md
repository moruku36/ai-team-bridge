# Interface and limitations
Request fields: id (UUID), provider (claude or antigravity), prompt, route (local default or explicit Claude cloud), model (sonnet or gemini-3.8-flash-medium), timeoutSeconds (1..600, default 120), captureResult, optional expectResponse. Cloud additionally requires an existing session and reviewed remoteScope. Antigravity requires reviewed taskScope with acceptInheritedPermissions, acknowledgeInstructionScope, mode (plan or accept-edits), and bounded description.

Prompts travel on stdin; process launch uses argument arrays without a shell. Existing subscription authentication is checked without creating credentials. Atomic UUID reservations prevent duplicate submissions even after failure. Preserve the same request root and UUID; do not resubmit pending work to enable diagnostics.

accepted means cloud acknowledgment only; executed means a local final answer; verified additionally matches the expected answer. unknown includes timeout, cancellation, partial/malformed output and output limits; rejected includes provider errors. Exit codes are 0 for recognized success/acknowledgment, 2 for unknown/rejected/capture failure, 1 for validation/preflight failure. Logs retain allowlisted metadata, not prompts or response bodies.

Output is limited to 2 MiB. Timeout cancellation targets the owned child, with bounded 1.5-second grace. Descendants or remote work may survive; cancellation does not establish rollback/completion. Private result.json stores a response hash; read-result checks that hash before returning the response.

Diagnostic v2 retains allowlisted provider error envelopes and pattern-redacted stderr only after the core privacy check passes for local captureResult requests. It never turns provider is_error into completion. Limits: 16 error entries, 4096 characters per message, 8192 sanitized stderr characters. Common credentials, authorization headers, emails, URLs and identifiers are redacted; pattern redaction is imperfect, so diagnostics remain private and must not be published.

This archive preserves the final production core and diagnostic source hashes. Tests contain synthetic inputs only. Local transport/readback success does not establish every long review or remote cloud outcome. No live agent work is run by packaging or offline tests.
