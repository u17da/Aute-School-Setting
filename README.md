# まなびポケット「9.2 学校設定」ブラウザ自動化 PoC / Production Batch

> [!IMPORTANT]
> **【Production Batch Foundation RE-CODE FREEZE (Phase 4C 完了)】**
> 本ツールの Production Batch 基盤コードは、Phase 4A/4B/4C を通じた実環境（PRRHC / MEXCBTデモ学校）での実仕様実測・ドメインモデル補正（`directMessage: OFF` 時の `DISABLED_BY_DEPENDENCY` / `value: null` 実DOM仕様反映、Pre-Save / Post-Save 期待値分離、依存関係評価厳格化、異常系 Case A〜D 網羅）、全92件の単体・統合テスト完全通過、および PRRHC での Live 回帰検証（Write & Restore）の完全成功をもって、**再度コードフリーズ（凍結）** 状態に移行しました。
> 今後、実400校のデータ到着に伴う `--validate-only` または Preflight 実行において実データ上の真の不整合が発見されない限り、追加の機能拡張やコード変更は一切行いません。

まなびポケットの学校管理者アカウントでログインし、操作マニュアル **9.2「学校設定」p.197〜200** に記載されている11項目の学校設定を安全・確実に自動変更・検証するPlaywright自動化ツールです。

将来的な約400校への安全な一括展開を前提に、**「Execution Plan（実行計画）」を中心とするアーキテクチャ**を採用しています。

---

## 1. 主な設計原則

1. **Safe by Default (安全デフォルト)**:
   - オプションなし実行はすべて Dry Run となります。
   - **Dry Run の定義**: 設定値を変更する UI 操作および「更新する」による保存処理は一切行いません。ログイン、学校照合、画面遷移、設定値の読み取り、Plan 生成・評価は通常通り実行します。
2. **Execution Gate による多重保護**:
   - 通常変更 (Single): `--apply` および `--allow-live-write` が必須。
   - 破壊的変更（予約投稿削除リスク）: `--apply --allow-live-write` に加えて `--allow-destructive` が必須。
   - バッチ変更 (Batch): **4重Gate (`--batch --apply --allow-live-write --batch-apply`)** が必須。
   - バッチ実行時の破壊的変更: 安全のため強制ブロック（`DESTRUCTIVE_CHANGE_BLOCKED`）。
3. **1学校 = 1 BrowserContext の完全分離**:
   - 正常完了・Dry Run・エラー・例外を問わず、`finally` で確実に BrowserContext を破棄し、Cookie やセッションが他校に残らない構造を保証します。
4. **観測 (Observation) と 期待 (Expectation) の分離**:
   - 実画面から得た事実と期待値を分離し、推測で `DISABLED_BY_DEPENDENCY` を作成しません。
5. **UI 操作 (actions) と 依存連動結果 (dependencyEffects) の分離**:
   - Playwright が直接操作するクリック対象のみを `actions` に保持し、自動連動する項目は `dependencyEffects` として追跡・UI追従確認します。
6. **2系統のハッシュ管理**:
   - `settingsHash`: 400校に同一設定を配布したことを証明する設定ハッシュ。
   - `runConfigHash`: その1回の実行条件（学校、設定、オプション）を完全追跡・監査するハッシュ。
7. **保存処理の自動 Retry 禁止**:
   - 「更新する」ボタンの二重クリックは禁止。タイムアウト時は `page.reload()` して反映済みか確認（`SUCCESS_RECOVERED`）します。
8. **Phase 2B Single Safe Write 原則 (変更 -> 検証 -> 復元 -> 検証)**:
   - PoC段階では設定変更を行ったまま放置せず、検証完了後に必ず元値（Baseline）へ戻して再検証します。
9. **Circuit Breaker & Global Kill Switch (Phase 3 Batch)**:
   - 重大エラーが連続3校発生した場合、残りの学校への処理を自動PAUSEします。
   - `Ctrl+C` (SIGINT) 受信時は現在の学校完了後にチェックポイントを保存して安全停止します。

---

## 2. 認証方式ごとの検証カバレッジ (Coverage Status)

