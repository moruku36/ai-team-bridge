# ai-team-bridge

[English](README.md) · [日本語](README.ja.md) · [仕様](SPEC.md) · [安全性](SAFETY.md) · [残量ルーティング](docs/QUOTA-ROUTING.md) · [Windows残量取得](docs/WINDOWS-QUOTA-CLI.md)

Windows上の **Claude Code** と **Antigravity CLI** に、範囲を確認済みの依頼を送り、回答をディスクに非公開で保存し、読み戻すときにハッシュで照合する小さなコマンドラインツールです。Node.jsの組み込み機能だけを使い、npmの依存パッケージはありません。

## 開発の背景

オーナーが公開している [multi-ai-workflow](https://github.com/moruku36/multi-ai-workflow) の設計では、DottieとCodexを中心にしたオーケストレーション環境から、選んだ作業をClaude CodeとAntigravity/Geminiに任せます。ツール間でプロンプトと返信を手でコピーするのは手間がかかり、間違いも起きやすい作業でした。このブリッジは、そのコピー作業を、記録が残るローカルの受け渡しに置き換えます。multi-ai-workflowはアーキテクチャの背景として参照しているだけで、このプロジェクトはそれに依存しません。

## ワークフローでの位置づけ

multi-ai-workflowは、範囲を絞った割り当て、独立したレビュー、統合前の検証を求めています。主なローカル基盤はWindowsです。

- **Dottie**: PM兼オーケストレーター。
- **Claude**: 割り当てられた作業の下書きや実装。
- **Antigravity/Gemini**: 選ばれた作業を担当。
- **Codex**: ワークフローに応じて、調整または独立した検証。

タスクのルーティングは「誰が作業するか」を決め、実行制御は「何をしてよいか」を決めます。このブリッジが行うのは、依頼と結果をローカルで受け渡すことだけです。役割を割り当てたり、エージェントの権限を与えたり広げたりはせず、組織の役割分担を強制するものでもありません。

## 構成

![構成図](docs/diagrams/architecture.svg)

| ファイル | 役割 |
|---|---|
| `wrapper.mjs` | 基本のエントリー。依頼を検証し、読み取り専用のログイン確認を行い、UUIDを予約し、シェルを使わずにプロンプトを標準入力でプロバイダーCLIへ渡し、結果を記録します。 |
| `wrapper-diagnostics-v2.mjs` | 基本と同じコマンドに、保存対象のローカル依頼について、非公開で秘匿化済みの失敗診断を追加します。 |
| `failure-diagnostics.mjs` | プロバイダーのエラー項目を許可リストで絞り、標準エラー出力から一般的な秘密情報のパターンを伏せ字にします。 |
| `private-output.ps1` | 生成を始める前に、新しい依頼フォルダーのアクセス権を、本人・SYSTEM・管理者だけに制限します。 |
| `task-router.mjs`、`router-cli.mjs` | 残量に基づくルーティング。明示したキューに対する副作用のないドライランと、1件だけを明示して実行する `execute`。 |
| `quota-snapshots.mjs` | 残量スナップショットの厳密な検証とプール単位の整理。 |
| `windows-quota-collector.mjs`、`quota-collect-cli.mjs` | インストール済み・ログイン済みのCLIを使う、単発の残量メタデータ取得。 |

### 依頼の流れ

![send / read-result のシーケンス](docs/diagrams/send-sequence.svg)

![依頼の状態](docs/diagrams/request-states.svg)

図は [`docs/diagrams/`](docs/diagrams/) にあるMermaidのソースから、[Pele](https://pele.run/) で描画しています。

## 必要な環境

- Windows、PowerShell 7、Node.js **22.23.2以上**([`.nvmrc`](.nvmrc) と `package.json` の `engines` で固定)。
- サブスクリプションでログイン済みのプロバイダーCLI。検証時のバージョンはClaude Code 2.1.287、Antigravity 1.2.14です。プロバイダーの利用規約と利用枠は引き続き適用されます。
- `%USERPROFILE%` 配下の標準のインストール先。`.local\bin\claude.exe` と `AppData\Local\agy\bin\agy.exe` です。それ以外の場所は探しません。
- 通常の承認済みWindowsセッション。制限されたシェルから既存のログインやローカルサービスに届かない場合は、承認済みの環境を使ってください。このプロジェクトは、制限を回避するためにネットワークや権限を変更しません。

認証情報の作成、OAuthの開始、従量課金APIの設定、プロバイダーのインストール、常駐サービスの実行は行いません。受け付けるモデルは、一覧で確認済みのClaudeの `sonnet` とAntigravityの `gemini-3.8-flash-medium` だけで、利用可否は変わることがあります。要求したモデルとプロバイダーが報告したモデルは別々に記録され、報告がない場合は `UNKNOWN` になります。

## クイックスタート

オフラインテストを実行します。プロバイダーは呼び出さず、インストールも不要です。

```powershell
npm test
```

例は架空の依頼です。内容と範囲を確認し、プレースホルダーを新しいUUIDに置き換えて、ローカルの依頼として保存します。**送信すると実際にプロバイダーが呼び出され、通常の利用枠を消費します。** 同じUUIDは、失敗やタイムアウトの後でも二度と送信できません。

```powershell
Copy-Item examples/claude.local.example.json request.json
$request = Get-Content request.json -Raw | ConvertFrom-Json
$request.id = [guid]::NewGuid().ToString()
$request | ConvertTo-Json -Depth 10 | Set-Content request.json -Encoding utf8NoBOM
node wrapper-diagnostics-v2.mjs send request.json
node wrapper-diagnostics-v2.mjs status $request.id
node wrapper-diagnostics-v2.mjs read-result $request.id
```

`request*.json` と `data/` はgitの管理対象外なので、ローカルの依頼や結果を誤ってコミットすることはありません。

`examples/antigravity.local.example.json` は、Antigravityが引き継ぐ権限と実際の依頼範囲を確認してから使い、`taskScope` の同意項目もそのときにだけ設定してください。対応するCLIには、呼び出しごとにツールを許可する仕組みも、すべてのツールを無効にするスイッチも確認されていません。そのため `plan` モードと範囲の文章はモデルへの指示であり、強制力のある権限の境界ではありません。

`wrapper.mjs` と `wrapper-diagnostics-v2.mjs` は、同じ依頼形式と同じ `send` / `status` / `read-result` コマンドを使います。エクスポートされたAPIを組み込む場合は、既存の依頼ルートとUUIDの予約を維持してください。状態が不明な作業を、診断を有効にするためだけに再送しないでください。

## 残量の取得とルーティング

- [Windows残量取得](docs/WINDOWS-QUOTA-CLI.md): `quota-collect-cli.mjs` は、既存のWin-CodexBar 0.70.0またはAntigravity 1.3.5を使って、残量メタデータを1回だけ取得します。出力は私的情報で、それだけではルーティングの許可になりません。
- [残量ルーティング](docs/QUOTA-ROUTING.md): `router-cli.mjs dry-run` は、明示したキューを確認済みのスナップショットとポリシーで評価し、何も起動しません。`router-cli.mjs execute` は、名前を指定した実行可能なタスクを1件だけ、`--confirm-execute` を付けた場合に限り実行します。自律的なルーティング、プロバイダーの切り替え、常駐ワーカーはありません。

## 結果と終了コード

| 状態 | 意味 |
|---|---|
| `accepted` | クラウドセッションがメッセージを受理したことだけを表し、返答ではありません。 |
| `executed` | ローカルのプロバイダーが最終回答を返しました。 |
| `verified` | `executed` に加えて、回答が `expectResponse` と一致しました。 |
| `unknown` | 完了を確認できません(タイムアウト、キャンセル、不完全または不正な出力、出力上限)。 |
| `rejected` | プロバイダーがエラーを返したか、非公開の保存先を準備できませんでした。 |

終了コードは、成功または受理を確認できた場合が `0`、`unknown`・`rejected`・保存失敗が `2`、検証や事前確認の失敗が `1` です。文字列やハッシュの一致は、回答の正しさを保証しません。

## 制約

- 依頼はUTF-8で64 KiBまで、タイムアウトは1〜600秒(標準120秒)、出力は2 MiBまでです。
- 依頼ごとにUUIDを1つ使い、自動リトライはしません。キャンセルで止まるのはブリッジが起動した子プロセスだけで、その子孫プロセスやリモートの処理は動き続けることがあります。
- 両方のプロバイダーで、ローカルの受け渡し(保存、ハッシュ照合、読み戻し)を確認しました。Claudeによる12件の実質的なレビュー回答も、読み戻しで確認しています。これらの依頼と回答は公開していません。
- Claudeの既存クラウドセッションについて確認できるのは、キューへの受理だけです。クラウドの返答とリモートでの完了は未検証で、Antigravityのクラウドルートはありません。詳しくは [クラウド読み戻しの調査](docs/CLOUD-READBACK.md) を参照してください。

## 非公開の成果物

`captureResult: true` の場合、新しい依頼フォルダーのアクセス権の確認が成功してから生成を始めます。アクセスできるのは、実行したWindowsユーザー、SYSTEM、管理者です。本人のユーザーで実行してください。別のアカウントやサービスで実行すると、本人が読めないファイルができることがあります。実際の導入環境で本人が読み取りと削除をできることを確認し、サンドボックスの権限を黙って広げないでください。

保存された出力は非公開です。回答と診断は、削除するまで `data/requests/` に残り、期限切れや自動削除はありません。診断の伏せ字処理はパターンに基づくもので完全ではないため、診断ファイルは公開しないでください。詳しくは [SAFETY.md](SAFETY.md) と [SPEC.md](SPEC.md) を参照してください。

## 開発

- `npm test` で `test/` 配下のオフラインテストをすべて実行します。
- `npm run manifest:check` で、[`SOURCE-MANIFEST.json`](SOURCE-MANIFEST.json) が管理対象のファイルと一致するかを確認します。意図した変更の後は `npm run manifest:update` を実行し、結果をコミットしてください。
- [`.gitattributes`](.gitattributes) でどの環境でも改行をLFに揃えるため、Windowsのチェックアウトでも CI でもハッシュが一致します。
- GitHub Actionsで、プッシュとプルリクエストのたびに、Windows上でテストとマニフェストの確認を実行します。

## 公開内容

このリポジトリに含まれるのは、ソースコード、架空の例、テスト、ドキュメントだけです。実際の依頼や回答、認証情報、利用枠やアカウントの記録、実際のセッションURL、個人の絶対パスは含みません。ライセンスは付与していません。公開されていても、MITなどのライセンスで提供されているわけではありません。
