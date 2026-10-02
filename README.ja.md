# ai-team-bridge

[English](README.md) · [日本語](README.ja.md) · [仕様](SPEC.md) · [安全性](SAFETY.md)

## 開発の背景

オーナーが公開している [multi-ai-workflow](https://github.com/moruku36/multi-ai-workflow) の設計は、Dottie/Codexを中心とするオーケストレーション環境を使い、選んだ作業をClaude CodeとAntigravity/Geminiに任せます。ツール間でプロンプトと返信を手作業でコピーするのは面倒でした。

このブリッジは、Windows上のClaude CodeとAntigravity CLIに、範囲を確認した依頼を送り、ローカルの回答を保存して読み戻しで検証する小さなツールです。Node.jsの組み込み機能だけを使います。リンク先のmulti-ai-workflowリポジトリは、アーキテクチャの背景として参照するだけです。

## ワークフローでの位置づけ

multi-ai-workflowは、範囲を絞った割り当て、独立したレビュー、統合前の検証を定めています。主なローカル基盤はWindowsです。この設計では次のようになります。

- DottieはPM/オーケストレーターです。
- Claudeは、割り当てられた作業の下書きや実装を担当します。
- Antigravity/Geminiは、選ばれた作業を担当します。
- Codexは、選択されたワークフローに応じて調整するか、独立して検証します。

タスクのルーティングは誰が作業するかを決め、実行制御は許可される操作を決めます。このブリッジは、その設計におけるローカルの転送・結果受け渡しの部品です。自動ルーターではなく、上記の役割やエージェントの権限を決めたり広げたりせず、組織上の役割分担のすべてを強制するものでもありません。

## 必要な環境

- Windows、Node.js 18以上、PowerShell 7。
- 既存のサブスクリプションでログイン済みのプロバイダーCLI。検証時はClaude Code 2.1.287、Antigravity 1.2.14。プロバイダーの利用規約と利用枠は引き続き適用されます。
- 現在のユーザーの `%USERPROFILE%` 配下にある標準のCLIパス。`.local\bin\claude.exe` と `AppData\Local\agy\bin\agy.exe`。それ以外の場所は自動探索しません。
- 制限されたシェルから既存の認証やローカルサービスに届かない場合は、通常の承認を受けたWindows実行環境。このプロジェクトは、制限を回避するためにネットワークや権限を変更しません。

認証情報の作成、OAuthの開始、従量課金APIの設定、プロバイダーのインストール、常駐プロセスの設定は行いません。モデルは、一覧で確認済みの `sonnet` と `gemini-3.8-flash-medium` に限られ、利用可否は変わることがあります。要求したモデルと実際に観測したバックエンドモデルは別々に記録され、バックエンドの情報がない場合は `UNKNOWN` になります。

## 使い方

オフラインテストはどちらのプロバイダーも呼び出さず、依存パッケージのインストールも不要です。

```powershell
node --test test/wrapper.test.mjs test/failure-diagnostics.test.mjs
```

例は架空の依頼です。内容と範囲を確認し、プレースホルダーを新しいUUIDに置き換えて、ローカルの依頼として保存します。送信は実際にプロバイダーを呼び出し、通常の利用枠を消費します。同じUUIDは、失敗やタイムアウトの後でも再送できません。

```powershell
Copy-Item examples/claude.local.example.json request.json
$request = Get-Content request.json -Raw | ConvertFrom-Json
$request.id = [guid]::NewGuid().ToString()
$request | ConvertTo-Json -Depth 10 | Set-Content request.json -Encoding utf8NoBOM
node wrapper-diagnostics-v2.mjs send request.json
node wrapper-diagnostics-v2.mjs status $request.id
node wrapper-diagnostics-v2.mjs read-result $request.id
```

Antigravityでは、継承される権限と実際の依頼範囲を確認した後にだけ `examples/antigravity.local.example.json` を使い、その場合にだけ `taskScope` の同意項目を指定してください。対応するCLIには、呼び出しごとに細かくツールを許可する機能も、すべてのツールを無効にするスイッチも確認されていません。そのため `plan` と範囲の文章は指示であり、強制力のある権限の境界ではありません。

`wrapper.mjs` は基本のエントリー、`wrapper-diagnostics-v2.mjs` は失敗時の非公開診断を追加したエントリーです。どちらも同じ依頼形式と `send` / `status` / `read-result` を使います。エクスポートされたAPIを組み込む場合は、既存の依頼ルートとUUIDの予約を維持してください。状態が不明な作業を、診断を有効にするためだけに再送しないでください。

## 検証内容と制約

- ローカルのパスと短い回答は、両方のプロバイダーで保存、ハッシュ照合、読み戻しを確認しました。
- Claudeによる12件の実質的なレビュー回答は、読み戻しとハッシュ照合で確認しました。依頼と回答は公開していません。
- 32件のオフラインテストで、依頼の検証、重複防止、プロセス処理、結果の保持、診断の抑制と秘匿化を確認しています。これらはプロバイダーでの実機確認の代わりにはなりません。

Claudeの既存クラウドセッションへの送信で確認できるのは、キューの受理だけです。受理は返答の取得ではなく、クラウドの返答とリモートでの完了は未検証です。Antigravityの同等のクラウドルートはありません。利用枠に基づく自動ルーティング、プロバイダーのフォールバック、常駐ワーカーは未実装です。

依頼はUTF-8で64 KiBまでです。タイムアウトは1〜600秒で、標準は120秒です。出力は2 MiBまでです。依頼ごとにUUIDを予約し、自動リトライはしません。キャンセルの対象は起動した子プロセスだけで、その子孫プロセスやリモートの処理は残る場合があります。`accepted` は受理の通知、`executed` はローカルの最終回答、`verified` はさらに指定した文字列と一致したこと、`unknown` は完了を確認できない状態を表します。文字列やハッシュの一致は、意味的な正確さを保証しません。

## 非公開の成果物

`captureResult: true` の場合、新しい依頼ディレクトリのACL確認が成功してから生成を開始します。実行したWindowsユーザー、SYSTEM、管理者にアクセスを残します。本人のユーザーで実行してください。別のアカウントやサービスで実行すると、本人が読めない成果物ができる可能性があります。実際の導入環境で本人の読み取りと削除の可否を確認し、サンドボックスの権限をなし崩しに広げないでください。

保存された出力は非公開です。回答と診断は、明示的に削除するまで `data/requests/` に残り、自動的な期限切れや削除はありません。診断のパターン秘匿化は完全ではないため、診断ファイルは公開しないでください。詳しくは [SAFETY.md](SAFETY.md) と [SPEC.md](SPEC.md) を参照してください。

## 公開内容

このリポジトリに含まれるのは、ソース、架空の例、テスト、ドキュメントだけです。実際の依頼や回答、認証情報、利用枠やアカウントの記録、実際のセッションURL、個人の絶対パスは含みません。ライセンスは付与していません。公開されていることは、MITなどのライセンス許諾を意味しません。