400校展開前の安全性確保のため、認証方式ごとに検証ステータスを厳格に分離管理しています。

| 認証方式 | Mock Test | Local / Simulated | Live Read-only | Live Write (Single PoC) | 本番Batch展開可否 |
|---|:---:|:---:|:---:|:---:|:---:|
| **AUTH_MODE=A** (ローカル認証) | **PASS** (18件) | **PASS** | **PASS** (Live Validation完了) | **PASS** (Phase 2B完了) | **条件付き可 (Canary推奨)** |
| **AUTH_MODE=B** (外部IdP認証) | **PASS** (18件) | **PASS** | **未実施** | **未実施** | **不可 (Live検証未完了)** |

> [!CAUTION]
> **AUTH_MODE=Bの本番展開制限**
> AUTH_MODE=BのLive Validationを行っていない状態で、Bを本番400校処理対象として有効化してはなりません。Production Batchも `AUTH_MODE=A` のみを対象とします。

---

## 3. Lost Update（更新重複・競合）の残余リスクと運用上の対策

> [!WARNING]
> **Lost Update の残余リスク**
> まなびポケットの画面フォーム送信仕様上、学校管理者が同時に同一校の設定を手動変更している場合、後勝ち（Last Write Wins）により手動変更が上書きされる、または本ツールの変更が上書きされる可能性があります。
> 
> **推奨運用対策:**
> 1. 学校管理者が管理画面にログインして操作しない **夜間または休日・休校日の時間帯** にバッチを実行すること。
> 2. 事前に教育委員会等から各校管理者へ設定変更期間中の手動操作を控えるよう通知すること。
> 3. バッチ実行前後に Read-only Preflight / Summary Report を取得し、不一致がないか監査すること。

---

## 4. Canary Rollout 手順（段階的展開）

本番への適用は、全400校へいきなり一括適用するのではなく、以下のCanary段階を踏んで進めます。

```
[Step 1: Read-only Preflight] (400校 全件読取 & 差分集計、Writeなし)
      ↓ 問題なし確認
[Step 2: Canary 1校適用] (--batch --apply --allow-live-write --batch-apply --limit 1)
      ↓ 実画面目視確認・ログ確認
[Step 3: Canary 5校適用] (--limit 5)
      ↓ 監査レポート確認
[Step 4: Canary 20校適用] (--limit 20)
      ↓ Circuit Breakerトリップなし確認
[Step 5: 残り全校適用] (--batch --apply --allow-live-write --batch-apply --resume)
```

### --limit N の定義（指示15）
> [!IMPORTANT]
> `--limit N` は **「今回の実行で処理する eligible / PENDING 学校を最大 N 校」** と定義されています。
> 累計数（過去に成功した学校を含む総数）ではありません。
> したがって、`--limit 1`（1校処理）の後に `--resume --limit 5` を実行すると、「次の未完了5校」が処理されます。

---

## 5. 運用手順 (STEP 1 〜 STEP 7)

本番展開および事前検証は、事故を防ぐため以下の7ステップを厳格に順守して進めます。

### STEP 1: 設定・入力ファイルの準備
- `config/schools.live.csv`: 全400校の一覧（schoolCode, schoolName, credentialRef, enabled）
- `config/credentials.json`: 各校の学校管理者認証情報（ローカルファイル管理、Git除外必須）
- `config/production-profile.live.json`: 本番統一設定プロファイル（Zodスキーマ準拠、Git除外）

### STEP 2: ブラウザ起動なしの静的入力検証 (--validate-only)
ブラウザ（Chromium）を一切起動せず、入力ファイル、スキーマ、Hash、認証情報の欠損、学校数の一致を数秒で検証します。
```powershell
# 1行コマンド (推奨)
npm start -- --batch --validate-only --schools config/schools.live.csv --profile config/production-profile.live.json --credentials config/credentials.json --expected-school-count 400

# 複数行コマンド (PowerShell バッククォート構文)
npm start -- --batch `
  --validate-only `
  --schools config/schools.live.csv `
  --profile config/production-profile.live.json `
  --credentials config/credentials.json `
  --expected-school-count 400
