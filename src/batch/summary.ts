import * as fs from 'fs';
import * as path from 'path';
import {
  BatchSummaryReport,
  ActionsDistribution,
  CheckpointStatus,
  CircuitBreakerTripInfo,
  PreflightReport,
  DestructiveChangeDetail,
  BatchSchoolItem,
  PreflightStatus,
  PreflightSchoolResult
} from '../types/batch';
import { ExecutionStatus } from '../types/errors';
import { logger } from '../logger/logger';

export interface SchoolSummaryItem {
  schoolCode: string;
  schoolName: string;
  status: CheckpointStatus;
  executionStatus?: ExecutionStatus;
  actionsCount?: number;
  hasDestructiveChanges?: boolean;
  planExecutable?: boolean;
  before?: Partial<Record<string, string | null>>;
  requested?: Partial<Record<string, string | null>>;
  after?: Partial<Record<string, string | null>>;
  error?: string;
}

export interface SummaryReporterOptions {
  deploymentId: string;
  runId: string;
  mode: 'PREFLIGHT_DRY_RUN' | 'PRODUCTION_WRITE';
  profileHash: string;
  schoolsHash: string;
  toolVersion: string;
  toolFingerprint?: string;
}

export class BatchSummaryReporter {
  private deploymentId: string;
  private runId: string;
  private mode: 'PREFLIGHT_DRY_RUN' | 'PRODUCTION_WRITE';
  private profileHash: string;
  private schoolsHash: string;
  private toolVersion: string;
  private toolFingerprint?: string;
  private startedAt: string;
  private reportsDir: string;
  private schoolResults: SchoolSummaryItem[] = [];

  constructor(options: SummaryReporterOptions) {
    this.deploymentId = options.deploymentId;
    this.runId = options.runId;
    this.mode = options.mode;
    this.profileHash = options.profileHash;
    this.schoolsHash = options.schoolsHash;
    this.toolVersion = options.toolVersion;
    this.toolFingerprint = options.toolFingerprint;
    this.startedAt = new Date().toISOString();
    this.reportsDir = path.resolve(process.cwd(), 'reports');
    if (!fs.existsSync(this.reportsDir)) {
      fs.mkdirSync(this.reportsDir, { recursive: true });
    }
  }

  addSchoolResult(result: SchoolSummaryItem): void {
    this.schoolResults.push(result);
  }

