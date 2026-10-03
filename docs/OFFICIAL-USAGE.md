# On-demand official usage collection

This feature collects an observation through the already connected Windows terminal. It does not install a daemon, access credential files, accept workspace trust, log in, enable credits, send a model prompt, or contact an undocumented endpoint. It does not authorize routing from an incomplete observation.

## Supported host integration

The bundled `connected-terminal-host.mjs` exports `collectConnectedUsage()`. Supply the already connected terminal's `exec` and `exchange` capabilities (supported `exec_command` and `write_stdin` argument/result shapes), the absolute source checkout path, and a separate empty directory previously approved and trusted by the provider. Both scope acknowledgments must be true. This module has no Node imports or external endpoints and does not install a PTY library. The terminal remains a host capability; running `usage-cli.mjs` alone does not supply it.

```js
import {collectConnectedUsage} from './connected-terminal-host.mjs';
const observation = await collectConnectedUsage('antigravity', {
  terminal: {exec: connectedTerminal.exec, exchange: connectedTerminal.exchange},
  workspace: previouslyTrustedEmptyDirectory,
  sourceDirectory: sourceCheckout,
  confirmDisplayOnly: true,
  confirmPreviouslyTrustedWorkspace: true,
  signal,
  onProgress: ({provider, stage}) => showProgress(provider, stage)
});
```

Terminal methods must support bounded reads and normal approval-reviewed execution. The host checks the empty non-reparse workspace, reuses the existing subscription guard, starts the protocol with raw input echo disabled, validates every action, rebuilds an output allowlist, and closes only session IDs it created. Split frames are polled without resending input. Never log terminal method results; persist only the returned observation and static progress events. Base64 framing itself is not redaction.

Start `node usage-terminal.mjs --provider claude` (or `antigravity`) with stdin kept open. Its action frames are short base64 lines between `USAGE_ACTION_BEGIN` and `USAGE_ACTION_END`; use `decodeAction()` to decode them. Frames carry allowlisted actions/observations, never raw provider output.

The host starts only its own new provider session, in the separately approved workspace, with these fixed arguments:

- Claude: `--safe-mode --tools "" --strict-mcp-config --model sonnet --ax-screen-reader`
- Antigravity: `--model gemini-3.8-flash-medium --mode plan --sandbox`

Send each terminal output chunk to the protocol's stdin as one JSON line `{output, exited}`. Never echo or save the raw chunk: a provider's header may contain account data. Follow `read`, `write`, `exit-own-session`, or `close-own-session` only for the session ID created for this invocation. The protocol sends `/usage` once; for a paginated AGY panel it sends bounded Page Down operations. On completion it requests Escape then `/exit`. Trust/login prompts, cancellation, an exited CLI, a 2MiB input limit, 20 replies, or 90 seconds stop collection. The protocol has its own timeout; the bundled host also enforces the collection bound and attempts bounded cleanup only on its owned CLI in a `finally` block, including protocol EOF or malformed frames. Cleanup is additional to the collection deadline and depends on bounded terminal calls. Claude startup has one settle read before the single usage command. On abnormal paths its cleanup tries Escape then `/exit`, bounded reads and two Ctrl-C attempts. As a last resort, a normal approval-reviewed stop is scoped to a nonce-marked owned launcher, its recorded PID/start time, and exactly one child with the expected executable and complete fixed command. Parent and child identity are checked again immediately before stopping. Both child disappearance and the owned terminal exit must be confirmed. Missing/ambiguous ownership, denied stop or missing exit remains `cleanup_unconfirmed`; measurements are discarded. A forced stop never turns an incomplete run into an accepted observation. AGY launch and cleanup are unchanged. The caller must still review only its recorded sessions if cleanup remains unconfirmed. Cancellation of a model/resource operation is outside this display-only protocol.

`collectOfficialUsage()` is a library adapter accepting a reviewed terminal `runner`. It fails with `terminal_driver_required` when no runner is supplied; `usage-cli.mjs` therefore fails closed without a host adapter. It never sends `/usage` through `-p`/print mode. Existing provider-owned logs and local CLI history are outside this feature's control; it does not read them.

## Observation schema

`parseUsage()` reconstructs cursor-based output in memory and returns only:

- Provider, source, local observation start/end UTC timestamps, and a separate `backendAt` (normally unknown). The observation clock is not a provider fetch timestamp.
- Shared pools with model members and windows. Native Claude's all-model group stays one pool; AGY Gemini Flash/Pro stay one pool and AGY Claude/GPT stay another. No budget copies are created per member model, and no native-Claude/AGY budget is merged.
- `remainingPercent` plus `quantitySource: {kind, value, operation}`. A displayed used rate converts by `100-minus-used`, with its original value retained; a remaining rate uses identity. Missing, malformed, out-of-range or unavailable data stays `null`, never zero/unlimited.
- A reset classified as `absolute`, `relative-rounded`, `time-only`, `calendar-without-year`, `available-without-reset` or `unknown`. Original accepted clock display and known timezone remain distinct from an exact reset. A rounded countdown never becomes an invented instant; omitted dates/years/zones are not filled from the machine clock.
- Last-known display and rate-limit flags, missing-window/pool flags and static blockers. A per-model breakdown failure does not erase an otherwise readable aggregate bar, but its failure stays visible. An unparsed bar remains unknown.

The automatic result always has `routerAuthorized: false`. To route, an operator must separately review account/model-to-pool applicability, freshness and exact required reset instants, then use the existing strict normalized snapshot boundary. There is no automatic complete snapshot exporter in this feature. A shared pool must not be duplicated under different models; the existing router permits only one fixed model per provider. General multi-model routing still requires shared reservation support before expansion.

## Ordinary distribution and old observations

The sample policy has no temporary provider preference. A user-specified historical preference expiry is an ordering rule only and never replaces a provider reset. A user report that a quota reset occurred is a separate report, not a new measured percentage; observations from before it cannot establish current capacity. Installed older CLI help without a supported quota export is reported as unsupported, with no credential access or invented subcommand.

## Verification

Offline tests use synthetic console screens and dates. Windows live collection was exercised through the connected supported PTY with existing authentication/trust. The bundled host recovered AGY shared groups across pages with one usage command, one page command, zero model prompts, and verified owned process exits. An earlier Claude attempt failed exit verification and was discarded. Following a Claude-authored fix and independent AGY review, one Claude live usage run reached its panel and gracefully exited, confirming owned provider, protocol and preflight exits with no forced stop. The panel showed rate-limit/model-breakdown failure and no usable percentage; those values stayed unknown. The strict last-resort stop is covered synthetically and was not needed in this live run. Actual percentages, account data, request/session IDs, local workspace paths and raw terminal bytes are excluded from public artifacts. Live capture proves this installed display path, not stable provider APIs or complete routing authorization. `USAGE-VALIDATION.json` records only the validation scope.

Primary sources: [Claude usage](https://code.claude.com/docs/en/costs), [Claude CLI](https://code.claude.com/docs/en/cli-reference), [AGY quotas](https://www.antigravity.google/docs/cli/commands/usage), [AGY CLI](https://www.antigravity.google/docs/cli/reference/).

## Codex and CodexBar

Installed Codex CLI 0.30.0 help exposes no supported quota export. Do not invent a subcommand or read credential stores. Existing visible CodexBar UI can be read through Windows UI Automation, scoped to the app’s process/window subtree, without invoking its credential-backed collector. This is a separate manually reviewed UI observation: it may round percentages, provide only countdown resets and omit backend freshness. A missing active session is unknown capacity, not 100% remaining. No CodexBar cache/export collector is bundled and no UI value authorizes routing automatically.