```

### STEP 3: Read-only 400校 Preflight の実行
安全デフォルト（書き込み・保存一切なし）で全校にアクセスし、現在値の取得、Plan生成・評価、Preflight Reportを出力します。
1学校ごとに新しいBrowserContextを生成し、完了後に破棄します。
```powershell
# 1行コマンド (推奨)
npm start -- --batch --schools config/schools.live.csv --profile config/production-profile.live.json --credentials config/credentials.json --expected-school-count 400 --delay-between-schools-ms 1500 --school-timeout-ms 120000

# 複数行コマンド (PowerShell バッククォート構文)
npm start -- --batch `
  --schools config/schools.live.csv `
  --profile config/production-profile.live.json `
  --credentials config/credentials.json `
  --expected-school-count 400 `
  --delay-between-schools-ms 1500 `
  --school-timeout-ms 120000
```

### STEP 4: Preflight Report の確認と安全停止（人間の承認）
Preflight完了後に出力される `reports/preflight-<deploymentId>.json` を確認し、自動書き込みへは進まず停止します。
- `status: "COMPLETE"` かつ `writeGateEligible: true` であること
- 全400校の読取が100%成功（`allReadSucceeded: true`）していること
- 破壊的変更が0件（`destructiveChangeSchools: 0`）であること
- 有効期限（`validUntil`: 全校完了時刻から24時間）以内であること
- 人間（教育委員会・運用責任者）のレビューと承認を取得すること

### STEP 5: Canary 1校適用 (4重Gate + Preflight紐づけ)
承認取得後、1校のみを対象に書き込みを実行し、実画面で目視確認を行います。
```powershell
# 1行コマンド (推奨)
npm start -- --batch --apply --allow-live-write --batch-apply --schools config/schools.live.csv --profile config/production-profile.live.json --credentials config/credentials.json --preflight-report reports/preflight-xxxx.json --expected-school-count 400 --limit 1

# 複数行コマンド (PowerShell バッククォート構文)
npm start -- --batch --apply --allow-live-write --batch-apply `
  --schools config/schools.live.csv `
  --profile config/production-profile.live.json `
  --credentials config/credentials.json `
  --preflight-report reports/preflight-xxxx.json `
  --expected-school-count 400 `
  --limit 1
```

### STEP 6: Canary 5校 / 20校の段階適用
Canary 1校の成功確認後、未処理の対象校から順次 5校、20校と段階的に適用します。
```powershell
# Canary 5校適用 (未処理先頭5校)
npm start -- --batch --apply --allow-live-write --batch-apply --schools config/schools.live.csv --profile config/production-profile.live.json --credentials config/credentials.json --preflight-report reports/preflight-xxxx.json --expected-school-count 400 --resume --limit 5

# Canary 20校適用 (未処理先頭20校)
npm start -- --batch --apply --allow-live-write --batch-apply --schools config/schools.live.csv --profile config/production-profile.live.json --credentials config/credentials.json --preflight-report reports/preflight-xxxx.json --expected-school-count 400 --resume --limit 20
```

### STEP 7: 残り全校適用 & 完了サマリ監査
Canary各段階で Circuit Breaker トリップがなく正常であることを確認し、残り全校を適用します。
```powershell
# 残り全校の一括適用 (Resume)
npm start -- --batch --apply --allow-live-write --batch-apply --schools config/schools.live.csv --profile config/production-profile.live.json --credentials config/credentials.json --preflight-report reports/preflight-xxxx.json --expected-school-count 400 --resume
```

---

## 6. テスト実行コマンド (PowerShell)

```powershell
# 1. ユニットテスト実行 (Phase 1, 2A, 2B, 3)
npm test
npm run test:phase2a
npm run test:phase2b
npm run test:phase3

