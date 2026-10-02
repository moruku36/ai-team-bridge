# Safety and limitations / 安全性と制約

This bridge adds validation and bookkeeping around provider CLIs. It is not a complete isolation system. 本ブリッジは完全な隔離環境を提供しません。

- Claude local calls use the supported empty tool list, safe mode, strict MCP configuration and nonpersistent session flags. Existing cloud sessions retain their existing permissions; cloud task scope must be explicitly reviewed.
- Antigravity uses its supported sandbox and mode flags. Its sandbox inherits permissions and may contain unsandboxed rules. Scope text does not remove those permissions. Review the task and existing configuration before acknowledging `taskScope`; never treat a plan instruction as tool denial.
- Every request receives a fresh scratch directory, but this does not prove the provider cannot access other paths. Respect the enclosing Windows approval and sandbox policy. Do not broaden it silently.
- `captureResult: true` invokes `private-output.ps1` on a newly reserved request directory only. This intentionally changes that directory's ACL. It retains the current process user's access, SYSTEM and administrators, and disables inherited entries. Run as the intended user and confirm their access. A storage-check failure prevents generation. Packaging and tests do not invoke this ACL helper.
- Without capture, a successful answer can be returned on stdout. Redirecting stdout or request files into a shared folder can expose content. Request files themselves are not made private by this wrapper.
- Captured response text is deliberately unredacted and private. Metadata journals exclude response/prompt bodies. Diagnostic v2 stores an allowlisted error envelope and pattern-redacted stderr, not raw stdout/stderr or arbitrary fields. Error messages may still contain sensitive text the patterns miss, including paths or task excerpts. Never publish runtime diagnostics.
- Diagnostic limits: 16 error entries, 4096 characters per message, 8192 stderr characters. Runtime storage has no automatic expiry, deletion or rotation. Set retention manually according to the task and authorized access; this project adds no background cleanup.
- SHA-256 detects content mismatch relative to the recorded hash. Both content and its stored hash could be modified by an authorized writer. This is not a digital signature or protection against a malicious administrator.
- UUID reservation prevents duplicate sends only in the same request root. Different roots or UUIDs can submit duplicate work. Preserve existing roots/IDs; never retry unknown work automatically.
- Timeout/interrupt affects only the owned child process. Descendants and cloud work may remain active. `unknown` is not a rollback guarantee or permission to resubmit. Cancellation does not terminate unrelated user processes.
- Subscription checks reject known API-key/custom-provider environment settings, but do not prove provider billing policy or an unlimited allowance. No automatic quota routing, spending control, fallback, credential creation or OAuth is implemented.
- Authentication output, process stderr and provider fields are suppressed in normal CLI errors. Diagnostics remain private. When extending the bridge, do not print raw authentication status, tokens or account details.

日本語: 依頼範囲・継承権限を確認し、本人のWindowsユーザーで実行してください。回答と診断は公開せず、必要な保存期間が過ぎたら明示的に削除してください。タイムアウト後の処理継続や別ルートからの二重送信に注意し、不明な状態を自動再送しないでください。認証・ネットワーク・アカウント設定を回避目的で変更しないでください。
