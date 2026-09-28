import { runSchoolPhase2A } from './automation/runSchoolPhase2A';
import { runSchoolPhase2B, Phase2BOptions } from './automation/runSchoolPhase2B';
import { runSchoolProduction } from './automation/runSchoolProduction';
import { runBatch, BatchRunOptions } from './batch/runBatch';
import { loadSchoolConfigFile, loadEnvConfig } from './config/loader';
import { resolveExecutionOptions } from './config/options';

export interface CliOptions extends Phase2BOptions {
  phase?: '2A' | '2B' | 'PRODUCTION' | 'BATCH';
  batch?: boolean;
  batchApply?: boolean;
  schoolsPath?: string;
  profilePath?: string;
  credentialsPath?: string;
  preflightReportPath?: string;
  limit?: number;
  schoolCodes?: string[];
  resume?: boolean;
  retryFailed?: boolean;
  clearStaleLock?: boolean;
  deploymentId?: string;
  delayBetweenSchoolsMs?: number;
  expectedSchoolCount?: number;
  validateOnly?: boolean;
  schoolTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  profileSnapshotId?: string;
  purpose?: 'DISCOVERY' | 'FINAL_PREFLIGHT';
  finalValidationSnapshotId?: string;
  targetSnapshotId?: string;
  executionId?: string;
  summaryOutputPath?: string;
  observationOutputPath?: string;
  applyTargetHash?: string;
  concurrency?: number;
}

export function parseCliArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    allowLiveWrite: false, // デフォルトでは絶対に実環境へ書き込まない
    batchApply: false,
    schoolCodes: []
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--config' && i + 1 < args.length) {
      options.configFile = args[++i];
    } else if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--allow-destructive') {
      options.allowDestructive = true;
    } else if (arg === '--auth-mode' && i + 1 < args.length) {
      options.authMode = args[++i];
    } else if (arg === '--headless') {
      options.headless = true;
    } else if (arg === '--no-headless') {
      options.headless = false;
    } else if (arg === '--phase2b') {
      options.phase = '2B';
    } else if (arg === '--allow-live-write') {
      options.allowLiveWrite = true;
    } else if (arg === '--batch') {
      options.phase = 'BATCH';
      options.batch = true;
    } else if (arg === '--batch-apply') {
      options.batchApply = true;
    } else if (arg === '--schools' && i + 1 < args.length) {
      options.schoolsPath = args[++i];
    } else if (arg === '--profile' && i + 1 < args.length) {
      options.profilePath = args[++i];
    } else if (arg === '--credentials' && i + 1 < args.length) {
      options.credentialsPath = args[++i];
    } else if (arg === '--preflight-report' && i + 1 < args.length) {
      options.preflightReportPath = args[++i];
    } else if (arg === '--limit' && i + 1 < args.length) {
      options.limit = parseInt(args[++i], 10);
    } else if (arg === '--school-code' && i + 1 < args.length) {
      // 指示17: 複数指定可能
      options.schoolCodes!.push(args[++i]);
    } else if (arg === '--resume') {
      options.resume = true;
    } else if (arg === '--retry-failed') {
      options.retryFailed = true;
    } else if (arg === '--clear-stale-lock') {
      options.clearStaleLock = true;
    } else if (arg === '--deployment-id' && i + 1 < args.length) {
      options.deploymentId = args[++i];
    } else if (arg === '--execution-id' && i + 1 < args.length) {
      options.executionId = args[++i];
    } else if (arg === '--delay-between-schools-ms' && i + 1 < args.length) {
      options.delayBetweenSchoolsMs = parseInt(args[++i], 10);
    } else if (arg === '--expected-school-count' && i + 1 < args.length) {
      options.expectedSchoolCount = parseInt(args[++i], 10);
    } else if (arg === '--validate-only') {
      options.validateOnly = true;
    } else if (arg === '--school-timeout-ms' && i + 1 < args.length) {
      options.schoolTimeoutMs = parseInt(args[++i], 10);
    } else if (arg === '--cleanup-timeout-ms' && i + 1 < args.length) {
      options.cleanupTimeoutMs = parseInt(args[++i], 10);
    } else if (arg === '--profile-snapshot-id' && i + 1 < args.length) {
      options.profileSnapshotId = args[++i];
    } else if (arg === '--purpose' && i + 1 < args.length) {
      const p = args[++i].toUpperCase();
      options.purpose = p === 'DISCOVERY' ? 'DISCOVERY' : 'FINAL_PREFLIGHT';
    } else if (arg === '--final-validation-snapshot-id' && i + 1 < args.length) {
      options.finalValidationSnapshotId = args[++i];
    } else if (arg === '--target-snapshot-id' && i + 1 < args.length) {
      options.targetSnapshotId = args[++i];
    } else if (arg === '--summary-output' && i + 1 < args.length) {
      options.summaryOutputPath = args[++i];
    } else if (arg === '--observation-output' && i + 1 < args.length) {
      options.observationOutputPath = args[++i];
    } else if (arg === '--apply-target-hash' && i + 1 < args.length) {
      options.applyTargetHash = args[++i];
    } else if (arg === '--concurrency' && i + 1 < args.length) {
      options.concurrency = parseInt(args[++i], 10);
    } else if (arg === '--production') {
      options.phase = 'PRODUCTION';
    }
  }

  // 要件5: --purpose discovery と --profile の併用を拒否
  if (options.purpose === 'DISCOVERY' && options.profilePath) {
    throw new Error('[CONFIG_INVALID] Discoveryモード (--purpose discovery) ではプロファイル (--profile) の指定は禁止されています');
  }

  return options;
}