# 2. 型チェック
npx tsc --noEmit
```

---

## 7. ステータスコード一覧 (SSOT)

| ステータスコード | 分類 | 説明 |
|---|---|---|
| `SUCCESS` | 正常完了 | 設定変更、保存、更新後検証がすべて一致して完了 |
| `SUCCESS_ALREADY_CONFIGURED` | 正常完了 | 全項目が既に期待状態と一致していたため操作をスキップ |
| `SUCCESS_RECOVERED` | 正常完了 | 保存シグナル待機タイムアウト後、reload で反映済みを確認 |
| `DRY_RUN_COMPLETED` | 正常完了 | Dry Run として実行計画と評価結果を出力して終了 |
| `CLI_ARGUMENT_ERROR` | 初期化エラー | CLI引数の組み合わせや値が不正 |
| `CONFIG_INVALID` | 初期化エラー | 設定ファイルの読み込み・JSONパース・スキーマ検証に失敗 |
| `BATCH_INPUT_INVALID` | 初期化エラー | 学校CSVの重複・欠損、または想定学校数 (--expected-school-count) 不一致 |
| `CHECKPOINT_MISMATCH` | 初期化エラー | Resume時のプロファイルHash、学校一覧Hash、ツールバージョン不一致 |
| `BATCH_LOCKED` | 初期化エラー | 同一deploymentIdの二重起動検知（ロックファイル存在） |
| `CREDENTIAL_NOT_FOUND` | エラー | 学校コードに対する認証情報が見つからない |
| `LOGIN_FAILED` | エラー | ログイン操作失敗（明確なエラー表示、ID/PW相違等） |
| `AUTH_OUTCOME_UNKNOWN` | 重大エラー | 認証情報送信後に成否を確認できないタイムアウト・切断（アカウントロック防止のため即時1回で中断） |
| `AUTH_INTERACTION_TIMEOUT` | エラー | 外部IdP認証・MFAのユーザー操作待機タイムアウト |
| `SCHOOL_MISMATCH` | エラー | 画面上の学校名が設定ファイルと不一致 |
| `SETTINGS_MENU_NOT_AVAILABLE` | エラー | 設定メニュー内に「学校設定」が存在しない |
| `SETTINGS_PAGE_NOT_FOUND` | エラー | 学校設定画面のロード失敗 |
| `UI_STRUCTURE_MISMATCH` | エラー | 通常必須項目のDOMが不在、または選択肢数が仕様と不一致 |
| `SETTING_NOT_AVAILABLE` | エラー | 契約外非表示項目（心の健康観察等）への明示的設定要求 |
| `CONFIG_CONFLICT` | エラー | 設定値同士の論理矛盾（タイムラインOFF+全体ON等） |
| `DEPENDENCY_UNSATISFIED` | エラー | 親がOFFで未指定なのに子をONにしようとした（Runtime） |
| `UNSAFE_CONFIGURATION` | エラー | 外部IdP環境でパスワード変更表示をSHOWに指定した、またはAUTH_MODE=BでProduction実行しようとした |
| `DESTRUCTIVE_CHANGE_BLOCKED` | エラー | 破壊的変更（予約投稿削除リスク）が未許可、またはBatch実行で検知されたため停止 |
| `POC_SCOPE_VIOLATION` | エラー | Phase 2B PoCで複数項目の変更または0件変更を検知して停止 |
| `PRE_SAVE_VALIDATION_FAILED` | エラー | 保存ボタン押下前のUI選択状態がexpectedと不一致 |
| `SAVE_FAILED` | エラー | 保存処理が失敗 |
| `RESTORE_FAILED` | 重大エラー | Phase 2Bで元値への復元に失敗（人間による確認を要求） |
| `VERIFY_MISMATCH` | エラー | 保存後の画面値がexpectedと不一致 |
| `UNEXPECTED_SIDE_EFFECT` | エラー | unmanagedな設定が意図せず変更されたことを検知 |
| `TIMEOUT` | エラー | 一般的なページ・要素待機タイムアウト |
| `CLEANUP_TIMEOUT` | 致命的エラー | タイムアウト後のBrowserContextクリーンアップが時間内に完了せず、裏タスク生存リスク防止のためバッチを即時PAUSE |
| `APPROVAL_AUDIT_INVALID` | 致命的エラー | 承認履歴のタイムライン不整合（過去逆転、未承認実行等）を検知して実装着手を拒否 |
| `UNEXPECTED_ERROR` | エラー | その他予期せぬ例外 |

---

## 8. スクリーンショット Allow-list ポリシー (機密情報・資格情報保護)

本ツールでは、機密情報（パスワード、ID、認証画面DOM、学校一覧画面等）がログや成果物に流出する事故を防止するため、**厳格な Allow-list 判定** を適用しています。

1. **撮影完全禁止（Deny）**:
   - ログイン画面（認証入力フォーム、パスワード入力欄）
   - トップ画面 / ホーム画面（児童生徒名や他校情報が表示される可能性のあるダッシュボード）
   - 学校名未照合状態のすべての画面
   - 正常完了した学校（トラブルシューティング用画像は不要のため 0 枚保存）
2. **唯一の撮影許可対象（Allow-list）**:
   - **`authenticationCompleted === true`（ログイン正常完了後）**
   - **`schoolVerified === true`（画面上の学校名が照合・合致済み）**
   - **`pageType === 'SCHOOL_SETTINGS'`（「9.2 学校設定」画面内）**
   - かつ **エラー・例外発生時のみ**
3. **安全停止・フェイルセーフ**:
   - 万が一画面判定が `UNKNOWN` の場合、スクリーンショット撮影は強制スキップ（0枚）されます。

---

## 9. 主要 CLI オプション一覧

| オプション | 型 / デフォルト | 説明 |
|---|---|---|
| `--batch` | boolean (false) | バッチ実行モードを有効化 |
| `--schools <path>` | string | 学校一覧CSVファイルのパス（必須） |
| `--profile <path>` | string | 統一設定プロファイルJSONファイルのパス（必須） |
| `--credentials <path>` | string | 学校管理者認証情報JSONファイルのパス（任意・環境変数フォールバック） |
| `--expected-school-count <N>` | number | 想定学校数との完全一致を強制する安全Gate（不一致時即停止） |
| `--validate-only` | boolean (false) | ブラウザを起動せず静的検証のみ実施して即終了 |
| `--school-timeout-ms <N>` | number (120000) | 1学校あたりの最大処理タイムアウト（ms） |
| `--cleanup-timeout-ms <N>` | number (30000) | タイムアウト発生時のBrowserContext破棄・旧Promise待機タイムアウト（ms、超過時は `CLEANUP_TIMEOUT` で即PAUSE） |
| `--delay-between-schools-ms <N>` | number (1500) | 学校間のPacing待機時間（ms） |
| `--apply` | boolean (false) | 書き込み許可フラグ（Single/Batch共通 Gate 1） |
| `--allow-live-write` | boolean (false) | 実環境書き込み許可フラグ（Gate 2） |
| `--batch-apply` | boolean (false) | バッチ書き込み許可フラグ（Gate 3） |
| `--preflight-report <path>` | string | 事前検証済みのPreflight Reportパス（Write実行時は必須） |
| `--resume` | boolean (false) | 中断したチェックポイントから未完了校を再開 |
| `--limit <N>` | number | 今回の実行で処理する未完了校の最大数（Canary展開用） |

---

## 10. Local Read-only Operator Console (Phase 5A Web UI)

教育委員会や運用担当者が、400校Batch処理の入力検証・Read-only Preflight監視・現状設定分布・変更予定・リスク判定を直感的に確認・操作するためのローカル専用Web UIです。

> [!IMPORTANT]
> **Read-only 専用コンソール**
> 本コンソールは **事前検証（Static Validation）および Read-only Preflight の実行・監視・分析専用** です。
> 誤操作による予期せぬ更新事故を防止するため、UI からの Write 操作（Canary Write、本番一括書き込み等）を実行する機能および API は一切存在しません。書き込みの適用は CLI から多重安全 Gate を通してのみ実行可能です。

### 10.1 起動方法

```bash
# 依存関係が未インストールの場合は npm install
npm run console
```

ブラウザで以下のURLを開きます：
`http://localhost:3000`

