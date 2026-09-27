import * as fs from 'fs';
import * as path from 'path';
import { ExecutionPlan, ExecutionPlanEvaluation, ExecutionResult } from '../types/plan';
import { SettingKey } from '../types/settings';
import { SETTING_DEFINITIONS } from '../settings/definitions';
import { getLogsDir } from '../runtime/paths';

export class Logger {
  private logDir: string;

  constructor() {
    this.logDir = getLogsDir();
  }

  info(msg: string) {
    console.log(`[INFO] ${msg}`);
  }

  warn(msg: string) {
    console.warn(`[WARN] ${msg}`);
  }

  error(msg: string) {
    console.error(`[ERROR] ${msg}`);
  }

  /**
   * Dry Run 用のフォーマット出力（要求1に準拠: ログイン・読取は行い、UI変更・保存のみを行わない旨を明記）
   */
  printDryRunPlan(
    plan: ExecutionPlan,
    evaluation: ExecutionPlanEvaluation,
    allowDestructive: boolean
  ) {
    console.log('\n================================================');
    console.log('まなびポケット 学校設定 PoC [DRY RUN]');
    console.log('※設定変更および保存処理は一切行いませんでした');
    console.log('================================================');
    console.log(`学校コード: ${plan.schoolCode}`);
    console.log(`学校名    : ${plan.schoolName}`);
    console.log('------------------------------------------------');
    console.log('【設定項目一覧と評価】');

    for (const [key, item] of Object.entries(plan.items) as [SettingKey, any][]) {
      const def = SETTING_DEFINITIONS[key];
      const curStr = item.current.availability === 'CONTRACT_NOT_AVAILABLE'
        ? '(契約外非表示)'
        : String(item.current.value ?? '(未設定)');
      const reqStr = item.requested === null ? '(変更なし)' : String(item.requested);
      const expStr = item.expected.availability === 'CONTRACT_NOT_AVAILABLE'
        ? '(契約外非表示)'
        : String(item.expected.value ?? '(未設定)');
      const reasonStr = `[${item.reason}]`;
      const isChanged = item.current.value !== item.expected.value;
      const changeMark = isChanged ? '=> ' : '   ';

      console.log(
        `${changeMark}${def.label.padEnd(24, ' ')} 現在: ${curStr.padEnd(16, ' ')} 要求: ${reqStr.padEnd(12, ' ')} 期待: ${expStr.padEnd(12, ' ')} ${reasonStr}`
      );

      if (item.isDestructive) {
        console.log(`     ⚠️  破壊的変更: ${item.destructiveWarning}`);
      }
    }

    console.log('------------------------------------------------');
    console.log('【直接操作される設定 (Actions)】');
    if (plan.actions.length === 0) {
      console.log('  直接変更が必要な項目はありません');
    } else {
      for (const action of plan.actions) {
        console.log(`  Step ${action.order}: [${action.label}] ${action.from ?? '(なし)'} -> ${action.to}`);
      }
    }

    console.log('------------------------------------------------');
    console.log('【依存関係により自動連動する設定 (Dependency Effects)】');
    if (plan.dependencyEffects.length === 0) {
      console.log('  依存関係による自動連動はありません');
    } else {
      for (const effect of plan.dependencyEffects) {
        console.log(`  - [${effect.targetLabel}] ${effect.beforeValue ?? '(なし)'} -> ${effect.expectedValue} (${effect.rule})`);
      }
    }

    if (plan.warnings.length > 0) {
      console.log('------------------------------------------------');
      console.log('【警告事項】');
      for (const w of plan.warnings) {
        console.log(`  ! WARNING: ${w}`);
      }
    }

    console.log('------------------------------------------------');
    console.log(`破壊的変更の許可設定 (--allow-destructive): ${allowDestructive}`);
    if (evaluation.requiresDestructiveConfirmation && !allowDestructive) {
      console.log('  -> 破壊的変更が含まれており、本番実行には --allow-destructive が必要です。');
    }
    if (!evaluation.isExecutable) {
      console.log('  -> 実行不可判定 (ブロック理由あり):');
      for (const issue of evaluation.blockReasons) {
        console.log(`     - [${issue.code}] ${issue.message}`);
      }
    }

    console.log('================================================\nDRY RUNのため設定変更および保存は行いませんでした。\n');
  }

  saveResultLog(result: ExecutionResult): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const codePart = result.schoolCode ? `-${result.schoolCode}` : '-init';
    const filename = `result${codePart}-${timestamp}.json`;
    const filePath = path.join(this.logDir, filename);

    fs.writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf-8');
    this.info(`実行結果ログを保存しました: ${filePath}`);
    return filePath;
  }
}

export const logger = new Logger();
