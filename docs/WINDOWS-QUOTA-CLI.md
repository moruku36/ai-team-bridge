# Windows quota CLI collection / Windows 残量取得

`quota-collect-cli.mjs` collects quota metadata once using an **existing installed and signed-in CLI**. It delegates to Win-CodexBar for native Claude, or Antigravity's native JSON `/usage` command. Win-CodexBar is a community Windows application, **not an official Anthropic CLI**. This adapter does not read credential stores, log in, change consent, install software, configure MCP, schedule polling, or update a dashboard/database. No model task is submitted intentionally; AG output must confirm a zero-turn native usage command.

## Prerequisites and one-shot use

- Windows and Node.js 18+; no npm dependencies.
- Existing Win-CodexBar **0.70.0** with existing Claude credential-read consent already enabled, and existing Claude subscription login; or existing `agy` **1.3.5** with its subscription login. Versions are deliberately pinned. Other versions return `unsupported_version` before the usage command. Do not relax the guard without reviewing command behavior and JSON fixtures.
- Run as the same approved Windows user who owns those logins, in the normal authorized execution context. A sandbox/approval rejection is a stop, not a reason to extract credentials or change permissions. Account alignment with a GUI is not established by this tool.
- Pass the reviewed executable's absolute `.exe` path. The tool does not search browser caches, credential files, or private history. A nonstandard installation path works when explicitly supplied; no personal paths belong in the public repo.
- Known API-key/custom-auth environment overrides cause `credential_override_present` by presence only. Values are never printed. Use the already authorized subscription context; this tool does not edit your environment.

PowerShell, if the executable is already on PATH:

```powershell
$codexbar = (Get-Command codexbar-cli.exe -ErrorAction Stop).Source
node quota-collect-cli.mjs claude $codexbar

$agy = (Get-Command agy.exe -ErrorAction Stop).Source
node quota-collect-cli.mjs antigravity $agy
```

If PATH discovery fails, supply your reviewed existing executable path directly. Do not install or authenticate as an automatic fallback. Stdout contains only the allowlisted quota report, but **real percentages and timestamps are still private**. Keep outputs outside the repo or under ignored `data/` in an already private directory. This command does not create private storage or alter ACLs. Never commit, paste into public issues, or attach real quota reports to a PR.

Exact underlying command arguments, shown for review rather than raw-output logging:

```text
codexbar-cli.exe --version
codexbar-cli.exe config claude-code-credentials status --json --no-color
codexbar-cli.exe usage --provider claude --source oauth --json --no-color --no-credits --web-timeout 30

agy.exe --version
agy.exe --print /usage --output-format json --print-timeout 45s --log-file NUL
```

The consent command checks `allowed: true`; no enable/allow command exists in this adapter. Credential use and any refresh internal to the existing provider CLI remain that CLI's behavior. The adapter never exports secrets, opens a browser itself, supplies login flags, or retries. It runs without a shell in the system temp directory; quota output is bounded to 1 MiB per stream and 50 seconds, with 5 seconds for each preflight. Errors suppress raw stdout/stderr and paths. Timeout kills only the owned direct child; descendant cleanup is not guaranteed, so inspect uncertain owned processes before any manual retry. It never terminates unrelated user processes. `--log-file NUL` suppresses the AG log target for this invocation; provider-managed state/history remains outside the adapter's control.

## Metadata and freshness

The output has `status: available|partial|unknown`, `routerAuthorized: false`, UTC `startedAt`/`collectedAt`, separate `providerObservedAt`, `timeBasis`, and fixed pool/window names. A failed attempt has `collectedAt: null`, a separate `attemptFinishedAt`, no pools, and a static error/stage. No cache or last-good fallback is read.

| Provider | Pool scope | Periods | Clock basis |
|---|---|---|---|
| Claude native subscription | `native-all-models` | `five_hour`, `weekly` | Win-CodexBar `usage.updated_at`, separate from collection completion |
| Antigravity | `gemini-shared` | `five_hour`, `weekly` | local CLI collection time; provider observation time remains null |
| Antigravity | `claude-gpt-shared` | `five_hour`, `weekly` | local CLI collection time; provider observation time remains null |

Claude used percentage converts to `100 - used`; AG remaining fraction converts to percent. The windows are 300 and 10080 minutes. Shared pools are not copied into independent model budgets, and Claude native quota never merges with Claude inside AG. Unknown group names, conflicting groups, non-native envelopes or nonzero/missing AG `num_turns` fail closed. A supported CLI may still change its output schema: report unknown rather than guessing.