※ ポート番号を変更したい場合は、環境変数 `CONSOLE_PORT=8080 npm run console` を指定します。

### 10.2 画面構成 (3画面 SPA)

1. **画面 1: 設定・入力検証画面 (Setup / Validation)**
   - 設定ファイル（schools.csv, production-profile.json, credentials.json）の指定
   - 想定学校数（`expectedSchoolCount`）の指定
   - 11項目の統一設定プロファイル（MANAGED / UNMANAGED、設定値）の可視化
   - **「入力を検証」ボタン**: 静的検証を実行し、ハッシュ値（`profileHash`, `schoolsHash`, `toolFingerprint`）および有効学校数を確認。検証 PASS で「Preflight を開始」がアンロックされます。
2. **画面 2: Preflight 実行・監視画面 (Preflight Progress)**
   - **Read-only 安全バッジ表示**: `Read-only Dry Run: 設定の変更・保存は行いません`
   - **進捗バー & メトリクス**: 処理済校数、全体校数、進捗率（%）、成功数、失敗数、残り校数、経過時間、推定残り時間
   - **リアルタイムログストリーム (SSE)**: 現在処理中の学校コード・学校名、ログ出力
   - **安全停止ボタン (`[Preflightを停止]`)**: クリックで即座に子プロセスへ SIGINT を送信し、現在の学校完了後にチェックポイントを保存して安全停止。
