# ai-team-bridge

Windows上のClaude CodeとAntigravity CLIに、範囲を確認した依頼を送り、ローカル回答を保存・読み戻す小さなブリッジです。Node.jsの組み込み機能だけを使います。

A small Windows bridge that sends explicitly scoped requests to Claude Code and Antigravity CLI, captures local responses, and checks their hashes on readback. It uses Node.js built-ins only.

[English instructions](README.en.md) · [Interface specification](SPEC.md) · [Safety and limitations](SAFETY.md)

## 必要な環境

- Windows、Node.js 18以上、PowerShell 7。
- インストール・ログイン済みのClaude Code / Antigravity CLI。検証時はClaude Code 2.1.287、Antigravity 1.2.14。
- 既存のサブスクリプション認証。新しいOAuth、APIキー、従量課金APIの設定は行いません。プロバイダーの利用規約・利用枠は適用されます。
- 必要に応じて通常の承認を受けたWindows実行環境。制限されたシェルで認証やローカルサービスに届かない場合、ネットワークや権限設定を変更して回避しません。

CLIの場所は現在のユーザーの標準パスを使います。Claudeは `%USERPROFILE%\.local\bin\claude.exe`、Antigravityは `%USERPROFILE%\AppData\Local\agy\bin\agy.exe`。別の配置を自動探索する機能はありません。

## 使い方

テストはプロバイダーへの通信なしで実行できます。依存パッケージのインストールは不要です。

```powershell
node --test test/wrapper.test.mjs test/failure-diagnostics.test.mjs
```

例は架空の依頼です。内容と実行範囲を確認し、新しいUUIDに置き換えてから送信します。同じUUIDは、失敗・タイムアウト後も再送できません。送信は実際にプロバイダーを利用します。

```powershell
Copy-Item examples/claude.local.example.json request.json
$request = Get-Content request.json -Raw | ConvertFrom-Json
$request.id = [guid]::NewGuid().ToString()
$request | ConvertTo-Json -Depth 10 | Set-Content request.json -Encoding utf8NoBOM
node wrapper-diagnostics-v2.mjs send request.json
node wrapper-diagnostics-v2.mjs status $request.id
node wrapper-diagnostics-v2.mjs read-result $request.id
```

Antigravityの例は `examples/antigravity.local.example.json` です。`taskScope` の同意項目は、継承される権限と実際の依頼範囲を確認した場合にだけ指定してください。`plan` と範囲の文章は、すべてのツールを技術的に禁止する機能ではありません。

通常のエントリーは `wrapper.mjs`、失敗時の非公開診断を追加するエントリーは `wrapper-diagnostics-v2.mjs` です。両方とも同じ依頼形式と `send` / `status` / `read-result` を使います。

## 確認済みの範囲

- ローカルClaudeとAntigravityの短い回答について、保存、ハッシュ照合、読み戻しを確認。
- 運用検証では、Claudeによる12件の実質的なレビュー回答の読み戻し・ハッシュ照合を確認。依頼・回答の原文は公開していません。
- 32件のオフラインテストで、入力検証、重複防止、プロセス終了、結果保持、診断の抑制・秘匿化を確認。

Claudeの既存クラウドセッションへの送信は、キューの受理だけを確認します。返答取得や完了確認は未検証です。Antigravityの同等クラウドルートは提供していません。利用枠に基づく自動振り分け、フェイルオーバー、常駐処理も未実装です。

依頼上限はUTF-8で64 KiB、タイムアウトは1〜600秒、標準は120秒です。`accepted` は受理、`executed` はローカルの最終回答、`verified` は指定した文字列との一致です。`unknown` は完了を確認できない状態です。文字列やハッシュの一致は、回答内容の正しさを保証しません。

## 保存とアクセス

`captureResult: true` は、新規の依頼ディレクトリに対するWindows ACL確認が成功してから生成を開始します。実行したWindowsユーザー、SYSTEM、管理者にアクセスを残します。普段使う本人のユーザーで実行してください。別ユーザーやサービスとして動かすと、本人が成果物を読めなくなる可能性があります。導入環境で本人の読み取りと削除の可否を確認してください。

回答と診断は `data/requests/` に残ります。保存期間の自動設定・自動削除はありません。診断のパターン秘匿化には限界があり、診断ファイルを公開しないでください。詳しくは [SAFETY.md](SAFETY.md) を参照してください。

このリポジトリはソース、架空の例、テスト、仕様のみを含みます。実際の依頼・回答、認証情報、利用枠・アカウント記録、実セッションURL、個人の絶対パスは含みません。LICENSEは付与していません。公開はMIT等の新しいライセンス許諾を意味しません。