async function main() {
  const cliArgs = process.argv.slice(2);
  const options = parseCliArgs(cliArgs);

  if (options.phase === 'BATCH') {
    console.log('まなびポケット 学校設定 自動化ツール [Phase 3: Production Batch]');
    const envConfig = loadEnvConfig();
    const execOptions = resolveExecutionOptions(options);

    await runBatch({
      schoolsFilePath: options.schoolsPath || 'config/schools.sample.csv',
      profileFilePath: options.profilePath,
      credentialsFilePath: options.credentialsPath,
      preflightReportPath: options.preflightReportPath,
      executionOptions: execOptions,
      envConfig,
      limit: options.limit,
      targetSchoolCodes: options.schoolCodes && options.schoolCodes.length > 0 ? options.schoolCodes : undefined,
      resume: options.resume,
      retryFailed: options.retryFailed,
      clearStaleLock: options.clearStaleLock,
      deploymentId: options.deploymentId,
      executionId: options.executionId,
      pacingDelayMs: options.delayBetweenSchoolsMs,
      expectedSchoolCount: options.expectedSchoolCount,
      validateOnly: options.validateOnly,
      schoolTimeoutMs: options.schoolTimeoutMs,
      cleanupTimeoutMs: options.cleanupTimeoutMs,
      profileSnapshotId: options.profileSnapshotId,
      purpose: options.purpose,
      finalValidationSnapshotId: options.finalValidationSnapshotId,
      targetSnapshotId: options.targetSnapshotId,
      summaryOutputPath: options.summaryOutputPath,
      observationOutputPath: options.observationOutputPath,
      applyTargetHash: options.applyTargetHash,
      concurrency: options.concurrency
    });
  } else if (options.phase === 'PRODUCTION') {
    console.log('まなびポケット 学校設定 自動化ツール [Phase 3: Single Production Run]');
    const configFile = loadSchoolConfigFile(options.configFile || 'config/school.json');
    const envConfig = loadEnvConfig();
    const execOptions = resolveExecutionOptions(options);

    await runSchoolProduction({
      schoolCode: configFile.school.schoolCode,
      schoolName: configFile.school.schoolName,
      userId: envConfig.userId,
      password: envConfig.password,
      desiredSettings: configFile.settings,
      executionOptions: execOptions,
      envConfig,
      isBatchMode: false
    });
  } else if (options.phase === '2B') {
    console.log('まなびポケット 学校設定 自動化ツール [Phase 2B: Single Safe Write PoC]');
    await runSchoolPhase2B(options);
  } else {
    console.log('まなびポケット 学校設定 自動化ツール [Phase 2A: Read-only Browser Integration]');
    await runSchoolPhase2A(options);
  }
}

// CLIから直接実行された場合のみ main() を呼ぶ
if (require.main === module) {
  main().catch((err) => {
    console.error('予期せぬエラーが発生しました:', err);
    process.exit(1);
  });
}
