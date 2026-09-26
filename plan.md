# Phase 5B.4: Mock Write E2E & Localhost Verification Plan

## 1. 目的と範囲
Phase 5B.3で完成したProduction Apply機能（Non-destructive Write、Manifest制約、WritePhase状態機械、Global Gate、Confirmation Token）が、実Child Processおよびブラウザ自動化レベルで完全に機能することを**localhost Mock Server**上でE2E検証する。

**【厳格な境界条件】**
- **新規Live Write・ed-cl.comアクセスは物理的に禁止**
- **400校Write禁止、Destructive Write禁止、Git反映禁止**
- **127.0.0.1上のローカルMock環境のみで実行**

---

## 2. 実装・検証要件

### 要件1: Mock Write E2Eの物理的Live隔離
- Playwright / Child Process実行時、`MANAPOKE_BASE_URL` をローカルMock Server（`http://127.0.0.1:<port>`）に固定。
- Mock ServerおよびE2Eテストハーネスにおいて、`127.0.0.1` / `localhost` 以外のホスト（特に `ed-cl.com`）へのアウトバウンド要求を監視。
- 万が一1件でも外部通信が発生した場合はテストを即座にFAIL（AssertionError）。

### 要件2: Apply Target Manifestによる実Child Process制約
- Preflight実行結果から生成された `applyTargetHash` を持つManifestが、実際のProduction Apply Child Process（`src/index.ts`）に正しく渡され、実処理を制約すること。
- 検証シナリオ（4校構成のMock）:
  1. `SCH001` (Non-destructive Apply Target): PreflightとBaseline一致、非破壊的変更計画あり → 実Child Processが設定変更POSTを実行し `SUCCESS`。Mock ServerへのSave POST = 1。
  2. `SCH002` (Destructive Change): Preflightで `timelineChannel -> OFF` 計画 → Manifestで `destructive` と判定され `SKIPPED_DESTRUCTIVE`。Mock ServerへのSave POST = 0。
  3. `SCH003` (Already Configured / No diff): 既に目標設定と一致 → Manifestで `no_changes` と判定され `SUCCESS_ALREADY_CONFIGURED`。Mock ServerへのSave POST = 0。
  4. `SCH004` (Baseline Changed after preflight): Preflight後に設定変更が発生した学校 → Apply実行時の事前Baseline検証で不一致検知 → `PREFLIGHT_STATE_CHANGED` でスキップ。Mock ServerへのSave POST = 0。
- Manifestの `applyTargets` 集合と、Mock Serverで実際にSave POSTを受信した学校集合が完全一致（`SCH001` のみ）することを実証。

### 要件3: SAVE_OUTCOME_UNKNOWN 故障注入E2E
- 故障注入シナリオ:
  - 特定の学校（例: `SCH_FAIL_UNKNOWN`）に対して、Save POST受信後に接続切断 / 500 / reload時502を注入。
  - 実Child Process（`applyAndVerifyProduction`）が `SAVE_OUTCOME_UNKNOWN` を判定。
  - **次校の実行が物理的に行われず即座に停止すること（Circuit Breaker発動）**。
  - 自動リトライされないこと（Saveボタン再クリック = 0）。
  - Checkpointに `SAVE_OUTCOME_UNKNOWN` が記録され、再開（Resume）時にもスキップ対象として保護されること。

---

## 3. テストファイル設計
- `test/phase5b4_mock_write_e2e.test.ts`
  - ローカルMock Server（HTTP / HTML / API）の実装
  - Test Suite 1: 物理的Live隔離テスト（外部アクセス拒絶・検知）
  - Test Suite 2: Manifest制約E2E（Non-destructiveのみSave、Destructive/Already/ChangedはSaveゼロ）
  - Test Suite 3: SAVE_OUTCOME_UNKNOWN 故障注入 & Circuit Breaker即停止E2E
- `package.json` に `test:phase5b4` スクリプトを追加
- 全既存テスト（phase5b1, phase5b2, phase5b3, console, phase3）のRegression確認