3. **画面 3: 結果分析・分布確認画面 (Results & Distributions)**
   - **総合サマリーカード**: 全体校数、読取成功、読取失敗、現状一致（変更なし）、要変更、Planブロック、破壊的変更校、Write対象校
   - **変更アクション数分布**: 0件変更、1件変更、2件変更、3件以上変更の学校数グラフ/テーブル
   - **現状設定分布表 (Current State Distribution)**: 11項目それぞれの実画面値（ON, OFF, CONTRACT_NOT_AVAILABLE など）の学校数分布
   - **変更予定分布表 (Planned Change Distribution)**: 各項目の変更方向（noChange, ON_TO_OFF, OFF_TO_ON 等）の学校数分布
   - **破壊的変更警告領域 (Destructive Change Alerts)**: 予約投稿削除リスク等の破壊的変更が含まれる学校の警告リスト
   - **失敗校リスト (Failed Schools)**: 読取失敗校の学校コード、学校名、エラーコード、安全なエラーメッセージ
   - **レポートプレビュー & ダウンロード**: Preflight Report、Summary Report、Checkpoint のサニタイズ済み JSON ダウンロード
   - **再開 / 再試行**: 未処理校のみの `[Preflightを再開]`、失敗校のみの `[失敗校のみ再読取]`

### 10.3 セキュリティ & 安全アーキテクチャ

1. **完全なプロセス境界 (Process Boundary)**:
   - Console Server は Production Domain コードを直接改変せず、`child_process.spawn('npx.cmd', ['ts-node', '-T', 'src/index.ts', '--batch', '--dry-run', ...], { shell: false })` を経由して実行します。引数に `--apply` などの Write フラグは物理的に含めません。
2. **二重安全 Gate (Validation Snapshot)**:
   - 検証 PASS 時にハッシュ（`profileHash`, `schoolsHash`, `toolFingerprint` 等）のスナップショットを保持。Preflight 開始直前に再度ハッシュを計算し、一致しない場合は `VALIDATION_STALE` で起動を拒絶します。
3. **Single Job Guard**:
   - バックグラウンド実行中に重複して Preflight や Retry を起動することは `409 Conflict` でブロックされます。
4. **Localhost 限定バインド & 厳格なアクセス防護**:
   - `127.0.0.1` のみにバインド（外部LANからの接続不可）。
   - 不正な `Host` ヘッダー（`evil.com` 等）や `Origin` ヘッダーからのアクセスは `403 Forbidden` で遮断。
   - すべての POST リクエストで `X-CSRF-Nonce` を検証。
5. **秘密情報の完全非露出**:
   - `userId`, `password`, `token` などの秘密情報は UI、API レスポンス、SSE ストリーム、ダウンロードレポートから完全にマスク・除去（`[REDACTED]`）されます。
6. **レポートダウンロードの Allow-list 防護**:
   - ダウンロード可能なレポートは `['summary', 'preflight', 'checkpoint']` に限定され、パストラバーサル（`../`）による任意ファイル閲覧は一切不可です。



