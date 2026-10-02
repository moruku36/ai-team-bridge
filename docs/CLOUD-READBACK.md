# Cloud readback investigation

Status: **UNVERIFIED**. This page records what was observed; no remote scraping or cloud readback is implemented.

## Observed capabilities

- Claude Code 2.1.287 help lists `-p --cloud <existing-id-or-url>`, which queues a message to an existing cloud session and exits.
- Per <https://code.claude.com/docs/en/claude-code-on-the-web>, the `--cloud` follow-up prints JSON containing only `{ok, session_id, url}`, which is an acknowledgment and not the session's answer.
- `--teleport` resumes a cloud session locally. It checks the same repository and account, fetches and checks out the branch, and loads the conversation. This is an interactive resume, not a passive getter.
- `agents --json/--all` and `logs ID` apply to local background agents. They are not documented as a cloud session read API.
- <https://code.claude.com/docs/en/self-hosted-environments-testing> documents Stop-hook reply-file capture, but only on owned self-hosted TEST runners. No hook, service or runner is installed or authorized by this project.

## Conclusion

No supported passive headless method was verified for reading answers of an existing Anthropic-hosted session. Therefore:

- Cloud readback stays unverified and the cloud acknowledgment in `wrapper.mjs` remains an acknowledgment only.
- The existing local result capture (`captureResult` with `status` / `read-result`) remains the fallback.
- The router only dispatches local text-only requests; it never uses the cloud route.
- This project does not invoke existing cloud sessions, resend old instructions, create resources, list private cloud history or change hooks.

Re-check the primary sources above before relying on any of this; CLI behavior may change between versions.