  generateReport(params: {
    totalSchools: number;
    skippedSchools: number;
    circuitBreakerTrip?: CircuitBreakerTripInfo | null;
    isInterrupted?: boolean;
    allSchools?: BatchSchoolItem[];
  }): BatchSummaryReport {
    const { totalSchools, skippedSchools, circuitBreakerTrip, isInterrupted, allSchools } = params;
    const finishedAt = new Date().toISOString();

    let readSuccess = 0;
    let readFailed = 0;
    let loginSuccess = 0;
    let loginFailed = 0;
    let schoolMismatch = 0;
    let uiStructureMismatch = 0;
    let planExecutable = 0;
    let planBlocked = 0;
    let alreadyConfigured = 0;
    let requiresChange = 0;
    let destructiveChangeSchools = 0;
    let destructiveChangeActions = 0;
    let writeEligibleNonDestructive = 0;
    let writeBlockedDestructive = 0;
    let configConflict = 0;
    let dependencyUnsatisfied = 0;
    let otherErrors = 0;

    const actionsDistribution: ActionsDistribution = {
      zero: 0,
      one: 0,
      two: 0,
      threePlus: 0
    };

    const destructiveChangeDetails: DestructiveChangeDetail[] = [];
    const currentStateDistribution: Record<string, Record<string, number>> = {};
    const plannedChangeDistribution: Record<string, Record<string, number>> = {};

    const allKeys = [
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
      currentStateDistribution[k] = {};
      plannedChangeDistribution[k] = {};
    }

    for (const res of this.schoolResults) {
      const execStatus = res.executionStatus;

      // 読取成否の集計（CONFIG_CONFLICT等、画面読取後にPlan評価でブロックされたものもRead自体は成功）
      const isReadOk =
        execStatus === 'DRY_RUN_COMPLETED' ||
        res.status === 'SUCCESS' ||
        res.status === 'SUCCESS_ALREADY_CONFIGURED' ||
        execStatus === 'CONFIG_CONFLICT' ||
        execStatus === 'DEPENDENCY_UNSATISFIED' ||
        execStatus === 'SETTING_NOT_AVAILABLE' ||
        execStatus === 'PRE_SAVE_VALIDATION_FAILED';

      const isInterruptedSchool = res.status === 'INTERRUPTED' || execStatus === 'INTERRUPTED';

      if (isReadOk) {
        readSuccess++;
      } else if (!isInterruptedSchool) {
        readFailed++;
      }

      // ログイン成否の集計
      if (execStatus === 'LOGIN_FAILED') {
        loginFailed++;
      } else if (execStatus && execStatus !== 'CONFIG_INVALID' && execStatus !== 'CLI_ARGUMENT_ERROR' && execStatus !== 'CREDENTIAL_NOT_FOUND') {
        loginSuccess++;
      }

      // エラー種別の集計
      if (execStatus === 'SCHOOL_MISMATCH') {
        schoolMismatch++;
      } else if (execStatus === 'UI_STRUCTURE_MISMATCH') {
        uiStructureMismatch++;
      } else if (execStatus === 'CONFIG_CONFLICT') {
        configConflict++;
      } else if (execStatus === 'DEPENDENCY_UNSATISFIED') {
        dependencyUnsatisfied++;
      } else if (res.status === 'FAILED' && execStatus !== 'LOGIN_FAILED') {
        otherErrors++;
      }

      // 実行可能 / ブロックの判定
      if (isReadOk) {
        const isBlocked =
          res.planExecutable === false ||
          execStatus === 'CONFIG_CONFLICT' ||
          execStatus === 'DEPENDENCY_UNSATISFIED' ||
          execStatus === 'SETTING_NOT_AVAILABLE' ||
          execStatus === 'PRE_SAVE_VALIDATION_FAILED';

        if (isBlocked) {
          planBlocked++;
        } else {
          planExecutable++;
        }
      }

      // 破壊的変更の集計
      if (res.hasDestructiveChanges) {
        destructiveChangeSchools++;
        writeBlockedDestructive++;

        if (res.before && res.requested) {
          if (res.before['timelineChannel'] === 'ON' && res.requested['timelineChannel'] === 'OFF') {
            destructiveChangeActions++;
            destructiveChangeDetails.push({
              schoolCode: res.schoolCode,
              schoolName: res.schoolName,
              settingKey: 'timelineChannel',
              current: 'ON',
              expected: 'OFF',
              risk: 'SCHEDULED_POSTS_MAY_BE_DELETED'
            });
          }
        }
      } else if (isReadOk) {
        writeEligibleNonDestructive++;
      }

      // アクション数分布
      if (res.actionsCount !== undefined) {
        const count = res.actionsCount;
        if (count === 0) {
          actionsDistribution.zero++;
          if (isReadOk) {
            alreadyConfigured++;
          }
        } else {
          requiresChange++;
          if (count === 1) {
            actionsDistribution.one++;
          } else if (count === 2) {
            actionsDistribution.two++;
          } else {
            actionsDistribution.threePlus++;
          }
        }
      }

      // 指示12, 13: 現在値分布と変更予定数の集計
      if (res.before) {
        for (const k of allKeys) {
          const val: string | null | undefined = res.before[k];
          const stateKey: string = val === null || val === undefined ? 'CONTRACT_NOT_AVAILABLE' : String(val);
          currentStateDistribution[k][stateKey] = (currentStateDistribution[k][stateKey] || 0) + 1;

          // 変更予定
          const req: string | null | undefined = res.requested ? res.requested[k] : undefined;
          if (req === null || req === undefined || req === val) {
            plannedChangeDistribution[k]['noChange'] = (plannedChangeDistribution[k]['noChange'] || 0) + 1;
          } else {
            const changeKey: string = `${stateKey}_TO_${String(req)}`;
            plannedChangeDistribution[k][changeKey] = (plannedChangeDistribution[k][changeKey] || 0) + 1;
          }
        }
      }
    }

    const processedSchools = this.schoolResults.length;

    const report: BatchSummaryReport = {
      deploymentId: this.deploymentId,
      runId: this.runId,
      mode: this.mode,
      profileHash: this.profileHash,
      schoolsHash: this.schoolsHash,
      toolVersion: this.toolVersion,
      toolFingerprint: this.toolFingerprint,
      startedAt: this.startedAt,
      finishedAt,
      totalSchools,
      processedSchools,
      skippedSchools,
      readSuccess,
      readFailed,
      loginSuccess,
      loginFailed,
      schoolMismatch,
      uiStructureMismatch,
      planExecutable,
      planBlocked,
      alreadyConfigured,
      requiresChange,
      destructiveChangeSchools,
      destructiveChangeActions,
      writeEligibleNonDestructive,
      writeBlockedDestructive,
      configConflict,
      dependencyUnsatisfied,
      otherErrors,
      circuitBreakerTrip: circuitBreakerTrip ?? undefined,
      actionsDistribution,
      destructiveChangeDetails,
      currentStateDistribution,
      plannedChangeDistribution,
      schoolResults: this.schoolResults
    };

    const reportPath = path.join(this.reportsDir, `summary-${this.deploymentId}-${this.runId}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
    logger.info(`バッチ集計レポートを出力しました: ${reportPath}`);

    // 指示2, 3, 4, 7, 8, 15: Preflight モードの場合、Preflight Report を生成 (completedAtから24時間有効)
    if (this.mode === 'PREFLIGHT_DRY_RUN') {
      const validUntil = new Date(new Date(finishedAt).getTime() + 24 * 3600 * 1000).toISOString();
      const notProcessed = Math.max(0, totalSchools - processedSchools);

      let status: PreflightStatus = 'COMPLETE';
      const hasInterruptedSchool = this.schoolResults.some((r) => r.status === 'INTERRUPTED' || r.executionStatus === 'INTERRUPTED');
      if (isInterrupted || hasInterruptedSchool) {
        status = 'INTERRUPTED';
      } else if (circuitBreakerTrip) {
        status = 'PAUSED';
      } else if (processedSchools < totalSchools) {
        status = 'INCOMPLETE';
      }

      // 指示6, 7: COMPLETEと全学校SUCCESSの分離
      const allReadSucceeded = (status === 'COMPLETE' && readSuccess === totalSchools && readFailed === 0 && notProcessed === 0);
      const allPlansExecutable = (allReadSucceeded === true && planBlocked === 0 && planExecutable === totalSchools);
      // 指示4: writeGateEligible の厳格化
      const writeGateEligible =
        status === 'COMPLETE' &&
        allReadSucceeded === true &&
        planBlocked === 0 &&
        allPlansExecutable === true &&
        destructiveChangeSchools === 0;

      // 指示5, 6: 学校ごとの Preflight 結果
      const schoolResultMap = new Map(this.schoolResults.map((r) => [r.schoolCode, r]));
      const schoolsList = allSchools && allSchools.length > 0 ? allSchools : this.schoolResults.map((r) => ({
        schoolCode: r.schoolCode,
        schoolName: r.schoolName,
        credentialRef: r.schoolCode,
        enabled: true
      }));

      const schools: PreflightSchoolResult[] = schoolsList.map((s) => {
        const res = schoolResultMap.get(s.schoolCode);
        if (!res) {
          return {
            schoolCode: s.schoolCode,
            schoolName: s.schoolName,
            readStatus: 'NOT_PROCESSED',
            planExecutable: false,
            hasDestructiveChanges: false,
            writeEligible: false,
            actionsCount: 0
          };
        }
        const isOk =
          res.executionStatus === 'DRY_RUN_COMPLETED' ||
          res.status === 'SUCCESS' ||
          res.status === 'SUCCESS_ALREADY_CONFIGURED' ||
          res.executionStatus === 'CONFIG_CONFLICT' ||
          res.executionStatus === 'DEPENDENCY_UNSATISFIED' ||
          res.executionStatus === 'SETTING_NOT_AVAILABLE' ||
          res.executionStatus === 'PRE_SAVE_VALIDATION_FAILED';
        const isPlanBlocked =
          res.planExecutable === false ||
          res.executionStatus === 'CONFIG_CONFLICT' ||
          res.executionStatus === 'DEPENDENCY_UNSATISFIED' ||
          res.executionStatus === 'SETTING_NOT_AVAILABLE' ||
          res.executionStatus === 'PRE_SAVE_VALIDATION_FAILED';

        let readStatus: 'SUCCESS' | 'FAILED' | 'NOT_PROCESSED' | 'INTERRUPTED' = isOk ? 'SUCCESS' : 'FAILED';
        if (res.status === 'INTERRUPTED' || res.executionStatus === 'INTERRUPTED') {
          readStatus = 'INTERRUPTED';
        }
        const planExecutable = isOk && !isPlanBlocked;
        const hasDestructiveChanges = Boolean(res.hasDestructiveChanges);
        const writeEligible = readStatus === 'SUCCESS' && planExecutable === true && !hasDestructiveChanges;

        return {
          schoolCode: s.schoolCode,
          schoolName: s.schoolName,
          readStatus,
          planExecutable,
          hasDestructiveChanges,
          writeEligible,
          actionsCount: res.actionsCount ?? 0
        };
      });

      const preflightReport: PreflightReport = {
        deploymentId: this.deploymentId,
        status,
        writeGateEligible,
        allReadSucceeded,
        allPlansExecutable,
        profileHash: this.profileHash,
        schoolsHash: this.schoolsHash,
        toolVersion: this.toolVersion,
        toolFingerprint: this.toolFingerprint,
        completedAt: finishedAt,
        validUntil,
        total: totalSchools,
        processed: processedSchools,
        readSuccess,
        readFailed,
        planBlocked,
        notProcessed,
        alreadyConfigured,
        requiresChange,
        destructiveChangeSchools,
        summaryPath: reportPath,
        schools
      };
      const preflightPath = path.join(this.reportsDir, `preflight-${this.deploymentId}.json`);
      fs.writeFileSync(preflightPath, JSON.stringify(preflightReport, null, 2), 'utf-8');
      logger.info(`【Preflight Report 生成】Status: ${status}, Write Gate Eligible: ${writeGateEligible}, 有効期限: ${validUntil}: ${preflightPath}`);
    }

    this.printSummary(report, reportPath);

    return report;
  }

  private printSummary(report: BatchSummaryReport, reportPath: string): void {
    logger.info(`\n================================================================`);
    logger.info(`                   BATCH SUMMARY REPORT                         `);
    logger.info(`================================================================`);
    logger.info(`Deployment ID:          ${report.deploymentId}`);
    logger.info(`Run ID:                 ${report.runId}`);
    logger.info(`Mode:                   ${report.mode}`);
    logger.info(`Profile Hash:           ${report.profileHash.substring(0, 8)}`);
    logger.info(`Schools Hash:           ${report.schoolsHash.substring(0, 8)}`);
    logger.info(`Tool Version:           ${report.toolVersion}`);
    if (report.toolFingerprint) {
      logger.info(`Tool Fingerprint:       ${report.toolFingerprint.substring(0, 8)}`);
    }
    logger.info(`Started:                ${report.startedAt}`);
    logger.info(`Finished:               ${report.finishedAt}`);
    logger.info(`Total Schools:          ${report.totalSchools}`);
    logger.info(`Processed Schools:      ${report.processedSchools}`);
    logger.info(`Skipped Schools:        ${report.skippedSchools}`);
    logger.info(`----------------------------------------------------------------`);
    logger.info(`Read Success:           ${report.readSuccess}`);
    logger.info(`Read Failed:            ${report.readFailed}`);
    logger.info(`Login Success:          ${report.loginSuccess}`);
    logger.info(`Login Failed:           ${report.loginFailed}`);
    logger.info(`School Mismatch:        ${report.schoolMismatch}`);
    logger.info(`UI Structure Mismatch:  ${report.uiStructureMismatch}`);
    logger.info(`----------------------------------------------------------------`);
    logger.info(`Plan Executable:        ${report.planExecutable}`);
    logger.info(`Plan Blocked:           ${report.planBlocked}`);
    logger.info(`Already Configured (0): ${report.alreadyConfigured}`);
    logger.info(`Requires Change (>0):   ${report.requiresChange}`);
    logger.info(`Destructive Change Sch: ${report.destructiveChangeSchools} (Actions: ${report.destructiveChangeActions})`);
    logger.info(`Write Eligible (Non-D): ${report.writeEligibleNonDestructive}`);
    logger.info(`Write Blocked (Destr):  ${report.writeBlockedDestructive}`);
    logger.info(`Config Conflict:        ${report.configConflict}`);
    logger.info(`Dependency Unsatisfied: ${report.dependencyUnsatisfied}`);
    logger.info(`Other Errors:           ${report.otherErrors}`);
    if (report.circuitBreakerTrip) {
      logger.info(`----------------------------------------------------------------`);
      logger.info(`CIRCUIT BREAKER:        TRIPPED (${report.circuitBreakerTrip.category})`);
      logger.info(`Reason:                 ${report.circuitBreakerTrip.tripReason}`);
    }
    logger.info(`----------------------------------------------------------------`);
    logger.info(`Actions Distribution:`);
    logger.info(`  0 changes:            ${report.actionsDistribution.zero}`);
    logger.info(`  1 change:             ${report.actionsDistribution.one}`);
    logger.info(`  2 changes:            ${report.actionsDistribution.two}`);
    logger.info(`  3+ changes:           ${report.actionsDistribution.threePlus}`);
    logger.info(`================================================================`);
    logger.info(`Detailed report saved at: ${reportPath}\n`);
  }
}
