import * as path from 'path';
import * as fs from 'fs';

export type TestCategory = 'A_DEFAULT_REGRESSION' | 'B_EXTENDED_REGRESSION' | 'C_SPECIAL_OR_E2E';

export interface TestManifestEntry {
  filePath: string;
  category: TestCategory;
  title: string;
  description: string;
  runCondition: string;
}

export const TEST_MANIFEST: Record<string, TestManifestEntry> = {
  // =========================================================================
  // Category A: Default Regression (毎回安全に高速実行可能、副作用なし、決定論的)
  // =========================================================================
  'test/phase1.test.ts': {
    filePath: 'test/phase1.test.ts',
    category: 'A_DEFAULT_REGRESSION',
    title: 'Phase 1 設定・スキーマ単体テスト',
    description: '設定ファイルの読み込み、環境変数、バリデーションロジックの単体テスト',
    runCondition: '毎回実行可能 (副作用なし・高速)'
  },
  'test/phase2a.test.ts': {
    filePath: 'test/phase2a.test.ts',
    category: 'A_DEFAULT_REGRESSION',
    title: 'Phase 2a ナビゲーション・ドライラン単体テスト',
    description: '画面遷移、ナビゲーション、設定読み取りロジックの単体テスト',
    runCondition: '毎回実行可能 (副作用なし・高速)'
  },
  'test/phase2b.test.ts': {
    filePath: 'test/phase2b.test.ts',
    category: 'A_DEFAULT_REGRESSION',
    title: 'Phase 2b 設定変更単体テスト',
    description: '学校設定変更の計画策定と差分計算ロジックの単体テスト',
    runCondition: '毎回実行可能 (副作用なし・高速)'
  },
  'test/console.test.ts': {
    filePath: 'test/console.test.ts',
    category: 'A_DEFAULT_REGRESSION',
    title: 'Webコンソール API/UI 単体テスト',
    description: 'ローカルHTTPサーバーによるWebコンソールのAPIルーティング・CSRF検証テスト',
    runCondition: '毎回実行可能 (ローカルポート使用・高速)'
  },
  'test/login_verification_flow.test.ts': {
    filePath: 'test/login_verification_flow.test.ts',
    category: 'A_DEFAULT_REGRESSION',
    title: 'ログイン3段階判定・回帰テスト (Case 1〜6)',
    description: 'Promise.any早期シグナル、待機型verifyAuthenticatedHome、Deadline管理、学校identity検証の実ブラウザ結合テスト',
    runCondition: '毎回実行可能 (ローカルモックHTTP + Playwright)'
  },
  'test/execution_results_normalizer.test.ts': {
    filePath: 'test/execution_results_normalizer.test.ts',
    category: 'A_DEFAULT_REGRESSION',
    title: '実行結果正規化単体テスト',
    description: 'バッチ実行結果のサマリー集計および正規化処理の単体テスト',
    runCondition: '毎回実行可能 (副作用なし・高速)'
  },
  'test/gradeClassParser.test.ts': {
    filePath: 'test/gradeClassParser.test.ts',
    category: 'A_DEFAULT_REGRESSION',
    title: '学年・クラスCSVパーサー単体テスト',
    description: '学年・クラス構成CSVの構文解析と学校種別判定の単体テスト',
    runCondition: '毎回実行可能 (副作用なし・高速)'
  },
  'test/phase6a_state_model.test.ts': {
    filePath: 'test/phase6a_state_model.test.ts',
    category: 'A_DEFAULT_REGRESSION',
    title: 'Phase 6A 状態モデル単体テスト',
    description: '状態遷移マシンおよびライフサイクル不変条件の単体テスト',
    runCondition: '毎回実行可能 (副作用なし・高速)'
  },
  'test/phase6a_workflow.test.ts': {
    filePath: 'test/phase6a_workflow.test.ts',
    category: 'A_DEFAULT_REGRESSION',
    title: 'Phase 6A ワークフロー単体テスト',
    description: 'Preflightから本番適用への段階的ワークフロー遷移の単体テスト',
    runCondition: '毎回実行可能 (副作用なし・高速)'
  },
  'test/phase6b_destructive_apply.test.ts': {
    filePath: 'test/phase6b_destructive_apply.test.ts',
    category: 'A_DEFAULT_REGRESSION',
    title: 'Phase 6B 破壊的変更ゲート単体テスト',
    description: '破壊的変更の検知、ポリシー評価、確認トークン検証の単体テスト',
    runCondition: '毎回実行可能 (副作用なし・高速)'
  },
  'test/runtime_lifecycle_hardening.test.ts': {
    filePath: 'test/runtime_lifecycle_hardening.test.ts',
    category: 'A_DEFAULT_REGRESSION',
    title: 'ランタイムライフサイクル堅牢化単体テスト',
    description: 'プロセス中断、シグナルハンドリング、リカバリーの単体テスト',
    runCondition: '毎回実行可能 (副作用なし・高速)'
  },
  'test/platform/platform_core.test.ts': {
    filePath: 'test/platform/platform_core.test.ts',
    category: 'A_DEFAULT_REGRESSION',
    title: 'Platform Core 基盤・ポリシー・暗号単体テスト',
    description: 'クレデンシャル境界マスク、ターゲット解釈、ポリシーエンジン、見積もりの単体テスト',
    runCondition: '毎回実行可能 (副作用なし・高速)'
  },
  'test/platform/platform_claude_autonomous_planner.test.ts': {
    filePath: 'test/platform/platform_claude_autonomous_planner.test.ts',
    category: 'A_DEFAULT_REGRESSION',
    title: 'Claude Autonomous Planner 単体テスト',
    description: 'Fail-Closed動作、Dynamic Schema、モックによる各種計画立案シナリオの単体テスト',
    runCondition: '毎回実行可能 (モックLLM使用・高速)'
  },
  'test/platform/platform_interactive_planner_and_session.test.ts': {
    filePath: 'test/platform/platform_interactive_planner_and_session.test.ts',
    category: 'A_DEFAULT_REGRESSION',
    title: '対話型プランナー & セッション整合性テスト',
    description: 'PlanDiff算出、対話的再計画、動的検証スコープ評価の単体テスト',
    runCondition: '毎回実行可能 (モックLLM使用・高速)'
  },
  'test/platform/platform_safety_invariants.test.ts': {
    filePath: 'test/platform/platform_safety_invariants.test.ts',
    category: 'A_DEFAULT_REGRESSION',
    title: 'Platform 安全性不変条件 & アーキテクチャ検証テスト (44件)',
    description: 'JobExecutionMode厳密検証、TargetScope、物理遮断、RunEvidence、SecretVault、Capability監査、緊急停止等の不変条件テスト',
    runCondition: '毎回実行可能 (副作用なし・高速)'
  },
  'test/platform/platform_e2e_acceptance.test.ts': {
    filePath: 'test/platform/platform_e2e_acceptance.test.ts',
    category: 'A_DEFAULT_REGRESSION',
    title: 'Platform 受入テスト (Core API & 境界監査)',
    description: 'マルチフォーマット入力、クレデンシャル境界、Capabilityバインディングの受入テスト',
    runCondition: '毎回実行可能 (外部副作用なし)'
  },

  // =========================================================================
  // Category B: Extended Regression (時間はかかるが外部実環境を変更せず安全に実行可能)
  // =========================================================================
  'test/phase3.test.ts': {
    filePath: 'test/phase3.test.ts',
    category: 'B_EXTENDED_REGRESSION',
    title: 'Phase 3 バッチ・サーキットブレーカー大規模テスト (75件)',
    description: 'バッチ実行、チェックポイント、リトライ、サーキットブレーカーの大規模モックテスト',
    runCondition: '長時間実行テスト (モック実行・副作用なし)'
  },
  'test/direct_apply_skip_preflight.test.ts': {
    filePath: 'test/direct_apply_skip_preflight.test.ts',
    category: 'B_EXTENDED_REGRESSION',
    title: 'ダイレクト適用・事前検証スキップテスト',
    description: '事前検証をスキップして直接適用する場合のポリシーガードテスト',
    runCondition: '拡張回帰テスト (副作用なし)'
  },
  'test/windows_fs_stress.test.ts': {
    filePath: 'test/windows_fs_stress.test.ts',
    category: 'B_EXTENDED_REGRESSION',
    title: 'Windows ファイルシステム並行I/O ストレステスト',
    description: '100同時書き込みと並行読み込みによるファイルロック・耐久テスト',
    runCondition: '拡張回帰テスト (高負荷I/O)'
  },
  'test/phase5b1_profile_editor.test.ts': {
    filePath: 'test/phase5b1_profile_editor.test.ts',
    category: 'B_EXTENDED_REGRESSION',
    title: 'Phase 5B.1 プロファイルエディタ・スナップショットテスト',
    description: 'プロファイルの動的編集とスナップショット無効化の結合テスト',
    runCondition: '結合テスト (副作用なし)'
  },

  // =========================================================================
  // Category C: E2E / GUI / Stress / Production-risk / Special (実環境、GUI、実データ、長時間等)
  // =========================================================================
  'test/phase5b4_gui_mock_smoke.test.ts': {
    filePath: 'test/phase5b4_gui_mock_smoke.test.ts',
    category: 'C_SPECIAL_OR_E2E',
    title: 'Phase 5B.4 GUIモックスモークテスト',
    description: 'WebコンソールGUIの実ブラウザUIモック操作スモークテスト (レガシーコンソールUI依存)',
    runCondition: 'Playwright GUIテスト (レガシー画面)'
  },
  'test/phase5b4_mock_write_e2e.test.ts': {
    filePath: 'test/phase5b4_mock_write_e2e.test.ts',
    category: 'C_SPECIAL_OR_E2E',
    title: 'Phase 5B.4 モック書き込みE2Eテスト',
    description: 'モックサーバーに対する書き込み適用・成果物生成の結合テスト',
    runCondition: 'E2Eモックテスト (所要時間 >30秒)'
  },
  'test/stress_mock_400.test.ts': {
    filePath: 'test/stress_mock_400.test.ts',
    category: 'C_SPECIAL_OR_E2E',
    title: '400校モック耐久・長時間ストレステスト',
    description: '400校規模のモック実行によるメモリ・ファイルディスクリプタ・耐久性検証',
    runCondition: '長時間ストレステスト (>1分〜数分)'
  },
  'test/platform/platform_browser_acceptance.test.ts': {
    filePath: 'test/platform/platform_browser_acceptance.test.ts',
    category: 'C_SPECIAL_OR_E2E',
    title: 'Platform 実ブラウザUI受入テスト',
    description: 'Webコンソールの実ブラウザ操作による3ステップUIの結合受入テスト',
    runCondition: '実ブラウザUI操作 + ANTHROPIC_API_KEY 環境'
  },
  'test/platform/platform_e2e_scenario.test.ts': {
    filePath: 'test/platform/platform_e2e_scenario.test.ts',
    category: 'C_SPECIAL_OR_E2E',
    title: 'Platform E2E シナリオテスト (全自動パイプライン)',
    description: 'DryRun -> Canary -> FullProduction のフルパイプライン自律実行シナリオテスト',
    runCondition: '実ブラウザ + ANTHROPIC_API_KEY 環境'
  },
  'test/portable_package.test.ts': {
    filePath: 'test/portable_package.test.ts',
    category: 'C_SPECIAL_OR_E2E',
    title: 'Windows ポータブルパッケージ検証テスト',
    description: 'package:win で生成された配布用ZIPおよびスタンドアロン実行バイナリの検証',
    runCondition: '事前ビルド成果物 (dist-package/) が必要'
  },
  'test/validateProductionCsv.test.ts': {
    filePath: 'test/validateProductionCsv.test.ts',
    category: 'C_SPECIAL_OR_E2E',
    title: '本番実CSVバリデーションテスト',
    description: '実運用環境の学年クラスデータ (production_grades_classes_raw.csv) の整合性検証',
    runCondition: '機密実データ (data/配下) が必要'
  },
  'test/upload_csv.test.ts': {
    filePath: 'test/upload_csv.test.ts',
    category: 'C_SPECIAL_OR_E2E',
    title: 'CSVアップロード統合テスト',
    description: 'CSVアップロード時のバリデーションおよびクレデンシャルマスクの結合テスト',
    runCondition: 'アップロードサーバー結合テスト'
  },
  'test/discovery_concurrency.test.ts': {
    filePath: 'test/discovery_concurrency.test.ts',
    category: 'C_SPECIAL_OR_E2E',
    title: 'マルチセッション Discovery 並行性テスト',
    description: '実学校データを用いた並行探索処理のテスト',
    runCondition: '本番学校データ (schools.live.csv) が必要 (セーフティガード対象)'
  },
  'test/phase5b2_manifest_and_outcomes.test.ts': {
    filePath: 'test/phase5b2_manifest_and_outcomes.test.ts',
    category: 'C_SPECIAL_OR_E2E',
    title: 'Phase 5B.2 マニフェスト・本番検証テスト',
    description: 'マニフェスト導出と本番書き込みセーフティの結合テスト',
    runCondition: '本番学校データ (schools.live.csv) が必要'
  },
  'test/phase5b3_production_apply.test.ts': {
    filePath: 'test/phase5b3_production_apply.test.ts',
    category: 'C_SPECIAL_OR_E2E',
    title: 'Phase 5B.3 本番書き込み適用テスト',
    description: '本番適用プロセス起動・ワンタイムトークン消費の結合テスト',
    runCondition: '本番学校データ (schools.live.csv) が必要'
  }
};

/**
 * リポジトリ内のすべてのテストファイルをスキャンし、マニフェスト未登録のファイルがないか検証する
 */
export function auditAllTestFiles(testRootDir: string): {
  totalFound: number;
  unclassified: string[];
  manifest: Record<string, TestManifestEntry>;
} {
  const allTestFiles: string[] = [];

  function scanDir(dir: string) {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      const fullPath = path.join(dir, f);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        scanDir(fullPath);
      } else if (f.endsWith('.test.ts') || f.endsWith('.spec.ts')) {
        const rel = path.relative(process.cwd(), fullPath).replace(/\\/g, '/');
        allTestFiles.push(rel);
      }
    }
  }

  scanDir(testRootDir);

  const unclassified = allTestFiles.filter((f) => !TEST_MANIFEST[f]);

  return {
    totalFound: allTestFiles.length,
    unclassified,
    manifest: TEST_MANIFEST
  };
}
