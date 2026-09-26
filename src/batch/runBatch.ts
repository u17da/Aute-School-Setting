import * as fs from 'fs';
import * as path from 'path';
import { BatchSchoolItem, BatchSummaryReport, CheckpointStatus, CredentialProvider, PreflightReport } from '../types/batch';
import { EffectiveExecutionOptions, RequestedSettings, AppEnvConfig } from '../types/config';
import { ExecutionResult } from '../types/plan';
import { SchoolSettingsObservation } from '../types/settings';
import { AutomationError, ExecutionStatus } from '../types/errors';
import { CheckpointManager } from './checkpoint';
import { CircuitBreaker } from './circuitBreaker';
import { BatchSummaryReporter, SchoolSummaryItem } from './summary';
import { EnvCredentialProvider, FileCredentialProvider } from './credentialProvider';
import { runSchoolProduction } from '../automation/runSchoolProduction';
import { generateSettingsHash, generateSchoolsHash, getToolVersion, generateToolFingerprint } from '../utils/hash';
import { RequestedSettingsSchema } from '../config/schema';
import { logger } from '../logger/logger';

export interface BatchRunOptions {
  schoolsFilePath: string;
  profileFilePath: string;
  credentialsFilePath?: string;
  preflightReportPath?: string;
  executionOptions: EffectiveExecutionOptions;
  envConfig: AppEnvConfig;
  limit?: number;
  targetSchoolCodes?: string[];
  resume?: boolean;
  retryFailed?: boolean;
  clearStaleLock?: boolean;
  deploymentId?: string;
  pacingDelayMs?: number;
  expectedSchoolCount?: number;
  validateOnly?: boolean;
  schoolTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}

export function parseSchoolsCsv(content: string): BatchSchoolItem[] {
  const normalizedContent = content.startsWith('\uFEFF')
    ? content.slice(1)
    : content;

  const lines = normalizedContent
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

  if (lines.length === 0) {
    throw new AutomationError('CONFIG_INVALID', '学校CSVファイルが空です');
  }

  const header = lines[0].split(',').map((h) => h.trim());
  const codeIdx = header.indexOf('schoolCode');
  const nameIdx = header.indexOf('schoolName');
  const credIdx = header.indexOf('credentialRef');
  const enabledIdx = header.indexOf('enabled');

  if (codeIdx === -1 || nameIdx === -1 || credIdx === -1) {
    throw new AutomationError(
      'CONFIG_INVALID',
      `学校CSVヘッダーに必須項目が含まれていません (schoolCode, schoolName, credentialRef が必要です): 見つかった項目=[${header.join(',')}]`
    );
  }

  const schools: BatchSchoolItem[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map((c) => c.trim());
    if (cols.length < 3) continue;

    const schoolCode = cols[codeIdx];
    const schoolName = cols[nameIdx];
    const credentialRef = cols[credIdx];
    const enabled = enabledIdx !== -1 ? cols[enabledIdx].toLowerCase() === 'true' || cols[enabledIdx] === '1' : true;

    schools.push({
      schoolCode,
      schoolName,
      credentialRef,
      enabled
    });
  }

  return schools;
}

export function validateBatchSchools(schools: BatchSchoolItem[]): void {
  const seenCodes = new Set<string>();
  for (const s of schools) {
    if (!s.schoolCode || s.schoolCode.trim() === '') {
      throw new AutomationError('BATCH_INPUT_INVALID', 'schoolCodeが空の行が存在します');
    }
    if (s.enabled) {
      if (!s.schoolName || s.schoolName.trim() === '') {
        throw new AutomationError('BATCH_INPUT_INVALID', `学校 ${s.schoolCode} の schoolName が空です`);
      }
      if (!s.credentialRef || s.credentialRef.trim() === '') {
        throw new AutomationError('BATCH_INPUT_INVALID', `学校 ${s.schoolCode} の credentialRef が空です`);
      }
      if (seenCodes.has(s.schoolCode)) {
        throw new AutomationError(
          'BATCH_INPUT_INVALID',
          `有効な学校定義内に重複するschoolCodeが存在します: ${s.schoolCode}`
        );
      }
      seenCodes.add(s.schoolCode);
    }
  }
}