The maximum age is one hour from the relevant clock. Stale/future Claude observations, unavailable/disabled windows, missing percentages, duplicate periods and missing/invalid/passed resets expose **null current percentage**, never zero or 100 by assumption. Resets must be exact offset-qualified timestamps in the response and within the window's duration plus five minutes. No reset is inferred from a countdown or local calendar. A reset passing means a new observation is required, not confirmed recovery. An already serialized report does not refresh itself: consumers must compare its timestamp and resets with their current clock before display/use.

## Existing collector injection

`createQuotaCollector()` fits `collectSnapshots()` from `quota-snapshots.mjs`. By default a report grants no routing permission. The caller must separately verify the CLI account and applicability of each shared pool, choose an opaque account alias, and explicitly accept local collection time for AG if appropriate:

```js
import {acquireQuota, createQuotaCollector} from '../windows-quota-collector.mjs';
import {collectSnapshots} from '../quota-snapshots.mjs';

const report = await acquireQuota('antigravity', {executable: reviewedAbsoluteExecutable});
const collector = createQuotaCollector(report, {
  accountScope: 'local-subscription', // opaque alias; never an email/account ID
  scopeVerified: true,               // set only after actual operator review
  allowCollectionTime: true          // AG backend timestamp is still unknown
});
const result = await collectSnapshots(collector);
```

The resulting snapshots use `source: supported-export`, explicit provenance and UTC reset zones. Only complete pools with both current exact-reset windows are exported; freshness and reset expiry are checked again at consumption. File import continues to reject supported exports. Existing routing policy must use the same **pool** `modelScope`; do not relabel/copy one pool for every model. Policy review, required windows, reserve checks and dispatch authorization still apply. There is no autonomous routing or production sync in this feature.

## Diagnosis and stopping conditions / 診断

| Static error or condition | Safe next step |
|---|---|
| `executable_not_found` / `absolute_executable_required` | Check the reviewed installed path with `Get-Command`; do not search secret stores. |
| `unsupported_version` | Review `--version` and current upstream documentation; stop before usage on unverified versions. |
| `existing_consent_required` | Existing consent is absent. Stop and report it; enabling consent requires separate authorization. |
| `credential_override_present` | Report the incompatible context by key presence only; do not dump or edit environment values. |
| `cli_failed`, timeout, authentication/network/rate-limit suspected | The adapter intentionally does not echo raw errors. First record stage and exit outcome; inspect only the owning CLI's normal UI/diagnostics privately in the authorized context. Do not publish account output or trigger login/refresh loops. |
| `invalid_output` / unknown group / missing metadata | Treat as unknown. Review the schema using synthetic fixtures; do not substitute an old report. |
| permission/approval denial, cancellation or uncertain completion | Stop. Record the exact rejected action privately; do not switch routes or broaden privileges to bypass it. |

Rollback is to stop invoking the one-shot collector. There is no service, registry entry, scheduled task, credential or authentication setting to undo. Remove any private saved report only under the owner's retention instructions.

## Validation and sources

The exact two command paths above succeeded on an existing Windows login before this reusable adapter was authored. Public validation retains only versions and method, not live percentages, identities, raw output or local paths. The new adapter is verified with synthetic offline tests, including real bounded child-process timeout/output-error tests; it was **not re-run against live quota services** to avoid redundant acquisition. It does not claim a stable provider API or signed binary attestation.

Run `npm test`. Tests do not invoke either real provider. The existing unmerged interactive-terminal usage branch is separate; these files do not overwrite its terminal host or claim that older print-mode behavior was safe.

Primary references: [Win-CodexBar](https://github.com/nesszer/Win-CodexBar), [Antigravity native quotas](https://antigravity.google/docs/cli/commands/usage/), [Antigravity headless mode](https://antigravity.google/docs/cli/headless/), and the local installed CLI version/command results. The pinned versions document the validated installation, not a promise that all future versions share this contract.

日本語要点: 本ツールは本人の既存ログイン・既存同意だけを使う単発取得です。ClaudeはWin-CodexBar経由、AGは確認済み版のネイティブ `/usage` 経由です。取得日時と提供元観測日時を分け、AGの提供元日時は不明のまま扱います。古い値・reset不明・失敗はunknownとし、自動再試行しません。出力は残量メタデータでも私的情報です。公開するのはコード・手順・架空テストだけで、実測残量・認証情報・個人パスを含めません。
