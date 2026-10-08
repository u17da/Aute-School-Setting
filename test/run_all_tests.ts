import { spawnSync } from 'child_process';
import * as path from 'path';
import { auditAllTestFiles, TEST_MANIFEST, TestCategory } from './test_manifest';

const args = process.argv.slice(2);
const isManifestMode = args.includes('--manifest');
const categoryArg = args.find(a => a.startsWith('--category='))?.split('=')[1] || 'A';

console.log('================================================================');
console.log('       MANAPOKE TEST RUNNER & SILENT EXCLUSION AUDITOR          ');
console.log('================================================================\n');

// 1. Silent Exclusion 0 検証 (リポジトリ内の全テストファイル再帰スキャン)
const testRootDir = path.resolve(__dirname);
const audit = auditAllTestFiles(testRootDir);

console.log(`[AUDIT] リポジトリ内テストファイル総数: ${audit.totalFound} 件`);
console.log(`[AUDIT] マニフェスト登録テストファイル数: ${Object.keys(TEST_MANIFEST).length} 件`);

if (audit.unclassified.length > 0) {
  console.error('\n[CRITICAL ERROR] SILENT EXCLUSION DETECTED:');
  console.error('以下のテストファイルが test_manifest.ts に分類登録されていません:');
  for (const u of audit.unclassified) {
    console.error(`  - ${u}`);
  }
  console.error('すべてのテストファイルは Category A / B / C のいずれかに明示分類される必要があります。');
  process.exit(1);
}
console.log('[AUDIT] 検証成功: Silent Exclusion = 0 件 (すべてのテストが分類済み)\n');

// 2. マニフェスト一覧表示モード
if (isManifestMode) {
  console.log('--- [TEST MANIFEST LIST] ---');
  const entries = Object.values(TEST_MANIFEST);
  for (const cat of ['A_DEFAULT_REGRESSION', 'B_EXTENDED_REGRESSION', 'C_SPECIAL_OR_E2E'] as TestCategory[]) {
    console.log(`\n【Category: ${cat}】`);
    const catEntries = entries.filter(e => e.category === cat);
    for (const e of catEntries) {
      console.log(`  * ${e.filePath}`);
      console.log(`      タイトル: ${e.title}`);
      console.log(`      実行条件: ${e.runCondition}`);
    }
  }
  process.exit(0);
}

// 3. 実行対象ファイルの選定
let targetCategories: TestCategory[] = [];
if (categoryArg.toUpperCase() === 'A' || categoryArg.toUpperCase() === 'DEFAULT') {
  targetCategories = ['A_DEFAULT_REGRESSION'];
  console.log('実行モード: [Category A] Default Regression (毎回安全・高速に実行可能なテスト群)');
} else if (categoryArg.toUpperCase() === 'B' || categoryArg.toUpperCase() === 'EXTENDED') {
  targetCategories = ['B_EXTENDED_REGRESSION'];
  console.log('実行モード: [Category B] Extended Regression (モック・拡張回帰テスト群)');
} else if (categoryArg.toUpperCase() === 'FULL') {
  targetCategories = ['A_DEFAULT_REGRESSION', 'B_EXTENDED_REGRESSION'];
  console.log('実行モード: [Full Regression] Category A + B (全回帰テストスイート)');
} else {
  console.error(`[ERROR] 不正なカテゴリ引数です: ${categoryArg} (指定可能値: A, B, full)`);
  process.exit(1);
}

const targetEntries = Object.values(TEST_MANIFEST).filter(e => targetCategories.includes(e.category));
console.log(`実行対象テストスイート数: ${targetEntries.length} 件\n`);

const tsNodeBin = path.resolve(__dirname, '../node_modules/ts-node/dist/bin.js');
let failedCount = 0;
let passedCount = 0;

for (let i = 0; i < targetEntries.length; i++) {
  const entry = targetEntries[i];
  const fullPath = path.resolve(process.cwd(), entry.filePath);
  console.log(`----------------------------------------------------------------`);
  console.log(`[${i + 1}/${targetEntries.length}] Executing: ${entry.filePath}`);
  console.log(`    タイトル: ${entry.title}`);
  console.log(`----------------------------------------------------------------`);

  const result = spawnSync(process.execPath, [tsNodeBin, '-T', fullPath], {
    stdio: 'inherit',
    cwd: process.cwd()
  });

  if (result.status !== 0) {
    console.error(`\n[TEST-RUNNER] >>> FAILED: ${entry.filePath} (exit code: ${result.status}) <<<\n`);
    failedCount++;
    break; // フェイルクローズ: 1件でも失敗したら即時停止
  } else {
    console.log(`\n[TEST-RUNNER] >>> PASSED: ${entry.filePath} <<<\n`);
    passedCount++;
  }
}

console.log('================================================================');
if (failedCount > 0) {
  console.error(`[RESULT] テストスイート失敗: 成功 ${passedCount} 件 / 失敗 ${failedCount} 件`);
  process.exit(1);
} else {
  console.log(`[RESULT] 全 ${passedCount} テストスイートが 100% 成功しました！`);
  console.log('================================================================');
  process.exit(0);
}