export function printProductionProfile(desiredSettings: RequestedSettings): void {
  logger.info('\n================================================================');
  logger.info('                    === PRODUCTION PROFILE ===                  ');
  logger.info('================================================================');
  const allKeys: (keyof RequestedSettings)[] = [
    'storage',
    'timelineChannel',
    'directMessage',
    'parentDirectMessage',
    'allChannel',
    'parentChannel',
    'attendance',
    'contactBook',
    'mentalHealth',
    'otherSchoolLog',
    'studentPasswordChange'
  ];
  for (const k of allKeys) {
    const val = desiredSettings[k];
    if (val !== undefined && val !== null) {
      logger.info(`  ${k.padEnd(25)} : MANAGED (${val})`);
    } else {
      logger.info(`  ${k.padEnd(25)} : UNMANAGED (変更なし)`);
    }
  }
  logger.info('================================================================\n');
}

export function validateCredentialsExist(schools: BatchSchoolItem[], credentialProvider: CredentialProvider): void {
  for (const s of schools) {
    if (s.enabled) {
      if (!credentialProvider.hasCredential(s.credentialRef)) {
        throw new AutomationError(
          'CREDENTIAL_NOT_FOUND',
          `学校 ${s.schoolCode} の認証情報キー (${s.credentialRef}) が見つかりません`
        );
      }
    }
  }
}

export function loadSchoolsList(filePath: string): BatchSchoolItem[] {
  const resolvedPath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new AutomationError('CONFIG_INVALID', `学校一覧ファイルが見つかりません: ${resolvedPath}`);
  }

  const content = fs.readFileSync(resolvedPath, 'utf-8');
  let schools: BatchSchoolItem[];
  if (resolvedPath.endsWith('.json')) {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) {
      throw new AutomationError('CONFIG_INVALID', '学校JSONファイルは配列形式である必要があります');
    }
    schools = parsed as BatchSchoolItem[];
  } else {
    schools = parseSchoolsCsv(content);
  }

  validateBatchSchools(schools);
  return schools;
}

function extractObservationValues(obs?: SchoolSettingsObservation | null): Partial<Record<string, string | null>> | undefined {
  if (!obs) return undefined;
  const res: Partial<Record<string, string | null>> = {};
  for (const [k, v] of Object.entries(obs)) {
    res[k] = v.value;
  }
  return res;
}

export async function runBatch(options: BatchRunOptions): Promise<BatchSummaryReport> {
  const {
    schoolsFilePath,
    profileFilePath,
    credentialsFilePath,
    preflightReportPath,
    executionOptions,
    envConfig,
    limit,
    targetSchoolCodes,
    resume = false,
    retryFailed = false,
    clearStaleLock = false,
    deploymentId: customDeploymentId,
    pacingDelayMs = 1500,
    expectedSchoolCount
  } = options;

  logger.info('\n================================================================');
  logger.info('             PRODUCTION BATCH RUNNER INITIALIZING               ');
  logger.info('================================================================');

  // 1. プロファイル設定の読み込み & Profile Hash
  const resolvedProfilePath = path.resolve(process.cwd(), profileFilePath);
  if (!fs.existsSync(resolvedProfilePath)) {
    throw new AutomationError('CONFIG_INVALID', `プロファイル設定ファイルが見つかりません: ${resolvedProfilePath}`);
  }
  let rawJson: any;
  try {
    rawJson = JSON.parse(fs.readFileSync(resolvedProfilePath, 'utf-8'));
  } catch (e: any) {
    throw new AutomationError('CONFIG_INVALID', `プロファイル設定JSONのパースに失敗しました: ${e.message}`);
  }
  const parsedProfile = RequestedSettingsSchema.safeParse(rawJson);
  if (!parsedProfile.success) {
    throw new AutomationError(
      'CONFIG_INVALID',
      `プロファイル設定スキーマ検証エラー: ${parsedProfile.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
    );
  }
  const desiredSettings: RequestedSettings = parsedProfile.data;
  const profileHash = generateSettingsHash(desiredSettings);
  logger.info(`プロファイル設定ロード完了: ${resolvedProfilePath} (Hash: ${profileHash.substring(0, 8)})`);

  // 指示10: 実行開始時の Production Profile 可視化 (MANAGED / UNMANAGED)
  printProductionProfile(desiredSettings);

  // 2. 学校一覧のロード & Schools Hash (確定順序を保持したHash)
  const allSchools = loadSchoolsList(schoolsFilePath);
  const schoolsHash = generateSchoolsHash(allSchools);
  logger.info(`学校一覧ロード完了: 全 ${allSchools.length} 校 (Schools Hash: ${schoolsHash.substring(0, 8)})`);

  // 指示9: 想定学校数 Gate (--expected-school-count)
  if (expectedSchoolCount !== undefined) {
    const enabledCount = allSchools.filter((s) => s.enabled).length;
    if (enabledCount !== expectedSchoolCount) {
      throw new AutomationError(
        'BATCH_INPUT_INVALID',
        `有効な学校数 (${enabledCount} 校) が指定された想定学校数 (--expected-school-count ${expectedSchoolCount}) と一致しません。ブラウザ起動前に安全停止します`,
        { enabledCount, expectedSchoolCount }
      );
    }
    logger.info(`【想定学校数Gate OK】有効学校数 (${enabledCount} 校) と指定期待値 (${expectedSchoolCount} 校) が一致しました`);
  }

  // 3. CredentialProvider の初期化
  let credentialProvider: CredentialProvider;
  if (credentialsFilePath && fs.existsSync(path.resolve(process.cwd(), credentialsFilePath))) {
    credentialProvider = new FileCredentialProvider(path.resolve(process.cwd(), credentialsFilePath));
    logger.info(`CredentialProvider: FileCredentialProvider (${credentialsFilePath})`);
  } else {
    credentialProvider = new EnvCredentialProvider(envConfig.userId, envConfig.password);
    logger.info(`CredentialProvider: EnvCredentialProvider (環境変数ベース)`);
  }

  // 指示7, 8: 開始前に全対象校の credentialRef 存在チェック (ブラウザ起動前)
  validateCredentialsExist(allSchools, credentialProvider);

  // 指示10: --validate-only モードの処理（静的入力検証のみで終了）
  if (options.validateOnly) {
    const toolVersion = getToolVersion();
    const toolFingerprint = generateToolFingerprint();
    const enabledCount = allSchools.filter((s) => s.enabled).length;
    logger.info('\n================================================================');
    logger.info('              STATIC VALIDATION SUCCESSFUL (--validate-only)    ');
    logger.info('================================================================');
    logger.info(`- 学校総数: ${allSchools.length} (有効: ${enabledCount})`);
    logger.info(`- Schools Hash: ${schoolsHash}`);
    logger.info(`- Profile Hash: ${profileHash}`);
    logger.info(`- Tool Version: ${toolVersion}`);
    logger.info(`- Tool Fingerprint: ${toolFingerprint}`);
    logger.info(`- 全認証情報: 検証OK (欠損なし)`);
    logger.info('※ ブラウザおよびBrowserContextは一切起動していません (BrowserContext: 0)');
    logger.info('================================================================\n');

    const nowIso = new Date().toISOString();
    return {
      deploymentId: `validate-${profileHash.substring(0, 8)}-${schoolsHash.substring(0, 8)}`,
      runId: `validate-${Date.now()}`,
      mode: 'PREFLIGHT_DRY_RUN',
      profileHash,
      schoolsHash,
      toolVersion,
      toolFingerprint,
      startedAt: nowIso,
      finishedAt: nowIso,
      totalSchools: allSchools.length,
      processedSchools: 0,
      skippedSchools: allSchools.length,
      readSuccess: 0,
      readFailed: 0,
      loginSuccess: 0,
      loginFailed: 0,
      schoolMismatch: 0,
      uiStructureMismatch: 0,
      planExecutable: 0,
      planBlocked: 0,
      alreadyConfigured: 0,
      requiresChange: 0,
      destructiveChangeSchools: 0,
      destructiveChangeActions: 0,
      writeEligibleNonDestructive: 0,
      writeBlockedDestructive: 0,
      configConflict: 0,
      dependencyUnsatisfied: 0,
      otherErrors: 0,
      actionsDistribution: { zero: 0, one: 0, two: 0, threePlus: 0 },
      destructiveChangeDetails: [],
      currentStateDistribution: {},
      plannedChangeDistribution: {},
      circuitBreakerTrip: undefined,
      schoolResults: []
    };
  }

  // 4. モード判定および Gate チェック
  const isApply = executionOptions.apply;
  const isAllowLiveWrite = executionOptions.allowLiveWrite;
  const isBatchApply = executionOptions.batchApply;

  let mode: 'PREFLIGHT_DRY_RUN' | 'PRODUCTION_WRITE';

  if (isApply) {
    // 書き込みモード: 4重Gateチェック必須
    if (!isAllowLiveWrite || !isBatchApply) {
      throw new AutomationError(
        'UNSAFE_CONFIGURATION',
        'Batchでの本番書き込みには 4重Gate (--batch --apply --allow-live-write --batch-apply) すべての指定が必須です'
      );
    }
    mode = 'PRODUCTION_WRITE';
    logger.warn('【注意】PRODUCTION_WRITE モードで実行します（4重Gate検証完了）');

    // 指示13, 14: Preflight Report 紐づけ & 有効期限検証
    if (preflightReportPath) {
      const resolvedPfPath = path.resolve(process.cwd(), preflightReportPath);
      if (!fs.existsSync(resolvedPfPath)) {
        throw new AutomationError('CONFIG_INVALID', `指定されたPreflight Reportが見つかりません: ${resolvedPfPath}`);
      }
      const pfReport: PreflightReport = JSON.parse(fs.readFileSync(resolvedPfPath, 'utf-8'));

      if (pfReport.profileHash !== profileHash) {
        throw new AutomationError(
          'CHECKPOINT_MISMATCH',
          `Preflight ReportのProfile Hashが現在と不一致です (Preflight: ${pfReport.profileHash.substring(0, 8)}, 現在: ${profileHash.substring(0, 8)})`
        );
      }
      if (pfReport.schoolsHash !== schoolsHash) {
        throw new AutomationError(
          'CHECKPOINT_MISMATCH',
          `Preflight ReportのSchools Hashが現在と不一致です (Preflight: ${pfReport.schoolsHash.substring(0, 8)}, 現在: ${schoolsHash.substring(0, 8)})`
        );
      }

      const validUntil = new Date(pfReport.validUntil).getTime();
      if (Date.now() > validUntil) {
        throw new AutomationError(
          'UNSAFE_CONFIGURATION',
          `Preflight Reportの有効期限 (24時間) が超過しています (期限: ${pfReport.validUntil})。再Preflightを実行してください`
        );
      }
      logger.info(`【Preflight紐づけ確認OK】有効期限内のPreflight Reportと合致しました (${resolvedPfPath})`);
    }
  } else {
    // 読み取り専用 Preflight
    mode = 'PREFLIGHT_DRY_RUN';
    logger.info('【情報】PREFLIGHT_DRY_RUN モードで実行します（設定変更・保存は行いません）');
  }

  // 5. deploymentId と runId の分離 (指示6)
  const deploymentId = customDeploymentId || `deploy-${profileHash.substring(0, 8)}-${schoolsHash.substring(0, 8)}`;
  const runId = `run-${Date.now()}`;
  const toolVersion = getToolVersion();
  const toolFingerprint = generateToolFingerprint();

  // 6. CheckpointManager (排他Lock取得 & Resume整合性検証)
  const checkpoint = new CheckpointManager({
    deploymentId,
    runId,
    profileHash,
    schoolsHash,
    toolVersion,
    toolFingerprint,
    authMode: executionOptions.authMode,
    schools: allSchools,
    isResume: resume,
    clearStaleLock
  });

  const circuitBreaker = new CircuitBreaker({
    consecutiveFailureThreshold: 3,
    canaryMode: Boolean(limit && limit <= 20) // Canary実行時はSAVE_FAILED 1件で即PAUSE
  });

  const summaryReporter = new BatchSummaryReporter({
    deploymentId,
    runId,
    mode,
    profileHash,
    schoolsHash,
    toolVersion,
    toolFingerprint
  });

  // 7. Global Kill Switch & Application-level STOP protocol (stdin / SIGINT / SIGTERM)
  let isKillSwitchTriggered = false;
  let currentAbortController: AbortController | null = null;

  const triggerStop = (source: string) => {
    logger.warn(`\n【STOP COMMAND】${source} を検知しました。現在の学校処理を安全に中断し、終了します...`);
    isKillSwitchTriggered = true;
    if (currentAbortController) {
      currentAbortController.abort();
    }
  };

  const onSigInt = () => triggerStop('SIGINT / SIGTERM');
  process.on('SIGINT', onSigInt);
  process.on('SIGTERM', onSigInt);

  const onStdinData = (chunk: Buffer) => {
    const text = chunk.toString('utf-8').trim();
    if (text.includes('STOP') || text.includes('"command":"STOP"')) {
      triggerStop('Control Message (stdin)');
    }
  };
  process.stdin.on('data', onStdinData);
  if (process.stdin.unref) {
    process.stdin.unref();
  }

  try {
    // 8. 実行対象学校のフィルタリング (指示15: limit は今回の実行で処理する eligible/PENDING 学校の最大数)
    const eligibleSchools: BatchSchoolItem[] = [];
    let skippedCount = 0;

    for (const s of allSchools) {
      if (!s.enabled) {
        skippedCount++;
        continue;
      }
      // 指示17: targetSchoolCodes 複数指定フィルタ
      if (targetSchoolCodes && targetSchoolCodes.length > 0 && !targetSchoolCodes.includes(s.schoolCode)) {
        skippedCount++;
        continue;
      }

      if (resume) {
        const entry = checkpoint.getEntry(s.schoolCode);
        if (entry) {
          if (entry.status === 'SUCCESS' || entry.status === 'SUCCESS_ALREADY_CONFIGURED') {
            skippedCount++;
            continue;
          }
          if (entry.status === 'FAILED' && !retryFailed) {
            skippedCount++;
            continue;
          }
        }
      }

      eligibleSchools.push(s);
    }

    // 指示15: 今回の実行対象校 (eligibleSchools の先頭 limit 件)
    const schoolsToProcess = limit && limit > 0 ? eligibleSchools.slice(0, limit) : eligibleSchools;
    if (limit && limit > 0 && eligibleSchools.length > limit) {
      skippedCount += eligibleSchools.length - limit;
    }

    const schoolTimeoutMs = options.schoolTimeoutMs ?? 120000;
    const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 30000;
    const batchStartTime = Date.now();
    let batchSuccessCount = 0;
    let batchFailedCount = 0;

    logger.info(`実行予定: ${schoolsToProcess.length} 校 (除外・スキップ・保留: ${skippedCount} 校) [タイムアウト: ${schoolTimeoutMs}ms/校, クリーンアップ待機上限: ${cleanupTimeoutMs}ms]`);

    // 9. 順次実行ループ (concurrency = 1)
    for (let idx = 0; idx < schoolsToProcess.length; idx++) {
      const school = schoolsToProcess[idx];

      // Kill Switch チェック
      if (isKillSwitchTriggered) {
        logger.warn(`Kill Switch 発動のため、残り ${schoolsToProcess.length - idx} 校の処理を中断します`);
        break;
      }

      // Circuit Breaker チェック
      if (circuitBreaker.shouldStop()) {
        logger.error(`Circuit Breaker トリップのため、バッチループを中断します: ${circuitBreaker.getReason()}`);
        break;
      }

      // 指示11: 学校間待機時間 (Pacing Delay)
      if (idx > 0 && pacingDelayMs > 0) {
        logger.info(`【Pacing】学校間待機中 (${pacingDelayMs}ms)...`);
        await new Promise((resolve) => setTimeout(resolve, pacingDelayMs));
      }

      logger.info(`\n----------------------------------------------------------------`);
      logger.info(`[${idx + 1}/${schoolsToProcess.length}] 学校処理開始: ${school.schoolName} (${school.schoolCode})`);
      logger.info(`----------------------------------------------------------------`);

      checkpoint.startSchool(school.schoolCode);

      let isTimedOut = false;
      try {
        // 認証情報取得
        const cred = await credentialProvider.getCredential(school.credentialRef);

        // 1学校を実行 (runSchoolProduction は 1学校1Context で完全分離実行)
        const abortController = new AbortController();
        currentAbortController = abortController;
        let timeoutHandle: NodeJS.Timeout | undefined;

        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            isTimedOut = true;
            logger.warn(`[${school.schoolCode}] タイムアウト (${schoolTimeoutMs}ms) を検知しました。AbortSignalを発火してBrowserContext強制クローズとクリーンアップを待機します...`);
            abortController.abort();
            reject(new AutomationError('TIMEOUT', `学校処理がタイムアウト (${schoolTimeoutMs}ms) を超過しました`));
          }, schoolTimeoutMs);
        });

        const runPromise = runSchoolProduction({
          schoolCode: school.schoolCode,
          schoolName: school.schoolName,
          userId: cred.userId,
          password: cred.password,
          desiredSettings,
          executionOptions,
          envConfig,
          isBatchMode: true,
          signal: abortController.signal
        });

        let result: ExecutionResult;
        try {
          result = await Promise.race([runPromise, timeoutPromise]);
        } catch (raceErr: any) {
          if (isTimedOut || isKillSwitchTriggered) {
            // 指示6: タイムアウトまたはSTOP時に対象学校処理のcleanup完了を最大cleanupTimeoutMs待機する
            let cleanupTimer: NodeJS.Timeout | undefined;
            const cleanupTimeoutPromise = new Promise<never>((_, reject) => {
              cleanupTimer = setTimeout(() => {
                reject(
                  new AutomationError(
                    'CLEANUP_TIMEOUT',
                    `学校 ${school.schoolCode} のクリーンアップが上限時間 (${cleanupTimeoutMs}ms) を超過しました。非同期処理残存リスクのためバッチ全体をPAUSEします`
                  )
                );
              }, cleanupTimeoutMs);
            });

            try {
              await Promise.race([runPromise.catch(() => {}), cleanupTimeoutPromise]);
            } finally {
              if (cleanupTimer) clearTimeout(cleanupTimer);
            }
          }
          throw raceErr;
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          currentAbortController = null;
        }

        // 結果ステータスの分類
        let cpStatus: CheckpointStatus = 'FAILED';
        let effectiveExecutionStatus: ExecutionStatus = result.status;
        let effectiveError: string | undefined = result.issues.length > 0 ? result.issues.map((i) => i.message).join('; ') : undefined;

        if (isKillSwitchTriggered) {
          // Operator Stop による中断（偽エラー排除）
          cpStatus = 'INTERRUPTED';
          effectiveExecutionStatus = 'INTERRUPTED';
          effectiveError = 'Operator Stop';
        } else if (result.status === 'SUCCESS' || result.status === 'SUCCESS_RECOVERED') {
          cpStatus = 'SUCCESS';
          batchSuccessCount++;
        } else if (result.status === 'SUCCESS_ALREADY_CONFIGURED') {
          cpStatus = 'SUCCESS_ALREADY_CONFIGURED';
          batchSuccessCount++;
        } else if (result.status === 'DRY_RUN_COMPLETED') {
          cpStatus = (result.executionPlan?.actions.length ?? 0) === 0 ? 'SUCCESS_ALREADY_CONFIGURED' : 'SUCCESS';
          batchSuccessCount++;
        } else {
          batchFailedCount++;
        }

        // Checkpoint 記録 (Atomic Write)
        checkpoint.finishSchool({
          schoolCode: school.schoolCode,
          status: cpStatus,
          executionStatus: effectiveExecutionStatus,
          actionsCount: result.executionPlan?.actions.length,
          hasDestructiveChanges: result.executionPlan?.hasDestructiveChanges,
          error: effectiveError,
          resultLogPath: undefined
        });

        // Circuit Breaker 記録 (重大度別 - 中断時はカウントしない)
        if (!isKillSwitchTriggered) {
          circuitBreaker.recordResult(result.status, school.schoolCode, mode);
        }

        const isOk = !isKillSwitchTriggered && (
          result.status === 'DRY_RUN_COMPLETED' ||
          result.status === 'SUCCESS' ||
          result.status === 'SUCCESS_ALREADY_CONFIGURED'
        );
        const isPlanBlocked =
          result.status === 'CONFIG_CONFLICT' ||
          result.status === 'DEPENDENCY_UNSATISFIED' ||
          result.status === 'PRE_SAVE_VALIDATION_FAILED';

        // Summary 記録
        const summaryItem: SchoolSummaryItem = {
          schoolCode: school.schoolCode,
          schoolName: school.schoolName,
          status: cpStatus,
          executionStatus: effectiveExecutionStatus,
          actionsCount: result.executionPlan?.actions.length,
          hasDestructiveChanges: result.executionPlan?.hasDestructiveChanges,
          planExecutable: isOk && !isPlanBlocked,
          before: extractObservationValues(result.beforeObservation),
          requested: desiredSettings,
          after: extractObservationValues(result.afterObservation),
          error: effectiveError
        };
        summaryReporter.addSchoolResult(summaryItem);

        const elapsedSec = ((Date.now() - batchStartTime) / 1000).toFixed(1);
        const remaining = schoolsToProcess.length - (idx + 1);
        logger.info(
          `[${idx + 1}/${schoolsToProcess.length}] ${school.schoolCode} - ${cpStatus} (経過: ${elapsedSec}s, 成功: ${batchSuccessCount}, 失敗: ${batchFailedCount}, 残り: ${remaining})`
        );

        if (isKillSwitchTriggered) {
          logger.warn(`【安全停止】STOP要求を受信したため、学校 ${school.schoolCode} を INTERRUPTED として記録し、次校への処理を停止します`);
          break;
        }

      } catch (err: any) {
        const elapsedSec = ((Date.now() - batchStartTime) / 1000).toFixed(1);
        const remaining = schoolsToProcess.length - (idx + 1);

        const isInterrupted = isKillSwitchTriggered;
        // 指示9: schoolTimeout発生時は、内部例外で上書きせず primaryStatus = TIMEOUT を維持
        // ただし cleanupTimeout 超過時は CLEANUP_TIMEOUT へ昇格、STOP要求時は INTERRUPTED
        const finalStatus: ExecutionStatus =
          err.status === 'CLEANUP_TIMEOUT'
            ? 'CLEANUP_TIMEOUT'
            : isTimedOut
            ? 'TIMEOUT'
            : isInterrupted
            ? 'INTERRUPTED'
            : err.status || 'UNEXPECTED_ERROR';

        if (!isInterrupted) {
          batchFailedCount++;
        }

        const errorMessage = isInterrupted ? 'Operator Stop' : err.message;
        logger.error(`[${school.schoolCode}] 実行中断/エラー (${finalStatus}): ${errorMessage}`);
        logger.error(
          `[${idx + 1}/${schoolsToProcess.length}] ${school.schoolCode} - ${isInterrupted ? 'INTERRUPTED' : 'FAILED'} [${finalStatus}] (経過: ${elapsedSec}s, 成功: ${batchSuccessCount}, 失敗: ${batchFailedCount}, 残り: ${remaining})`
        );

        if (finalStatus !== 'CHECKPOINT_IO_ERROR') {
          checkpoint.finishSchool({
            schoolCode: school.schoolCode,
            status: isInterrupted ? 'INTERRUPTED' : 'FAILED',
            executionStatus: finalStatus,
            error: errorMessage
          });
        }
        if (!isInterrupted) {
          circuitBreaker.recordResult(finalStatus, school.schoolCode, mode);
        }
        summaryReporter.addSchoolResult({
          schoolCode: school.schoolCode,
          schoolName: school.schoolName,
          status: isInterrupted ? 'INTERRUPTED' : 'FAILED',
          executionStatus: finalStatus,
          planExecutable: false,
          error: errorMessage
        });

        // 指示7, 8 & Phase 5A.1: CLEANUP_TIMEOUT または CHECKPOINT_IO_ERROR または STOP時は即座にループ脱出・次校禁止
        if (finalStatus === 'CLEANUP_TIMEOUT' || finalStatus === 'CHECKPOINT_IO_ERROR' || isInterrupted) {
          logger.warn(`【安全停止】${finalStatus} が発生したため、次校への処理を完全停止します`);
          break;
        }
      }
    }

    // 全処理終了判定
    if (!isKillSwitchTriggered && !circuitBreaker.shouldStop() && eligibleSchools.length <= schoolsToProcess.length) {
      checkpoint.markBatchCompleted();
    }

    // 10. 集計サマリレポートの生成・出力
    const report = summaryReporter.generateReport({
      totalSchools: allSchools.length,
      skippedSchools: skippedCount,
      circuitBreakerTrip: circuitBreaker.getTripInfo(),
      isInterrupted: isKillSwitchTriggered,
      allSchools
    });

    return report;

  } finally {
    process.removeListener('SIGINT', onSigInt);
    process.removeListener('SIGTERM', onSigInt);
    process.stdin.removeListener('data', onStdinData);
    if (process.stdin.pause) {
      process.stdin.pause();
    }
    // 指示8: Lock解放
    checkpoint.releaseLock();
  }
}
