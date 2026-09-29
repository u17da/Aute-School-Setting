import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import {
  ValidationSnapshot,
  TargetValidationSnapshot,
  ObservationSnapshot,
  DraftProfileState,
  FinalValidationSnapshot,
  PreviewExecutionPlan,
  SchoolPreviewDiff,
  ConsoleJobState,
  ConsoleError,
  ActiveUploadedBatch,
  InputDataSource,
  ProfileSnapshot,
  ActivePreviewContext,
  ActiveFinalPreflightContext,
  WorkflowCapabilities,
  ActiveExecutionResultContext,
  ExecutionResultViewModel
} from './types';
import { normalizeExecutionResult } from './resultsNormalizer';
import { loadSchoolsList, validateCredentialsExist } from '../batch/runBatch';
import { RequestedSettingsSchema } from '../config/schema';
import { RequestedSettings } from '../types/config';
import { generateSettingsHash, generateSchoolsHash, getToolVersion, generateToolFingerprint } from '../utils/hash';
import { FileCredentialProvider, EnvCredentialProvider } from '../batch/credentialProvider';
import { loadEnvConfig } from '../config/loader';
import { AutomationError } from '../types/errors';
import { sanitizeString } from './sanitizer';
import { validateGlobalGateAndBuildManifest, ConfirmationTokenManager } from './manifest';
import { PreflightReport, ApplyTargetManifest, ConfirmationTokenData, BatchSummaryReport } from '../types/batch';
import { getReportsDir, getCheckpointsDir } from '../runtime/paths';
import { evaluateExecutionPlan } from '../automation/evaluateExecutionPlan';
import { buildExecutionPlan } from '../automation/buildExecutionPlan';
import {
  writeCurrentLedger,
  updateCurrentLedgerState,
  writeContextArtifact,
  restoreActiveExecutionResultContextFromLedger,
  getProductionSummaryPath,
  getContextArtifactPath
} from './ledger';

export interface BatchProgressInfo {
  processed: number;
  total: number;
  percentage: number;
  success: number;
  failed: number;
  remaining: number;
  elapsedSeconds: number;
  estimatedRemainingSeconds: number | null;
  currentSchool?: {
    schoolCode: string;
    schoolName: string;
  };
}

export function isPidAlive(pid: number): boolean {
  if (typeof pid !== 'number' || isNaN(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === 'EPERM'; // EPERM は権限不足によるエラーであり、プロセスが存在することを示すため生存扱い
  }
}

export class BatchProcessAdapter extends EventEmitter {
  private childProcess: ChildProcess | null = null;
  private currentJobState: ConsoleJobState = 'IDLE';
  private currentSnapshot: ValidationSnapshot | null = null;
  private targetSnapshot: TargetValidationSnapshot | null = null;
  private observationSnapshot: ObservationSnapshot | null = null;
  private draftProfile: DraftProfileState | null = null;
  private profileSnapshots: Map<string, ProfileSnapshot> = new Map();
  private activeProfileSnapshot: ProfileSnapshot | null = null;
  private finalValidationSnapshot: FinalValidationSnapshot | null = null;
  private activeFinalPreflightReport: PreflightReport | null = null;
  private activeFinalSummaryReport: any = null;
  private activePreviewContext: ActivePreviewContext | null = null;
  private activeFinalPreflightContext: ActiveFinalPreflightContext | null = null;
  private currentFinalPreflightExecutionId: string | null = null;
  private currentProductionExecutionId: string | null = null;
  private currentDiscoveryExecutionId: string | null = null;
  private isApplyInFlight: boolean = false;
  private activeExecutionResultContext: ActiveExecutionResultContext | null = null;
  private currentExecutionPurpose: 'DISCOVERY' | 'FINAL_PREFLIGHT' | 'PRODUCTION_WRITE' | null = null;
  private runStartedAt: number | null = null;
  private currentRunId: string | null = null;
  private progressInterval: NodeJS.Timeout | null = null;
  private lastProgressInfo: BatchProgressInfo | null = null;
  private stdoutBuffer: string[] = [];
  private spawnFn: typeof spawn;
  private lastSpawnInfo: { command: string; args: string[]; env: any } | null = null;
  private lastValidationParams: any = {};
  private stopFallbackTimeoutMs: number;
  private stopFallbackTimer: NodeJS.Timeout | null = null;
  private activeUpload: ActiveUploadedBatch | null = null;
  private inputSource: InputDataSource = 'LOCAL_DEFAULT';
  private tokenManager: ConfirmationTokenManager = new ConfirmationTokenManager();

  constructor(options?: { spawnFn?: typeof spawn; stopFallbackTimeoutMs?: number; initialSource?: InputDataSource }) {
    super();
    this.spawnFn = options?.spawnFn ?? spawn;
    this.stopFallbackTimeoutMs = options?.stopFallbackTimeoutMs ?? 15000;
    this.inputSource = options?.initialSource ?? 'LOCAL_DEFAULT';
    this.cleanupStaleTempFiles();
    this.restoreProductionResultFromLedger();
  }

  private cleanupStaleTempFiles(): void {
    try {
      const tmpDir = os.tmpdir();
      const files = fs.readdirSync(tmpDir);
      const staleThresholdMs = 3600 * 1000; // 1時間
      const now = Date.now();
      for (const file of files) {
        if (file.startsWith('manapoke-upload-') || file.startsWith('schools-upload-') || file.startsWith('credentials-upload-')) {
          const fullPath = path.join(tmpDir, file);
          try {
            const stat = fs.statSync(fullPath);
            const ageMs = now - stat.mtimeMs;

            // age が閾値 (1時間) を超えている場合のみ削除判定
            if (ageMs > staleThresholdMs) {
              if (stat.isDirectory()) {
                const ownerFilePath = path.join(fullPath, 'owner.json');
                let shouldDelete = false;

                if (fs.existsSync(ownerFilePath)) {
                  try {
                    const ownerData = JSON.parse(fs.readFileSync(ownerFilePath, 'utf-8'));
                    const ownerPid = ownerData.ownerPid;
                    // age > staleThreshold AND ownerPid が存在しない (dead) 場合のみ削除
                    if (typeof ownerPid === 'number' && !isPidAlive(ownerPid)) {
                      shouldDelete = true;
                    }
                  } catch {
                    // owner.json が破損している場合は安全のため削除しない
                  }
                } else {
                  // owner.json が存在しない旧形式の一時ディレクトリの場合
                  shouldDelete = true;
                }

                if (shouldDelete) {
                  fs.rmSync(fullPath, { recursive: true, force: true });
                }
              } else {
                fs.unlinkSync(fullPath);
              }
            }
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
  }

  getActiveUpload(): ActiveUploadedBatch | null {
    return this.activeUpload;
  }

  isAnyJobRunning(): boolean {
    return (
      this.currentJobState === 'RUNNING' ||
      this.currentJobState === 'DISCOVERY_RUNNING' ||
      this.currentJobState === 'FINAL_PREFLIGHT_RUNNING' ||
      this.currentJobState === 'APPLY_RUNNING' ||
      this.currentJobState === 'STOPPING'
    );
  }

  getInputSource(): InputDataSource {
    return this.inputSource;
  }

  setInputSource(source: InputDataSource): void {
    if (this.isAnyJobRunning()) {
      throw new ConsoleError('JOB_CONFLICT', 'ジョブ実行中または停止処理中は入力ソースを変更できません');
    }
    this.inputSource = source;
    this.invalidateTarget('SOURCE_CHANGED');
  }

  setUploadedBatch(batch: ActiveUploadedBatch): void {
    if (this.isAnyJobRunning()) {
      throw new ConsoleError('JOB_CONFLICT', 'ジョブ実行中または停止処理中は新しいCSVをアップロードできません');
    }
    this.activeUpload = batch;
    this.inputSource = 'UPLOAD';
    this.invalidateTarget('BATCH_UPLOADED');
  }

  getTargetSnapshot(): TargetValidationSnapshot | null {
    return this.targetSnapshot;
  }

  getObservationSnapshot(): ObservationSnapshot | null {
    return this.observationSnapshot;
  }

  getDraftProfile(): DraftProfileState | null {
    return this.draftProfile;
  }

  getFinalValidationSnapshot(): FinalValidationSnapshot | null {
    return this.finalValidationSnapshot;
  }

  getActiveFinalPreflightReport(): PreflightReport | null {
    return this.activeFinalPreflightReport;
  }

  getActiveFinalSummaryReport(): any | null {
    return this.activeFinalSummaryReport;
  }

  getActivePreviewContext(): ActivePreviewContext | null {
    return this.activePreviewContext;
  }

  getActiveFinalPreflightContext(): ActiveFinalPreflightContext | null {
    return this.activeFinalPreflightContext;
  }

  getCurrentFinalPreflightExecutionId(): string | null {
    return this.currentFinalPreflightExecutionId;
  }

  isApplyReady(): boolean {
    if (this.currentJobState === 'RUNNING' || this.currentJobState === 'STOPPING') {
      return false;
    }
    if (!this.targetSnapshot || !this.activeProfileSnapshot || !this.finalValidationSnapshot || !this.activeFinalPreflightContext) {
      return false;
    }
    if (!this.currentFinalPreflightExecutionId || this.activeFinalPreflightContext.executionId !== this.currentFinalPreflightExecutionId) {
      return false;
    }
    if (this.activeFinalPreflightContext.finalValidationSnapshotId !== this.finalValidationSnapshot.finalValidationSnapshotId) {
      return false;
    }
    if (this.finalValidationSnapshot.profileSnapshotId !== this.activeProfileSnapshot.snapshotId) {
      return false;
    }
    if (this.finalValidationSnapshot.targetSnapshotId !== this.targetSnapshot.targetSnapshotId) {
      return false;
    }
    if (this.activeFinalPreflightContext.report.purpose !== 'FINAL_PREFLIGHT') {
      return false;
    }
    return true;
  }

  getWorkflowCapabilities(): WorkflowCapabilities {
    const isRunning = this.isAnyJobRunning();
    const hasTarget = !!this.targetSnapshot;
    const hasObservation = !!this.observationSnapshot;
    const hasDraft = !!this.draftProfile;
    const hasPreview = !!this.activePreviewContext;
    const hasProfile = !!this.activeProfileSnapshot;
    const isApplyReady = this.isApplyReady();

    return {
      canEditDraft: !isRunning && hasObservation,
      canPreview: !isRunning && hasObservation && hasDraft,
      canConfirmProfile: !isRunning && hasObservation && hasDraft && hasPreview,
      canRunFinalPreflight: !isRunning && hasTarget && hasProfile,
      canPrepareApply: !isRunning && isApplyReady
    };
  }

  getActiveProfileSnapshot(): ProfileSnapshot | null {
    return this.activeProfileSnapshot;
  }

  getCurrentExecutionPurpose(): 'DISCOVERY' | 'FINAL_PREFLIGHT' | 'PRODUCTION_WRITE' | null {
    return this.currentExecutionPurpose;
  }

  getProfileSnapshot(id: string): ProfileSnapshot | undefined {
    return this.profileSnapshots.get(id);
  }

  createAndSetActiveProfileSnapshot(requestedSettings: RequestedSettings): ProfileSnapshot {
    const profileHash = generateSettingsHash(requestedSettings);
    const snapshotId = `prof-snap-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const snapshot: ProfileSnapshot = {
      snapshotId,
      targetSnapshotId: this.targetSnapshot?.targetSnapshotId,
      observationSnapshotId: this.observationSnapshot?.observationSnapshotId,
      sourceDraftRevision: this.draftProfile?.draftRevision,
      sourceDraftHash: this.draftProfile?.draftHash,
      profileHash,
      requestedSettings: { ...requestedSettings },
      createdAt: new Date().toISOString()
    };
    this.profileSnapshots.set(snapshotId, snapshot);
    this.activeProfileSnapshot = snapshot;
    return snapshot;
  }

  // State Invalidation Rules (Phase 6A)
  invalidateTarget(reason?: string): void {
    this.targetSnapshot = null;
    this.currentSnapshot = null;
    this.invalidateObservation(reason || 'TARGET_INVALIDATED');
    if (this.currentJobState === 'READY' || this.currentJobState === 'VALIDATING') {
      this.currentJobState = 'IDLE';
    }
    this.emit('stateChange', { state: this.currentJobState, reason: reason || 'TARGET_INVALIDATED' });
  }

  invalidateObservation(reason?: string): void {
    this.observationSnapshot = null;
    this.draftProfile = null;
    this.activePreviewContext = null;
    this.activeProfileSnapshot = null;
    this.invalidateFinalPreflight(reason || 'OBSERVATION_INVALIDATED');
  }

  invalidateDraft(reason?: string): void {
    this.activePreviewContext = null;
    this.activeProfileSnapshot = null;
    this.invalidateFinalPreflight(reason || 'DRAFT_INVALIDATED');
  }

  setObservationSnapshot(obs: ObservationSnapshot | null): void {
    this.observationSnapshot = obs;
    this.draftProfile = null;
    this.activePreviewContext = null;
    this.activeProfileSnapshot = null;
    this.invalidateFinalPreflight('OBSERVATION_SET');
  }

  invalidateFinalPreflight(reason?: string): void {
    this.finalValidationSnapshot = null;
    this.activeFinalPreflightReport = null;
    this.activeFinalSummaryReport = null;
    this.activeFinalPreflightContext = null;
    this.currentFinalPreflightExecutionId = null;
    this.tokenManager = new ConfirmationTokenManager();
    this.emit('finalPreflightInvalidated', { reason });
  }

  invalidateValidation(reason?: string): void {
    this.invalidateTarget(reason);
  }

  resetAllResults(): void {
    this.targetSnapshot = null;
    this.observationSnapshot = null;
    this.draftProfile = null;
    this.activePreviewContext = null;
    this.activeProfileSnapshot = null;
    this.finalValidationSnapshot = null;
    this.activeFinalPreflightReport = null;
    this.activeFinalSummaryReport = null;
    this.activeFinalPreflightContext = null;
    this.currentFinalPreflightExecutionId = null;
    this.activeExecutionResultContext = null;
    this.currentSnapshot = null;
    this.currentJobState = 'IDLE';
    this.stdoutBuffer = [];
    this.currentRunId = null;
    this.runStartedAt = null;
    this.lastSpawnInfo = null;
    this.activeUpload = null;
    this.tokenManager = new ConfirmationTokenManager();
    this.emit('stateChange', { state: 'IDLE', reason: 'RESET_RESULTS' });
  }

  restoreProductionResultFromLedger(): void {
    try {
      const result = restoreActiveExecutionResultContextFromLedger();
      if (result.context) {
        this.activeExecutionResultContext = result.context;
        this.currentProductionExecutionId = result.context.productionExecutionId || null;
      }
    } catch (e) {
      console.error('[ConsoleAdapter] Failed to restore production result from ledger:', e);
    }
  }

  getActiveExecutionResultContext(): ActiveExecutionResultContext | null {
    return this.activeExecutionResultContext;
  }

  setActiveExecutionResultContext(context: ActiveExecutionResultContext | null): void {
    this.activeExecutionResultContext = context;
  }

  setActiveFinalPreflightContext(context: ActiveFinalPreflightContext | null): void {
    this.activeFinalPreflightContext = context;
  }

  getLastSpawnInfo(): { command: string; args: string[]; env: any } | null {
    return this.lastSpawnInfo;
  }

  getJobState(): ConsoleJobState {
    return this.currentJobState;
  }

  getSnapshot(): ValidationSnapshot | null {
    return this.currentSnapshot;
  }

  getCurrentRunId(): string | null {
    return this.currentRunId;
  }

  getStartedAt(): string | null {
    return this.runStartedAt ? new Date(this.runStartedAt).toISOString() : null;
  }

  getRecentLogs(limit = 100): string[] {
    return this.stdoutBuffer.slice(-limit);
  }

  getConfirmationTokenManager(): ConfirmationTokenManager {
    return this.tokenManager;
  }

  /**
   * Phase 6A: Target Validation の実行 (Profile未確定で対象学校と認証情報のみを検証)
   */
  executeTargetValidation(params: {
    schoolsFilePath?: string;
    credentialsFilePath?: string;
    expectedSchoolCount?: number;
    authMode?: 'A' | 'B';
  }): { targetSnapshot: TargetValidationSnapshot; schoolsCount: number; enabledCount: number; schoolsPath?: string } {
    if (this.isAnyJobRunning()) {
      throw new ConsoleError('JOB_CONFLICT', 'ジョブ実行中または停止処理中は検証を実行できません');
    }

    let schools: import('../types/batch').BatchSchoolItem[];
    let schoolsPath: string;
    let sourceName: string;

    const resolveExisting = (candidates: string[]): string => {
      for (const c of candidates) {
        if (fs.existsSync(path.resolve(process.cwd(), c))) return c;
      }
      return candidates[0];
    };

    if (this.inputSource === 'UPLOAD') {
      if (!this.activeUpload) {
        throw new AutomationError('CONFIG_INVALID', 'アップロードされたCSVデータが存在しません');
      }
      schools = this.activeUpload.schools;
      schoolsPath = this.activeUpload.originalFileName;
      sourceName = this.activeUpload.originalFileName;

      const enabledSchools = schools.filter((s) => s.enabled);
      for (const s of enabledSchools) {
        const cred = this.activeUpload.credentials[s.credentialRef];
        if (!cred || !cred.userId || !cred.password) {
          throw new AutomationError(
            'CREDENTIAL_NOT_FOUND',
            `学校 ${s.schoolCode} の認証情報がアップロードデータ内に見つかりません (credentialRef: ${s.credentialRef})`
          );
        }
      }
    } else {
      schoolsPath = params.schoolsFilePath || resolveExisting(['config/schools.live.csv', 'config/schools-live.csv', 'config/schools.sample.csv']);
      sourceName = schoolsPath;
      schools = loadSchoolsList(schoolsPath);

      const credentialsPath = params.credentialsFilePath || resolveExisting(['config/credentials.json', 'config/credentials.sample.json']);
      const envConfig = loadEnvConfig();
      let credProvider;
      if (fs.existsSync(path.resolve(process.cwd(), credentialsPath))) {
        credProvider = new FileCredentialProvider(path.resolve(process.cwd(), credentialsPath));
      } else {
        credProvider = new EnvCredentialProvider(envConfig.userId, envConfig.password);
      }
      validateCredentialsExist(schools, credProvider);
    }

    const schoolsHash = generateSchoolsHash(schools);
    const enabledSchools = schools.filter((s) => s.enabled);

    if (params.expectedSchoolCount !== undefined && enabledSchools.length !== params.expectedSchoolCount) {
      throw new AutomationError(
        'BATCH_INPUT_INVALID',
        `有効学校数 (${enabledSchools.length}校) が指定された想定学校数 (${params.expectedSchoolCount}校) と一致しません`,
        { enabledCount: enabledSchools.length, expectedSchoolCount: params.expectedSchoolCount }
      );
    }

    const toolVersion = getToolVersion();
    const toolFingerprint = generateToolFingerprint();
    const envConfig = loadEnvConfig();
    const effectiveAuthMode = params.authMode || envConfig.authMode;

    const targetSnapshotId = `target-snap-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const targetSnapshot: TargetValidationSnapshot = {
      targetSnapshotId,
      schoolsHash,
      toolFingerprint,
      toolVersion,
      authMode: effectiveAuthMode,
      expectedSchoolCount: params.expectedSchoolCount,
      enabledSchoolCount: enabledSchools.length,
      totalSchoolCount: schools.length,
      resolvedCredentialsCount: enabledSchools.length,
      source: this.inputSource,
      sourceName,
      createdAt: new Date().toISOString()
    };

    this.targetSnapshot = targetSnapshot;
    // 互換性ValidationSnapshotも更新
    this.currentSnapshot = {
      profileHash: 'unmanaged',
      schoolsHash,
      toolVersion,
      toolFingerprint,
      expectedSchoolCount: params.expectedSchoolCount,
      enabledSchoolCount: enabledSchools.length,
      totalSchoolCount: schools.length,
      resolvedCredentialsCount: enabledSchools.length,
      validatedAt: targetSnapshot.createdAt,
      source: this.inputSource,
      sourceName,
      targetSnapshotId
    };

    this.invalidateObservation('TARGET_VALIDATED');
    this.currentJobState = 'READY';
    this.lastValidationParams = { ...params };

    return {
      targetSnapshot,
      schoolsCount: schools.length,
      enabledCount: enabledSchools.length,
      schoolsPath
    };
  }

  /**
   * Phase 6A: Draft Profile の更新 (Revision & Hash 管理, CAS, Lineage検証, 冪等化)
   */
  updateDraftProfile(
    settings: RequestedSettings,
    lineage?: {
      targetSnapshotId?: string;
      observationSnapshotId?: string;
      expectedDraftRevision?: number;
    }
  ): DraftProfileState {
    if (this.isAnyJobRunning()) {
      throw new ConsoleError('JOB_CONFLICT', 'ジョブ実行中または停止処理中は設定を変更できません');
    }
    if (!this.observationSnapshot) {
      throw new ConsoleError('VALIDATION_REQUIRED', 'Discovery完了後に設定を行ってください');
    }

    if (lineage?.targetSnapshotId && lineage.targetSnapshotId !== this.observationSnapshot.targetSnapshotId) {
      throw new ConsoleError('LINEAGE_MISMATCH', `TargetSnapshotIDが一致しません (要求: ${lineage.targetSnapshotId}, 現在: ${this.observationSnapshot.targetSnapshotId})`);
    }
    if (lineage?.observationSnapshotId && lineage.observationSnapshotId !== this.observationSnapshot.observationSnapshotId) {
      throw new ConsoleError('LINEAGE_MISMATCH', `ObservationSnapshotIDが一致しません (要求: ${lineage.observationSnapshotId}, 現在: ${this.observationSnapshot.observationSnapshotId})`);
    }

    const parsed = RequestedSettingsSchema.strict().safeParse(settings);
    if (!parsed.success) {
      throw new AutomationError(
        'CONFIG_INVALID',
        `設定内容の形式が不正です: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
      );
    }

    const incomingHash = generateSettingsHash(parsed.data);

    // 冪等性チェック: 既存Draftがあり、Hashが同一の場合は revision を進めず下流も破壊しない (IDEMPOTENT_NO_CHANGE)
    if (
      this.draftProfile &&
      this.draftProfile.draftHash === incomingHash &&
      this.draftProfile.targetSnapshotId === this.observationSnapshot.targetSnapshotId &&
      this.draftProfile.observationSnapshotId === this.observationSnapshot.observationSnapshotId
    ) {
      return this.draftProfile;
    }

    // 差分がある場合、expectedDraftRevision が指定されていれば CAS 検証
    if (
      lineage?.expectedDraftRevision !== undefined &&
      this.draftProfile &&
      this.draftProfile.draftRevision !== lineage.expectedDraftRevision
    ) {
      throw new ConsoleError('DRAFT_STALE', `設定が他で更新されています (期待リビジョン: ${lineage.expectedDraftRevision}, 現在: ${this.draftProfile.draftRevision})`);
    }

    const draftRevision = (this.draftProfile?.draftRevision ?? 0) + 1;
    const draft: DraftProfileState = {
      targetSnapshotId: this.observationSnapshot.targetSnapshotId,
      observationSnapshotId: this.observationSnapshot.observationSnapshotId,
      draftRevision,
      draftHash: incomingHash,
      settings: parsed.data,
      updatedAt: new Date().toISOString()
    };
    this.draftProfile = draft;
    this.invalidateDraft('DRAFT_UPDATED');
    return draft;
  }

  /**
   * Phase 6A: PreviewExecutionPlan の算出 (ActivePreviewContext 保持)
   */
  calculatePreview(observationSnapshotId?: string, draftRevision?: number, draftHash?: string): PreviewExecutionPlan {
    if (!this.observationSnapshot) {
      throw new ConsoleError('VALIDATION_REQUIRED', 'Discovery完了後にプレビューを計算してください');
    }
    if (!this.draftProfile) {
      throw new ConsoleError('VALIDATION_REQUIRED', 'ドラフト設定が存在しません');
    }

    const obsId = observationSnapshotId ?? this.observationSnapshot.observationSnapshotId;
    const rev = draftRevision ?? this.draftProfile.draftRevision;
    const hash = draftHash ?? this.draftProfile.draftHash;

    if (this.observationSnapshot.observationSnapshotId !== obsId) {
      throw new ConsoleError('LINEAGE_MISMATCH', 'Observation Snapshot ID が一致しません');
    }
    if (this.draftProfile.draftRevision !== rev || this.draftProfile.draftHash !== hash) {
      throw new ConsoleError('DRAFT_STALE', 'Draft Profile のリビジョンまたはハッシュが一致しません (stale)');
    }

    const schools = this.observationSnapshot.schools;
    let targetCount = 0;
    let alreadyConfiguredCount = 0;
    let destructiveCount = 0;
    let uncontractedCount = 0;
    let blockedCount = 0;
    let observationFailedCount = 0;

    const settingDiffDistribution: Record<string, Record<string, number>> = {};
    for (const k of [
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
    ]) {
      settingDiffDistribution[k] = {};
    }

    const schoolDiffs: SchoolPreviewDiff[] = [];

    for (const s of schools) {
      if (s.readStatus === 'FAILED') {
        observationFailedCount++;
        schoolDiffs.push({
          schoolCode: s.schoolCode,
          schoolName: s.schoolName,
          hasChanges: false,
          isDestructive: false,
          planExecutable: false,
          actions: [],
          warnings: [`読取失敗: ${s.errorMessage}`]
        });
        continue;
      }

      // readStatus === 'SUCCESS'
      const plan = buildExecutionPlan({
        schoolCode: s.schoolCode,
        schoolName: s.schoolName,
        currentObservation: s.observation,
        requestedSettings: this.draftProfile.settings
      });

      const evaluation = evaluateExecutionPlan(plan);

      const hasChanges = plan.actions.length > 0;
      const isDestructive = plan.hasDestructiveChanges;
      const planExecutable = evaluation.isExecutable;

      if (isDestructive) destructiveCount++;
      if (!planExecutable) blockedCount++;

      // 契約外機能の有効化要求チェック (mentalHealthなど)
      if (plan.items.mentalHealth?.current?.availability === 'CONTRACT_NOT_AVAILABLE' && this.draftProfile.settings.mentalHealth !== null && this.draftProfile.settings.mentalHealth !== undefined) {
        uncontractedCount++;
      }

      if (!hasChanges) {
        alreadyConfiguredCount++;
      } else {
        targetCount++;
        for (const act of plan.actions) {
          const fromStr = act.from !== null && act.from !== undefined ? String(act.from) : 'UNMANAGED';
          const toStr = String(act.to);
          const diffKey = `${fromStr} -> ${toStr}`;
          const m = settingDiffDistribution[act.settingKey] || {};
          m[diffKey] = (m[diffKey] || 0) + 1;
          settingDiffDistribution[act.settingKey] = m;
        }
      }

      schoolDiffs.push({
        schoolCode: s.schoolCode,
        schoolName: s.schoolName,
        hasChanges,
        isDestructive,
        planExecutable,
        actions: plan.actions,
        warnings: evaluation.warnings
      });
    }

    const result: PreviewExecutionPlan = {
      observationSnapshotId: obsId,
      draftRevision: rev,
      draftHash: hash,
      calculatedAt: new Date().toISOString(),
      totalSchools: schools.length,
      targetCount,
      alreadyConfiguredCount,
      destructiveCount,
      uncontractedCount,
      blockedCount,
      observationFailedCount,
      settingDiffDistribution,
      schoolDiffs
    };

    // ActivePreviewContext を保持
    this.activePreviewContext = {
      observationSnapshotId: obsId,
      draftRevision: rev,
      draftHash: hash,
      previewPlan: result,
      calculatedAt: result.calculatedAt
    };

    return result;
  }

  /**
   * Phase 6A: Profile の確定 (ActivePreviewContext検証 & 冪等化)
   */
  confirmProfile(
    expectedDraftRevision: number,
    expectedDraftHash: string,
    targetSnapshotId?: string,
    observationSnapshotId?: string
  ): ProfileSnapshot {
    if (this.isAnyJobRunning()) {
      throw new ConsoleError('JOB_CONFLICT', 'ジョブ実行中または停止処理中はプロファイルを確定できません');
    }
    if (!this.draftProfile) {
      throw new ConsoleError('VALIDATION_REQUIRED', 'ドラフト設定が存在しません');
    }
    if (!this.observationSnapshot) {
      throw new ConsoleError('VALIDATION_REQUIRED', '現状調査データが存在しません');
    }
    if (targetSnapshotId && targetSnapshotId !== this.draftProfile.targetSnapshotId) {
      throw new ConsoleError('LINEAGE_MISMATCH', `TargetSnapshotIDが一致しません (要求: ${targetSnapshotId}, 現在: ${this.draftProfile.targetSnapshotId})`);
    }
    if (observationSnapshotId && observationSnapshotId !== this.draftProfile.observationSnapshotId) {
      throw new ConsoleError('LINEAGE_MISMATCH', `ObservationSnapshotIDが一致しません (要求: ${observationSnapshotId}, 現在: ${this.draftProfile.observationSnapshotId})`);
    }
    if (this.draftProfile.observationSnapshotId !== this.observationSnapshot.observationSnapshotId) {
      throw new ConsoleError('LINEAGE_MISMATCH', 'DraftProfileのObservationSnapshotIDと現在のObservationSnapshotが一致しません');
    }
    if (this.draftProfile.draftRevision !== expectedDraftRevision || this.draftProfile.draftHash !== expectedDraftHash) {
      throw new ConsoleError('DRAFT_STALE', '設定が更新されています。最新の差分を確認してください');
    }

    // ActivePreviewContext の照合 (プレビューが計算されていない、あるいは古いドラフトに対するプレビューの場合はエラー)
    if (
      !this.activePreviewContext ||
      this.activePreviewContext.observationSnapshotId !== this.draftProfile.observationSnapshotId ||
      this.activePreviewContext.draftRevision !== expectedDraftRevision ||
      this.activePreviewContext.draftHash !== expectedDraftHash
    ) {
      throw new ConsoleError('VALIDATION_REQUIRED', '最新の設定に対する差分プレビューが計算されていません。先に「差分を確認」を実行してください');
    }

    // 冪等化 (Idempotent Confirm)
    if (
      this.activeProfileSnapshot &&
      this.activeProfileSnapshot.sourceDraftRevision === expectedDraftRevision &&
      this.activeProfileSnapshot.sourceDraftHash === expectedDraftHash &&
      this.activeProfileSnapshot.targetSnapshotId === this.draftProfile.targetSnapshotId &&
      this.activeProfileSnapshot.observationSnapshotId === this.draftProfile.observationSnapshotId
    ) {
      return this.activeProfileSnapshot;
    }

    const snapshotId = `prof-snap-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const snap: ProfileSnapshot = {
      snapshotId,
      targetSnapshotId: this.draftProfile.targetSnapshotId,
      observationSnapshotId: this.draftProfile.observationSnapshotId,
      sourceDraftRevision: this.draftProfile.draftRevision,
      sourceDraftHash: this.draftProfile.draftHash,
      profileHash: this.draftProfile.draftHash,
      requestedSettings: { ...this.draftProfile.settings },
      createdAt: new Date().toISOString()
    };
    this.profileSnapshots.set(snapshotId, snap);
    this.activeProfileSnapshot = snap;

    // 互換性currentSnapshotの更新
    if (this.currentSnapshot) {
      this.currentSnapshot.profileHash = snap.profileHash;
      this.currentSnapshot.profileSnapshotId = snapshotId;
    }

    this.invalidateFinalPreflight('PROFILE_CONFIRMED');
    return snap;
  }

  /**
   * Phase 6A: Final Validation の実行 (多層Lineage再検証)
   */
  executeFinalValidation(): FinalValidationSnapshot {
    if (this.isAnyJobRunning()) {
      throw new ConsoleError('JOB_CONFLICT', 'ジョブ実行中または停止処理中は検証を実行できません');
    }
    if (!this.targetSnapshot) {
      throw new ConsoleError('VALIDATION_REQUIRED', 'Target確定が必要です');
    }
    if (!this.activeProfileSnapshot) {
      throw new ConsoleError('VALIDATION_REQUIRED', 'Profile確定が必要です');
    }
    if (this.activeProfileSnapshot.targetSnapshotId && this.activeProfileSnapshot.targetSnapshotId !== this.targetSnapshot.targetSnapshotId) {
      throw new ConsoleError('LINEAGE_MISMATCH', `ProfileSnapshotのTargetSnapshotID (${this.activeProfileSnapshot.targetSnapshotId}) と現在のTarget (${this.targetSnapshot.targetSnapshotId}) が一致しません`);
    }
    if (this.observationSnapshot && this.activeProfileSnapshot.observationSnapshotId && this.activeProfileSnapshot.observationSnapshotId !== this.observationSnapshot.observationSnapshotId) {
      throw new ConsoleError('LINEAGE_MISMATCH', `ProfileSnapshotのObservationSnapshotID (${this.activeProfileSnapshot.observationSnapshotId}) と現在のObservation (${this.observationSnapshot.observationSnapshotId}) が一致しません`);
    }

    const finalValidationSnapshotId = `final-val-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const snap: FinalValidationSnapshot = {
      finalValidationSnapshotId,
      targetSnapshotId: this.targetSnapshot.targetSnapshotId,
      observationSnapshotId: this.activeProfileSnapshot.observationSnapshotId || '',
      profileSnapshotId: this.activeProfileSnapshot.snapshotId,
      profileHash: this.activeProfileSnapshot.profileHash,
      schoolsHash: this.targetSnapshot.schoolsHash,
      toolVersion: this.targetSnapshot.toolVersion,
      toolFingerprint: this.targetSnapshot.toolFingerprint,
      authMode: this.targetSnapshot.authMode,
      enabledSchoolCount: this.targetSnapshot.enabledSchoolCount,
      totalSchoolCount: this.targetSnapshot.totalSchoolCount,
      resolvedCredentialsCount: this.targetSnapshot.resolvedCredentialsCount,
      validatedAt: new Date().toISOString()
    };
    this.finalValidationSnapshot = snap;
    return snap;
  }

  /**
   * 指示5 & Phase 6B & Direct Apply: Production Apply の準備 (破壊的変更合意フラグ allowDestructive & Preflightスキップ対応)
   */
  prepareProductionApply(
    customPreflight?: PreflightReport,
    customSummary?: any,
    allowDestructive?: boolean,
    directApply?: boolean
  ): { manifest: ApplyTargetManifest; tokenData: ConfirmationTokenData } {
    if (this.isAnyJobRunning()) {
      throw new ConsoleError('JOB_CONFLICT', '現在別の処理が実行中または停止処理中のため、Production Applyの準備を開始できません');
    }

    let preflightReport: PreflightReport | null = customPreflight || null;
    let summaryReport: any | null = customSummary || null;

    // ダイレクト反映モード (Preflight ドライラン巡回の明示的スキップ)
    const isDirect = directApply === true;

    if (isDirect) {
      if (!this.observationSnapshot) {
        throw new AutomationError('CONFIG_INVALID', '直接本番反映を行うには、先に現状調査 (STEP 2: Discovery) を完了してください');
      }
      if (!this.activeProfileSnapshot) {
        throw new AutomationError('CONFIG_INVALID', '有効な Profile Snapshot が存在しません。STEP 3 で設定を確定してください');
      }

      const manifest = validateGlobalGateAndBuildManifest({
        observationSnapshot: this.observationSnapshot,
        activeProfileSnapshot: this.activeProfileSnapshot,
        currentValidationSnapshot: this.currentSnapshot,
        finalValidationSnapshot: this.finalValidationSnapshot,
        allowDestructive: allowDestructive === true,
        directApply: true
      });

      const tokenData = this.tokenManager.createToken(manifest);
      return { manifest, tokenData };
    }

    if (!preflightReport) {
      if (!this.activeFinalPreflightContext || !this.currentFinalPreflightExecutionId || this.activeFinalPreflightContext.executionId !== this.currentFinalPreflightExecutionId) {
        throw new AutomationError('CONFIG_INVALID', '有効な Final Preflight レポートが見つかりません。現在のワークフローで先に Final Preflight を実行してください');
      }
      preflightReport = this.activeFinalPreflightContext.report;
      summaryReport = this.activeFinalPreflightContext.summary;
    }

    if (!preflightReport) {
      throw new AutomationError('CONFIG_INVALID', '有効な Final Preflight レポートが見つかりません。現在のワークフローで先に Final Preflight を実行してください');
    }
    if (preflightReport.purpose && preflightReport.purpose !== 'FINAL_PREFLIGHT') {
      throw new AutomationError('UNSAFE_CONFIGURATION', '指定されたレポートは Final Preflight 由来ではありません (Discovery レポートによる Apply は禁止されています)');
    }
    if (this.targetSnapshot && preflightReport.authMode && this.targetSnapshot.authMode !== preflightReport.authMode) {
      throw new AutomationError('CHECKPOINT_MISMATCH', `authMode 不一致: Target (${this.targetSnapshot.authMode}) と Preflight (${preflightReport.authMode}) が一致しません`);
    }

    // ProfileSnapshot の整合性確保
    let effectiveProfileSnapshot = this.activeProfileSnapshot;
    if (!effectiveProfileSnapshot) {
      const snapId = this.finalValidationSnapshot?.profileSnapshotId || preflightReport.profileSnapshotId;
      if (snapId && this.profileSnapshots.has(snapId)) {
        effectiveProfileSnapshot = this.profileSnapshots.get(snapId)!;
        this.activeProfileSnapshot = effectiveProfileSnapshot;
      }
    }

    // Global Gate 検証と Manifest 導出 (Phase 6B: allowDestructive を反映)
    const manifest = validateGlobalGateAndBuildManifest({
      preflightReport,
      activeProfileSnapshot: effectiveProfileSnapshot,
      currentValidationSnapshot: this.currentSnapshot,
      finalValidationSnapshot: this.finalValidationSnapshot,
      summaryReport,
      allowDestructive: allowDestructive === true
    });

    if (this.activeFinalPreflightContext?.executionId) {
      manifest.finalPreflightExecutionId = this.activeFinalPreflightContext.executionId;
    }

    // Confirmation Token の発行
    const tokenData = this.tokenManager.createToken(manifest);

    return { manifest, tokenData };
  }

  /**
   * Static Validation の実行と ValidationSnapshot の生成 (指示2, 6, 7, 9)
   */
  executeValidation(params: {
    schoolsFilePath?: string;
    profileFilePath?: string;
    credentialsFilePath?: string;
    expectedSchoolCount?: number;
    profile?: any;
    profileSnapshotId?: string;
  }): { snapshot: ValidationSnapshot; profileDetails: any; schoolsCount: number; enabledCount: number; schoolsPath?: string } {
    let desiredSettings: RequestedSettings;
    let effectiveProfileSnapshot: ProfileSnapshot;

    if (params.profile !== undefined) {
      // 1A. クライアントから渡された動的Profile (strict スキーマ検証 - 未知キー・不正値拒否)
      const parsedProfile = RequestedSettingsSchema.strict().safeParse(params.profile);
      if (!parsedProfile.success) {
        throw new AutomationError(
          'CONFIG_INVALID',
          `プロファイルスキーマ検証エラー: ${parsedProfile.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
        );
      }
      effectiveProfileSnapshot = this.createAndSetActiveProfileSnapshot(parsedProfile.data);
      desiredSettings = effectiveProfileSnapshot.requestedSettings;
    } else if (params.profileSnapshotId) {
      // 1B. 保存済みProfileSnapshot参照
      const snap = this.getProfileSnapshot(params.profileSnapshotId);
      if (!snap) {
        throw new AutomationError('CONFIG_INVALID', `指定されたProfile Snapshotが見つかりません: ${params.profileSnapshotId}`);
      }
      this.activeProfileSnapshot = snap;
      effectiveProfileSnapshot = snap;
      desiredSettings = snap.requestedSettings;
    } else {
      // 1C. ファイルからのロード
      const resolveExisting = (candidates: string[]): string => {
        for (const c of candidates) {
          if (fs.existsSync(path.resolve(process.cwd(), c))) return c;
        }
        return candidates[0];
      };
      const profilePath = params.profileFilePath || resolveExisting(['config/production-profile.live.json', 'config/production-profile.sample.json']);
      const resolvedProfile = path.resolve(process.cwd(), profilePath);
      if (!fs.existsSync(resolvedProfile)) {
        throw new AutomationError('CONFIG_INVALID', `プロファイル設定ファイルが見つかりません: ${resolvedProfile}`);
      }
      const rawProfile = JSON.parse(fs.readFileSync(resolvedProfile, 'utf-8'));
      const parsedProfile = RequestedSettingsSchema.strict().safeParse(rawProfile);
      if (!parsedProfile.success) {
        throw new AutomationError(
          'CONFIG_INVALID',
          `プロファイルスキーマ検証エラー: ${parsedProfile.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
        );
      }
      effectiveProfileSnapshot = this.createAndSetActiveProfileSnapshot(parsedProfile.data);
      desiredSettings = effectiveProfileSnapshot.requestedSettings;
    }

    const profileHash = effectiveProfileSnapshot.profileHash;
    const profileSnapshotId = effectiveProfileSnapshot.snapshotId;

    let schools: import('../types/batch').BatchSchoolItem[];
    let schoolsPath: string;
    let sourceName: string;

    const resolveExisting = (candidates: string[]): string => {
      for (const c of candidates) {
        if (fs.existsSync(path.resolve(process.cwd(), c))) return c;
      }
      return candidates[0];
    };

    if (this.inputSource === 'UPLOAD') {
      if (!this.activeUpload) {
        throw new AutomationError('CONFIG_INVALID', 'アップロードされたCSVデータが存在しません');
      }
      schools = this.activeUpload.schools;
      schoolsPath = this.activeUpload.originalFileName;
      sourceName = this.activeUpload.originalFileName;

      // 4. Credential Resolution (指示9: Uploaded CSV使用時はCredential fallback禁止)
      const enabledSchools = schools.filter((s) => s.enabled);
      for (const s of enabledSchools) {
        const cred = this.activeUpload.credentials[s.credentialRef];
        if (!cred || !cred.userId || !cred.password) {
          throw new AutomationError(
            'CREDENTIAL_NOT_FOUND',
            `学校 ${s.schoolCode} の認証情報がアップロードデータ内に見つかりません (credentialRef: ${s.credentialRef})`
          );
        }
      }
    } else {
      schoolsPath = params.schoolsFilePath || resolveExisting(['config/schools.live.csv', 'config/schools-live.csv', 'config/schools.sample.csv']);
      sourceName = schoolsPath;
      schools = loadSchoolsList(schoolsPath);

      // 4. Credential Resolution (Local mode: File or Env)
      const credentialsPath = params.credentialsFilePath || resolveExisting(['config/credentials.json', 'config/credentials.sample.json']);
      const envConfig = loadEnvConfig();
      let credProvider;
      if (fs.existsSync(path.resolve(process.cwd(), credentialsPath))) {
        credProvider = new FileCredentialProvider(path.resolve(process.cwd(), credentialsPath));
      } else {
        credProvider = new EnvCredentialProvider(envConfig.userId, envConfig.password);
      }
      validateCredentialsExist(schools, credProvider);
    }

    const schoolsHash = generateSchoolsHash(schools);
    const enabledSchools = schools.filter((s) => s.enabled);

    // 3. Expected School Count Gate
    if (params.expectedSchoolCount !== undefined && enabledSchools.length !== params.expectedSchoolCount) {
      throw new AutomationError(
        'BATCH_INPUT_INVALID',
        `有効学校数 (${enabledSchools.length}校) が指定された想定学校数 (${params.expectedSchoolCount}校) と一致しません`,
        { enabledCount: enabledSchools.length, expectedSchoolCount: params.expectedSchoolCount }
      );
    }

    const toolVersion = getToolVersion();
    const toolFingerprint = generateToolFingerprint();

    const snapshot: ValidationSnapshot = {
      profileHash,
      profileSnapshotId,
      schoolsHash,
      toolVersion,
      toolFingerprint,
      expectedSchoolCount: params.expectedSchoolCount,
      enabledSchoolCount: enabledSchools.length,
      totalSchoolCount: schools.length,
      resolvedCredentialsCount: enabledSchools.length,
      validatedAt: new Date().toISOString(),
      source: this.inputSource,
      sourceName
    };

    this.currentSnapshot = snapshot;
    this.currentJobState = 'READY';
    this.lastValidationParams = { ...params };

    return {
      snapshot,
      profileDetails: desiredSettings,
      schoolsCount: schools.length,
      enabledCount: enabledSchools.length,
      schoolsPath
    };
  }

  /**
   * 指示2, 13: 子プロセス用の一時ファイルを安全に materialize (Private Temp Directory 方式)
   */
  private materializeTempFiles(): { schoolsPath: string; credentialsPath?: string; profilePath?: string; privateDir?: string; cleanup: () => void } {
    const resolveExisting = (candidates: string[]): string => {
      for (const c of candidates) {
        if (fs.existsSync(path.resolve(process.cwd(), c))) return c;
      }
      return candidates[0];
    };

    if (this.inputSource === 'UPLOAD') {
      if (!this.activeUpload) {
        throw new ConsoleError('VALIDATION_REQUIRED', 'アップロードされた学校データが存在しません');
      }
      // 専用 private ディレクトリを作成 (指示4)
      const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manapoke-upload-'));
      const tempSchoolsPath = path.join(privateDir, 'schools.csv');
      const tempCredentialsPath = path.join(privateDir, 'credentials.json');

      // Public CSV のみ出力 (BOM + CRLF, RFC 4180 quote)
      const csvLines = [
        'schoolCode,schoolName,credentialRef,enabled',
        ...this.activeUpload.schools.map(
          (s) => `"${s.schoolCode.replace(/"/g, '""')}","${s.schoolName.replace(/"/g, '""')}","${s.credentialRef.replace(/"/g, '""')}",${s.enabled}`
        )
      ];
      fs.writeFileSync(tempSchoolsPath, '\uFEFF' + csvLines.join('\r\n'), { flag: 'wx', mode: 0o600, encoding: 'utf-8' });

      // Secret JSON のみ出力 (子プロセスに credentials ファイルとして渡す)
      fs.writeFileSync(tempCredentialsPath, JSON.stringify(this.activeUpload.credentials, null, 2), { flag: 'wx', mode: 0o600, encoding: 'utf-8' });

      // オーナーマーカーの保存
      const ownerInfo = {
        ownerPid: process.pid,
        createdAt: new Date().toISOString(),
        uploadId: this.activeUpload.uploadId
      };
      fs.writeFileSync(path.join(privateDir, 'owner.json'), JSON.stringify(ownerInfo, null, 2), { flag: 'wx', mode: 0o600, encoding: 'utf-8' });

      // Dynamic Profile Snapshot がある場合は private ディレクトリに出力
      let tempProfilePath: string | undefined;
      if (this.activeProfileSnapshot) {
        tempProfilePath = path.join(privateDir, 'profile.json');
        fs.writeFileSync(tempProfilePath, JSON.stringify(this.activeProfileSnapshot.requestedSettings, null, 2), { flag: 'wx', mode: 0o600, encoding: 'utf-8' });
      }

      const cleanup = () => {
        try {
          if (fs.existsSync(privateDir)) {
            fs.rmSync(privateDir, { recursive: true, force: true });
          }
        } catch {}
      };

      return {
        schoolsPath: tempSchoolsPath,
        credentialsPath: tempCredentialsPath,
        profilePath: tempProfilePath,
        privateDir,
        cleanup
      };
    } else {
      const schoolsPath = this.lastValidationParams.schoolsFilePath || resolveExisting(['config/schools.live.csv', 'config/schools-live.csv', 'config/schools.sample.csv']);
      const credentialsPath = this.lastValidationParams.credentialsFilePath || resolveExisting(['config/credentials.json', 'config/credentials.sample.json']);

      if (this.activeProfileSnapshot) {
        const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manapoke-profile-'));
        const tempProfilePath = path.join(privateDir, 'profile.json');
        fs.writeFileSync(tempProfilePath, JSON.stringify(this.activeProfileSnapshot.requestedSettings, null, 2), { flag: 'wx', mode: 0o600, encoding: 'utf-8' });

        const ownerInfo = {
          ownerPid: process.pid,
          createdAt: new Date().toISOString()
        };
        fs.writeFileSync(path.join(privateDir, 'owner.json'), JSON.stringify(ownerInfo, null, 2), { flag: 'wx', mode: 0o600, encoding: 'utf-8' });

        const cleanup = () => {
          try {
            if (fs.existsSync(privateDir)) {
              fs.rmSync(privateDir, { recursive: true, force: true });
            }
          } catch {}
        };

        return {
          schoolsPath,
          credentialsPath: fs.existsSync(path.resolve(process.cwd(), credentialsPath)) ? credentialsPath : undefined,
          profilePath: tempProfilePath,
          privateDir,
          cleanup
        };
      }

      return {
        schoolsPath,
        credentialsPath: fs.existsSync(path.resolve(process.cwd(), credentialsPath)) ? credentialsPath : undefined,
        cleanup: () => {}
      };
    }
  }

  /**
   * 現在選択中の Input のハッシュ (schoolsHash, profileHash) を取得 (RESULTS_STALE 判定用)
   */
  getCurrentInputHashes(params?: { profileFilePath?: string; schoolsFilePath?: string }): { schoolsHash: string; profileHash: string } | null {
    try {
      const resolveExisting = (candidates: string[]): string => {
        for (const c of candidates) {
          if (fs.existsSync(path.resolve(process.cwd(), c))) return c;
        }
        return candidates[0];
      };

      let profileHash: string;
      if (this.activeProfileSnapshot) {
        profileHash = this.activeProfileSnapshot.profileHash;
      } else {
        const profilePath = params?.profileFilePath || this.lastValidationParams?.profileFilePath || resolveExisting(['config/production-profile.live.json', 'config/production-profile.sample.json']);
        const resolvedProfile = path.resolve(process.cwd(), profilePath);
        if (!fs.existsSync(resolvedProfile)) return null;
        const rawProfile = JSON.parse(fs.readFileSync(resolvedProfile, 'utf-8'));
        const parsedProfile = RequestedSettingsSchema.safeParse(rawProfile);
        if (!parsedProfile.success) return null;
        profileHash = generateSettingsHash(parsedProfile.data);
      }

      let schools: import('../types/batch').BatchSchoolItem[];
      if (this.inputSource === 'UPLOAD') {
        if (!this.activeUpload) return null;
        schools = this.activeUpload.schools;
      } else {
        const schoolsPath = params?.schoolsFilePath || this.lastValidationParams?.schoolsFilePath || resolveExisting(['config/schools.live.csv', 'config/schools-live.csv', 'config/schools.sample.csv']);
        const resolvedSchools = path.resolve(process.cwd(), schoolsPath);
        if (!fs.existsSync(resolvedSchools)) return null;
        schools = loadSchoolsList(resolvedSchools);
      }
      const schoolsHash = generateSchoolsHash(schools);
      return { profileHash, schoolsHash };
    } catch {
      return null;
    }
  }

  /**
   * Preflight 開始前の二重安全 Gate: 現在のファイルから再度ハッシュ等を計算し Snapshot と比較 (指示2)
   */
  verifyValidationSnapshot(params: {
    schoolsFilePath?: string;
    profileFilePath?: string;
    credentialsFilePath?: string;
    expectedSchoolCount?: number;
  }): void {
    if (!this.currentSnapshot) {
      throw new ConsoleError('VALIDATION_REQUIRED', 'Preflightを実行する前に入力検証 (validate) を完了してください');
    }

    const effectiveParams = { ...this.lastValidationParams, ...params };
    const previousSnap = { ...this.currentSnapshot };
    const current = this.executeValidation(effectiveParams);

    if (
      current.snapshot.profileHash !== previousSnap.profileHash ||
      current.snapshot.schoolsHash !== previousSnap.schoolsHash ||
      current.snapshot.toolVersion !== previousSnap.toolVersion ||
      current.snapshot.toolFingerprint !== previousSnap.toolFingerprint ||
      current.snapshot.enabledSchoolCount !== previousSnap.enabledSchoolCount
    ) {
      this.currentJobState = 'VALIDATING';
      throw new ConsoleError(
        'VALIDATION_STALE',
        '前回の検証完了後に入力ファイルまたはツール環境が変更されました。Preflightを開始する前に再度「入力を検証」を実行してください'
      );
    }
  }

  /**
   * Child Process Boundary による Read-only Preflight 起動 (指示1, 3, 4, 8)
   * ※ shell: false, executable と args[] の完全分離, Writeフラグの物理的排除
   */
  /**
   * Phase 6A: Discovery プロセスの起動 (Read-only 現状調査, Profile不要・Writeフラグ物理排除)
   */
  startDiscoveryProcess(mode: 'START' | 'RESUME' | 'RETRY_FAILED' = 'START', params?: {
    schoolsFilePath?: string;
    credentialsFilePath?: string;
    expectedSchoolCount?: number;
    schoolTimeoutMs?: number;
    concurrency?: number;
  }): void {
    if (this.isAnyJobRunning()) {
      throw new ConsoleError('JOB_CONFLICT', 'すでに別のジョブが実行中または停止処理中です');
    }

    const effectiveParams = { ...this.lastValidationParams, ...params };

    // 0. sample CSV の Discovery 実行禁止
    if (this.inputSource === 'LOCAL_DEFAULT') {
      const resolveExisting = (candidates: string[]): string => {
        for (const c of candidates) {
          if (fs.existsSync(path.resolve(process.cwd(), c))) return c;
        }
        return candidates[0];
      };
      const effectiveSchools = effectiveParams.schoolsFilePath || resolveExisting(['config/schools.live.csv', 'config/schools-live.csv', 'config/schools.sample.csv']);
      const resolvedSchoolsPath = path.resolve(process.cwd(), effectiveSchools);
      const isSampleFile = resolvedSchoolsPath.endsWith('schools.sample.csv') || resolvedSchoolsPath.endsWith('schools-sample.csv');
      if (isSampleFile) {
        this.currentJobState = 'FAILED';
        throw new ConsoleError(
          'SAMPLE_DATA_BLOCKED',
          'サンプル学校データ (config/schools.sample.csv) による Discovery 実行は安全のため禁止されています。実際の学校データまたはアップロードCSVを使用してください'
        );
      }
    }

    if (!this.targetSnapshot) {
      this.executeTargetValidation(effectiveParams);
    }

    const discoveryExecutionId = `disc-exec-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    this.currentDiscoveryExecutionId = discoveryExecutionId;
    const observationOutputPath = path.join(getReportsDir(), `observation-${discoveryExecutionId}.json`);
    try {
      if (fs.existsSync(observationOutputPath)) {
        fs.unlinkSync(observationOutputPath);
      }
    } catch {}

    const tempFiles = this.materializeTempFiles();
    const schoolsPath = tempFiles.schoolsPath;
    const credentialsPath = tempFiles.credentialsPath;

    let isCleanedUp = false;
    const doCleanup = () => {
      if (!isCleanedUp) {
        isCleanedUp = true;
        tempFiles.cleanup();
      }
    };

    // 引数列構築: Profile関連・Write関連フラグは物理的に一切含めない (Exact Observation Binding)
    const args: string[] = [
      '-T',
      'src/index.ts',
      '--batch',
      '--purpose', 'discovery',
      '--execution-id', discoveryExecutionId,
      '--observation-output', observationOutputPath,
      '--schools', schoolsPath,
      '--target-snapshot-id', this.targetSnapshot!.targetSnapshotId
    ];

    if (this.targetSnapshot!.authMode) {
      args.push('--auth-mode', this.targetSnapshot!.authMode);
    }

    if (credentialsPath && fs.existsSync(path.resolve(process.cwd(), credentialsPath))) {
      args.push('--credentials', credentialsPath);
    }

    if (effectiveParams.expectedSchoolCount !== undefined) {
      args.push('--expected-school-count', String(effectiveParams.expectedSchoolCount));
    }

    if (effectiveParams.concurrency !== undefined && effectiveParams.concurrency > 1) {
      args.push('--concurrency', String(effectiveParams.concurrency));
    }

    if (mode === 'RESUME') {
      args.push('--resume');
    } else if (mode === 'RETRY_FAILED') {
      args.push('--resume', '--retry-failed');
    }

    if (effectiveParams.schoolTimeoutMs !== undefined) {
      args.push('--school-timeout-ms', String(effectiveParams.schoolTimeoutMs));
    }

    this.currentExecutionPurpose = 'DISCOVERY';
    this.spawnChildInternal(args, doCleanup, 'DISCOVERY');
  }

  /**
   * Phase 6A: Final Preflight プロセスの起動 (Write直前検証, Lineageバインド, executionId発行, Writeフラグ物理排除)
   */
  startFinalPreflightProcess(mode: 'START' | 'RESUME' | 'RETRY_FAILED' = 'START', params?: {
    schoolsFilePath?: string;
    credentialsFilePath?: string;
    expectedSchoolCount?: number;
    schoolTimeoutMs?: number;
  }): void {
    if (this.isAnyJobRunning()) {
      throw new ConsoleError('JOB_CONFLICT', 'すでに別のジョブが実行中または停止処理中です');
    }

    if (!this.targetSnapshot) {
      throw new ConsoleError('VALIDATION_REQUIRED', 'Target確定が必要です');
    }
    if (!this.activeProfileSnapshot) {
      throw new ConsoleError('VALIDATION_REQUIRED', 'Profile確定が必要です');
    }
    if (!this.finalValidationSnapshot) {
      this.executeFinalValidation();
    }
    if (this.targetSnapshot && this.finalValidationSnapshot && this.targetSnapshot.authMode !== this.finalValidationSnapshot.authMode) {
      throw new AutomationError(
        'CHECKPOINT_MISMATCH',
        `authMode 不一致: Target (${this.targetSnapshot.authMode}) と FinalValidation (${this.finalValidationSnapshot.authMode}) が一致しません`
      );
    }

    const effectiveParams = { ...this.lastValidationParams, ...params };

    // sample CSV の Preflight 実行禁止
    if (this.inputSource === 'LOCAL_DEFAULT') {
      const resolveExisting = (candidates: string[]): string => {
        for (const c of candidates) {
          if (fs.existsSync(path.resolve(process.cwd(), c))) return c;
        }
        return candidates[0];
      };
      const effectiveSchools = effectiveParams.schoolsFilePath || resolveExisting(['config/schools.live.csv', 'config/schools-live.csv', 'config/schools.sample.csv']);
      const resolvedSchoolsPath = path.resolve(process.cwd(), effectiveSchools);
      const isSampleFile = resolvedSchoolsPath.endsWith('schools.sample.csv') || resolvedSchoolsPath.endsWith('schools-sample.csv');
      if (isSampleFile) {
        this.currentJobState = 'FAILED';
        throw new ConsoleError(
          'SAMPLE_DATA_BLOCKED',
          'サンプル学校データ (config/schools.sample.csv) による Final Preflight 実行は安全のため禁止されています。実際の学校データまたはアップロードCSVを使用してください'
        );
      }
    }

    // 事前破棄: 新規Final Preflight起動時は過去のPreflight結果およびTokenを破棄
    this.activeFinalPreflightReport = null;
    this.activeFinalSummaryReport = null;
    this.activeFinalPreflightContext = null;
    this.tokenManager = new ConfirmationTokenManager();

    const finalPreflightExecutionId = `fp-exec-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    this.currentFinalPreflightExecutionId = finalPreflightExecutionId;

    // 事前クリーンアップ: 同一IDのアーティファクトが存在しないことを保証
    try {
      const reportsDir = getReportsDir();
      const pfFile = path.join(reportsDir, `preflight-${finalPreflightExecutionId}.json`);
      const smFile = path.join(reportsDir, `summary-${finalPreflightExecutionId}.json`);
      if (fs.existsSync(pfFile)) fs.unlinkSync(pfFile);
      if (fs.existsSync(smFile)) fs.unlinkSync(smFile);
    } catch {}

    const tempFiles = this.materializeTempFiles();
    const schoolsPath = tempFiles.schoolsPath;
    const credentialsPath = tempFiles.credentialsPath;
    const effectiveProfilePath = tempFiles.profilePath || 'config/production-profile.live.json';

    let isCleanedUp = false;
    const doCleanup = () => {
      if (!isCleanedUp) {
        isCleanedUp = true;
        tempFiles.cleanup();
      }
    };

    // 引数列構築: Write関連フラグは物理排除、executionId & Lineage IDを完全バインド
    const args: string[] = [
      '-T',
      'src/index.ts',
      '--batch',
      '--purpose', 'final-preflight',
      '--execution-id', finalPreflightExecutionId,
      '--schools', schoolsPath,
      '--profile', effectiveProfilePath,
      '--profile-snapshot-id', this.activeProfileSnapshot.snapshotId,
      '--target-snapshot-id', this.targetSnapshot.targetSnapshotId,
      '--final-validation-snapshot-id', this.finalValidationSnapshot!.finalValidationSnapshotId
    ];

    if (this.finalValidationSnapshot!.authMode) {
      args.push('--auth-mode', this.finalValidationSnapshot!.authMode);
    }

    if (credentialsPath && fs.existsSync(path.resolve(process.cwd(), credentialsPath))) {
      args.push('--credentials', credentialsPath);
    }

    if (effectiveParams.expectedSchoolCount !== undefined) {
      args.push('--expected-school-count', String(effectiveParams.expectedSchoolCount));
    }

    if (mode === 'RESUME') {
      args.push('--resume');
    } else if (mode === 'RETRY_FAILED') {
      args.push('--resume', '--retry-failed');
    }

    if (effectiveParams.schoolTimeoutMs !== undefined) {
      args.push('--school-timeout-ms', String(effectiveParams.schoolTimeoutMs));
    }

    this.currentExecutionPurpose = 'FINAL_PREFLIGHT';
    this.spawnChildInternal(args, doCleanup, 'FINAL_PREFLIGHT');
  }

  /**
   * Child Process Boundary による Read-only Preflight 起動 (後方互換用)
   */
  startBatchProcess(mode: 'START' | 'RESUME' | 'RETRY_FAILED', params: {
    schoolsFilePath?: string;
    profileFilePath?: string;
    credentialsFilePath?: string;
    expectedSchoolCount?: number;
    schoolTimeoutMs?: number;
  }): void {
    if (this.isAnyJobRunning()) {
      throw new ConsoleError('JOB_CONFLICT', 'すでに別のバッチ処理が実行中または停止処理中です');
    }

    const effectiveParams = { ...this.lastValidationParams, ...params };

    // 0. sample CSV の Preflight 実行禁止 (指示1: SAMPLE_DATA_BLOCKED)
    if (this.inputSource === 'LOCAL_DEFAULT') {
      const resolveExisting = (candidates: string[]): string => {
        for (const c of candidates) {
          if (fs.existsSync(path.resolve(process.cwd(), c))) return c;
        }
        return candidates[0];
      };
      const effectiveSchools = effectiveParams.schoolsFilePath || resolveExisting(['config/schools.live.csv', 'config/schools-live.csv', 'config/schools.sample.csv']);
      const resolvedSchoolsPath = path.resolve(process.cwd(), effectiveSchools);
      const isSampleFile = resolvedSchoolsPath.endsWith('schools.sample.csv') || resolvedSchoolsPath.endsWith('schools-sample.csv');
      if (isSampleFile) {
        this.currentJobState = 'FAILED';
        throw new ConsoleError(
          'SAMPLE_DATA_BLOCKED',
          'サンプル学校データ (config/schools.sample.csv) による Preflight 実行は安全のため禁止されています。実際の学校データまたはアップロードCSVを使用してください'
        );
      }
    }

    // 1. 二重安全Gate: Snapshot 再検証
    this.verifyValidationSnapshot(effectiveParams);

    const resolveExisting = (candidates: string[]): string => {
      for (const c of candidates) {
        if (fs.existsSync(path.resolve(process.cwd(), c))) return c;
      }
      return candidates[0];
    };
    const profilePath = effectiveParams.profileFilePath || resolveExisting(['config/production-profile.live.json', 'config/production-profile.sample.json']);

    // 2. 一時ファイルの安全な materialize (指示2, 13)
    const tempFiles = this.materializeTempFiles();
    const schoolsPath = tempFiles.schoolsPath;
    const credentialsPath = tempFiles.credentialsPath;
    const effectiveProfilePath = tempFiles.profilePath || profilePath;

    let isCleanedUp = false;
    const doCleanup = () => {
      if (!isCleanedUp) {
        isCleanedUp = true;
        tempFiles.cleanup();
      }
    };

    // 3. 引数列の厳格構築 (Write関連フラグは一切含めない = 既存仕様通りRead-only Preflight)
    const args: string[] = [
      '-T',
      'src/index.ts',
      '--batch',
      '--schools', schoolsPath,
      '--profile', effectiveProfilePath
    ];

    if (this.activeProfileSnapshot?.snapshotId) {
      args.push('--profile-snapshot-id', this.activeProfileSnapshot.snapshotId);
    }

    if (credentialsPath && fs.existsSync(path.resolve(process.cwd(), credentialsPath))) {
      args.push('--credentials', credentialsPath);
    }

    if (effectiveParams.expectedSchoolCount !== undefined) {
      args.push('--expected-school-count', String(effectiveParams.expectedSchoolCount));
    }

    if (mode === 'RESUME') {
      args.push('--resume');
    } else if (mode === 'RETRY_FAILED') {
      args.push('--resume', '--retry-failed');
    }

    if (effectiveParams.schoolTimeoutMs !== undefined) {
      args.push('--school-timeout-ms', String(effectiveParams.schoolTimeoutMs));
    }

    this.currentExecutionPurpose = 'FINAL_PREFLIGHT';
    this.spawnChildInternal(args, doCleanup, 'PREFLIGHT_DRY_RUN');
  }

  /**
   * 指示2.7, 5 & Phase 6A: Production Apply プロセス起動 (Process Boundary, 完全分離, 固定引数, Override禁止)
   */
  startProductionApplyProcess(confirmationToken: string, _includeDestructiveIgnored?: boolean): void {
    if (this.isAnyJobRunning()) {
      throw new ConsoleError('JOB_CONFLICT', 'すでに別のバッチ処理または本番反映が実行中または停止処理中です');
    }

    this.isApplyInFlight = true;
    this.activeExecutionResultContext = null;

    try {
      // トークン情報から allowDestructive および directApply の権限を確認
      const peekedToken = this.tokenManager.peekToken(confirmationToken);
      const isDestructiveAllowed = peekedToken?.allowDestructive === true;
      const isDirect = peekedToken?.directApply === true;

      let manifest: ApplyTargetManifest;
      let deploymentId: string;
      let runId: string;

      if (isDirect) {
        if (!this.observationSnapshot) {
          throw new AutomationError('CONFIG_INVALID', '有効な Observation Snapshot が見つかりません');
        }
        if (!this.activeProfileSnapshot) {
          throw new AutomationError('CONFIG_INVALID', '有効な Profile Snapshot が見つかりません');
        }

        manifest = validateGlobalGateAndBuildManifest({
          observationSnapshot: this.observationSnapshot,
          activeProfileSnapshot: this.activeProfileSnapshot,
          currentValidationSnapshot: this.currentSnapshot,
          finalValidationSnapshot: this.finalValidationSnapshot,
          allowDestructive: isDestructiveAllowed,
          directApply: true
        });

        deploymentId = `direct-dep-${this.observationSnapshot.observationSnapshotId}`;
        runId = `direct-run-${Date.now()}`;
      } else {
        if (!this.activeFinalPreflightContext || !this.currentFinalPreflightExecutionId || this.activeFinalPreflightContext.executionId !== this.currentFinalPreflightExecutionId) {
          throw new AutomationError('CONFIG_INVALID', '有効な Final Preflight レポートが見つかりません。現在のワークフローで先に Final Preflight を実行してください');
        }

        const preflightReport = this.activeFinalPreflightContext.report;
        const summaryReport = this.activeFinalPreflightContext.summary;

        let effectiveProfileSnapshot = this.activeProfileSnapshot;
        if (!effectiveProfileSnapshot && preflightReport) {
          const snapId = this.finalValidationSnapshot?.profileSnapshotId || preflightReport.profileSnapshotId;
          if (snapId && this.profileSnapshots.has(snapId)) {
            effectiveProfileSnapshot = this.profileSnapshots.get(snapId)!;
            this.activeProfileSnapshot = effectiveProfileSnapshot;
          }
        }

        // Global Gate 再検証 & Manifest 導出 (Phase 6B: トークンに付与された allowDestructive を反映)
        manifest = validateGlobalGateAndBuildManifest({
          preflightReport,
          activeProfileSnapshot: effectiveProfileSnapshot,
          currentValidationSnapshot: this.currentSnapshot,
          finalValidationSnapshot: this.finalValidationSnapshot,
          summaryReport,
          allowDestructive: isDestructiveAllowed
        });
        manifest.finalPreflightExecutionId = this.activeFinalPreflightContext.executionId;

        deploymentId = this.activeFinalPreflightContext.deploymentId;
        runId = this.activeFinalPreflightContext.runId;
      }

      // Confirmation Token の厳格検証と一回限り消費 (再利用・二重実行防止)
      this.tokenManager.verifyAndConsumeToken(confirmationToken, manifest);

      const productionExecutionId = `prod-exec-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      this.currentProductionExecutionId = productionExecutionId;
      const exactSummaryPath = getProductionSummaryPath(productionExecutionId);
      const exactContextPath = getContextArtifactPath(productionExecutionId);

      // 初期 Ledger を RUNNING で atomic 保存
      writeCurrentLedger({
        schemaVersion: '1.0',
        executionId: productionExecutionId,
        state: 'RUNNING',
        deploymentId,
        runId,
        profileSnapshotId: manifest.profileSnapshotId,
        finalPreflightExecutionId: manifest.finalPreflightExecutionId || this.currentFinalPreflightExecutionId || undefined,
        finalValidationSnapshotId: manifest.finalValidationSnapshotId,
        profileHash: manifest.profileHash,
        schoolsHash: manifest.schoolsHash,
        applyTargetHash: manifest.applyTargetHash,
        startedAt: new Date().toISOString(),
        summaryPath: exactSummaryPath,
        contextPath: exactContextPath
      });

      // 一時ファイルの安全な materialize
      const tempFiles = this.materializeTempFiles();
      const schoolsPath = tempFiles.schoolsPath;
      const credentialsPath = tempFiles.credentialsPath;
      const effectiveProfilePath = tempFiles.profilePath || 'config/production-profile.live.json';

      let isCleanedUp = false;
      const doCleanup = () => {
        if (!isCleanedUp) {
          isCleanedUp = true;
          tempFiles.cleanup();
        }
      };

      // 厳格な引数列構築: Write関連フラグを明示付与, --allow-destructive は合意トークン時のみ付与
      const args: string[] = [
        '-T',
        'src/index.ts',
        '--batch',
        '--apply',
        '--allow-live-write',
        '--batch-apply',
        '--schools', schoolsPath,
        '--profile', effectiveProfilePath,
        '--execution-id', productionExecutionId,
        '--deployment-id', deploymentId,
        '--clear-stale-lock',
        '--summary-output', exactSummaryPath,
        '--apply-target-hash', manifest.applyTargetHash
      ];

      if (isDestructiveAllowed) {
        args.push('--allow-destructive');
      }

      if (this.activeProfileSnapshot?.snapshotId) {
        args.push('--profile-snapshot-id', this.activeProfileSnapshot.snapshotId);
      }

      if (credentialsPath && fs.existsSync(path.resolve(process.cwd(), credentialsPath))) {
        args.push('--credentials', credentialsPath);
      }

      const pfPath = path.resolve(getReportsDir(), `preflight-${manifest.preflightId}.json`);
      if (fs.existsSync(pfPath)) {
        args.push('--preflight-report', pfPath);
      }

      this.currentExecutionPurpose = 'PRODUCTION_WRITE';
      this.spawnChildInternal(args, doCleanup, 'PRODUCTION_WRITE');
    } catch (err) {
      this.isApplyInFlight = false;
      throw err;
    }
  }

  /**
   * 最新 Observation Snapshot のロード
   */
  loadLatestObservationSnapshot(): ObservationSnapshot | null {
    try {
      const reportsDir = getReportsDir();
      if (!fs.existsSync(reportsDir)) return null;
      const files = fs.readdirSync(reportsDir).filter((f) => f.startsWith('observation-') && f.endsWith('.json'));
      if (files.length === 0) return null;
      files.sort((a, b) => fs.statSync(path.join(reportsDir, b)).mtimeMs - fs.statSync(path.join(reportsDir, a)).mtimeMs);

      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(reportsDir, file), 'utf-8');
          const obs: ObservationSnapshot = JSON.parse(content);
          if (!this.targetSnapshot || obs.targetSnapshotId === this.targetSnapshot.targetSnapshotId) {
            this.observationSnapshot = obs;
            return obs;
          }
        } catch {}
      }
    } catch {}
    return null;
  }

  /**
   * バインドされた最新 Final Preflight レポートのロード (ディスク探索fallback完全撤廃)
   */
  loadLatestFinalPreflightReport(): { preflight: PreflightReport | null; summary: any | null } {
    if (this.activeFinalPreflightContext) {
      return {
        preflight: this.activeFinalPreflightContext.report,
        summary: this.activeFinalPreflightContext.summary
      };
    }
    return { preflight: null, summary: null };
  }

  loadLatestPreflightReport(): { preflight: PreflightReport | null; summary: any | null } {
    if (this.activeFinalPreflightContext) {
      return {
        preflight: this.activeFinalPreflightContext.report,
        summary: this.activeFinalPreflightContext.summary
      };
    }
    return this.loadLatestFinalPreflightReport();
  }

  /**
   * 共通子プロセス起動ロジック (shell: false, executable + args[] 分離)
   */
  private spawnChildInternal(args: string[], doCleanup: () => void, executionMode: 'PREFLIGHT_DRY_RUN' | 'PRODUCTION_WRITE' | 'DISCOVERY' | 'FINAL_PREFLIGHT'): void {
    let tsNodeBin: string;
    try {
      tsNodeBin = require.resolve('ts-node/dist/bin.js');
    } catch {
      const localFallback = path.resolve(process.cwd(), 'node_modules/ts-node/dist/bin.js');
      if (fs.existsSync(localFallback)) {
        tsNodeBin = localFallback;
      } else {
        doCleanup();
        this.currentJobState = 'FAILED';
        this.emit('stateChange', { state: this.currentJobState, error: 'ts-node entrypoint not found' });
        throw new ConsoleError('PROCESS_SPAWN_FAILED', 'ts-node の実行エントリポイント (ts-node/dist/bin.js) が解決できません');
      }
    }

    const execCmd = process.execPath;
    const spawnArgs = [tsNodeBin, ...args];

    this.currentJobState = 'RUNNING';
    this.runStartedAt = Date.now();
    this.currentRunId = `run-${this.runStartedAt}`;
    this.stdoutBuffer = [];

    this.emit('stateChange', { state: this.currentJobState, runId: this.currentRunId, mode: executionMode });

    this.lastSpawnInfo = {
      command: execCmd,
      args: spawnArgs,
      env: process.env
    };

    try {
      this.childProcess = this.spawnFn(execCmd, spawnArgs, {
        cwd: process.cwd(),
        shell: false,
        env: process.env
      });
    } catch (err: any) {
      doCleanup();
      this.currentJobState = 'FAILED';
      this.childProcess = null;
      this.emit('stateChange', { state: this.currentJobState, error: err.message, mode: executionMode });
      throw new ConsoleError('PROCESS_SPAWN_FAILED', `子プロセスの起動に失敗しました: ${err.message}`);
    }

    this.childProcess.on('error', (err: Error) => {
      doCleanup();
      this.cleanupProgressPoller();
      this.currentJobState = 'FAILED';
      this.childProcess = null;
      this.emit('stateChange', { state: this.currentJobState, error: err.message, mode: executionMode });
    });

    this.childProcess.stdout?.on('data', (chunk: Buffer) => {
      const text = sanitizeString(chunk.toString('utf-8'));
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
      for (const line of lines) {
        this.stdoutBuffer.push(line);
        this.emit('log', line);
      }
      this.inspectStdoutForProgress(text);
    });

    this.childProcess.stderr?.on('data', (chunk: Buffer) => {
      const text = sanitizeString(chunk.toString('utf-8'));
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
      for (const line of lines) {
        this.stdoutBuffer.push(`[STDERR] ${line}`);
        this.emit('log', `[STDERR] ${line}`);
      }
    });

    this.childProcess.on('exit', (code, signal) => {
      doCleanup();
      this.cleanupProgressPoller();
      if (this.stopFallbackTimer) {
        clearTimeout(this.stopFallbackTimer);
        this.stopFallbackTimer = null;
      }
      if (this.currentJobState === 'STOPPING') {
        this.currentJobState = 'INTERRUPTED'; // 安全停止完了時は INTERRUPTED
      } else if (code === 0) {
        this.currentJobState = 'COMPLETED';
        // 完了時に最新のチェックポイントをポーリングして正確な確定値を取得
        this.pollStructuredProgress();
        const total = this.targetSnapshot?.enabledSchoolCount || this.currentSnapshot?.enabledSchoolCount || 1;
        const elapsedSeconds = this.runStartedAt ? Math.floor((Date.now() - this.runStartedAt) / 1000) : 0;
        const finalSuccess = this.lastProgressInfo ? this.lastProgressInfo.success : total;
        const finalFailed = this.lastProgressInfo ? this.lastProgressInfo.failed : 0;
        const finalProcessed = this.lastProgressInfo ? this.lastProgressInfo.processed : total;
        this.emit('progress', {
          processed: finalProcessed,
          total,
          percentage: 100,
          success: finalSuccess,
          failed: finalFailed,
          remaining: Math.max(0, total - finalProcessed),
          elapsedSeconds,
          estimatedRemainingSeconds: 0
        });
      } else {
        this.currentJobState = 'FAILED';
      }

      // 完了時の結果ロード & Lineage / Invalidation 処理
      if (executionMode === 'DISCOVERY') {
        const execId = this.currentDiscoveryExecutionId;
        let obs: ObservationSnapshot | null = null;
        if (execId) {
          const obsPath = path.join(getReportsDir(), `observation-${execId}.json`);
          if (fs.existsSync(obsPath)) {
            try {
              const parsed = JSON.parse(fs.readFileSync(obsPath, 'utf-8'));
              if (parsed && (!this.targetSnapshot || !parsed.targetSnapshotId || parsed.targetSnapshotId === this.targetSnapshot.targetSnapshotId)) {
                obs = parsed;
                this.observationSnapshot = obs;
              }
            } catch (e: any) {
              console.error('[ConsoleAdapter] Error loading exact Discovery observation for execution', execId, e);
            }
          }
        }
        if (obs) {
          // Discovery完了時は下流を安全にinvalidate
          if (this.draftProfile) {
            this.invalidateDraft('DISCOVERY_UPDATED');
          }
          this.emit('discoveryCompleted', { observationSnapshot: obs });
        }
      } else if (executionMode === 'FINAL_PREFLIGHT') {
        const execId = this.currentFinalPreflightExecutionId;
        let boundSuccessfully = false;

        if (code === 0 && execId) {
          try {
            const reportsDir = getReportsDir();
            const pfPath = path.join(reportsDir, `preflight-${execId}.json`);
            const smPath = path.join(reportsDir, `summary-${execId}.json`);

            if (fs.existsSync(pfPath) && fs.existsSync(smPath)) {
              const pf: PreflightReport = JSON.parse(fs.readFileSync(pfPath, 'utf-8'));
              const sm: any = JSON.parse(fs.readFileSync(smPath, 'utf-8'));

              const matchesExec = pf.executionId === execId && (!sm.executionId || sm.executionId === execId);
              const matchesPurpose = pf.purpose === 'FINAL_PREFLIGHT';
              const matchesValSnap = !this.finalValidationSnapshot || pf.finalValidationSnapshotId === this.finalValidationSnapshot.finalValidationSnapshotId;
              const matchesProfSnap = !this.activeProfileSnapshot || pf.profileSnapshotId === this.activeProfileSnapshot.snapshotId;
              const matchesAuth = !this.finalValidationSnapshot || !pf.authMode || pf.authMode === this.finalValidationSnapshot.authMode;

              if (matchesExec && matchesPurpose && matchesValSnap && matchesProfSnap && matchesAuth && this.finalValidationSnapshot && this.activeProfileSnapshot && this.targetSnapshot) {
                this.activeFinalPreflightReport = pf;
                this.activeFinalSummaryReport = sm;
                const now = new Date();
                const validUntil = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
                this.activeFinalPreflightContext = {
                  executionId: execId,
                  deploymentId: pf.deploymentId,
                  runId: pf.runId,
                  targetSnapshotId: this.targetSnapshot.targetSnapshotId,
                  observationSnapshotId: this.observationSnapshot?.observationSnapshotId || this.finalValidationSnapshot.observationSnapshotId,
                  profileSnapshotId: this.activeProfileSnapshot.snapshotId,
                  finalValidationSnapshotId: this.finalValidationSnapshot.finalValidationSnapshotId,
                  authMode: (pf.authMode || this.finalValidationSnapshot.authMode) as 'A' | 'B',
                  schoolsHash: this.targetSnapshot.schoolsHash,
                  toolFingerprint: this.targetSnapshot.toolFingerprint,
                  report: pf,
                  summary: sm,
                  completedAt: now.toISOString(),
                  validUntil
                };
                boundSuccessfully = true;
                this.emit('finalPreflightCompleted', { report: pf, summary: sm });
              }
            }
          } catch (e: any) {
            console.error('[ConsoleAdapter] Error loading Final Preflight result for execution', execId, e);
          }
        }

        if (!boundSuccessfully) {
          // Fail-closed
          this.activeFinalPreflightReport = null;
          this.activeFinalSummaryReport = null;
          this.activeFinalPreflightContext = null;
        }
      } else if (executionMode === 'PRODUCTION_WRITE') {
        let boundSuccessfully = false;
        const execId = this.currentProductionExecutionId;
        try {
          if (execId) {
            const targetSummaryPath = getProductionSummaryPath(execId);
            if (fs.existsSync(targetSummaryPath)) {
              const summary: BatchSummaryReport = JSON.parse(fs.readFileSync(targetSummaryPath, 'utf-8'));
              const matchesExec = summary.executionId === execId || summary.productionExecutionId === execId;
              const matchesMode = summary.mode === 'PRODUCTION_WRITE';
              const matchesTargetSnap = !this.targetSnapshot || !summary.targetSnapshotId || summary.targetSnapshotId === this.targetSnapshot.targetSnapshotId;
              const matchesProfSnap = !this.activeProfileSnapshot || !summary.profileSnapshotId || summary.profileSnapshotId === this.activeProfileSnapshot.snapshotId;

              if (matchesExec && matchesMode && matchesTargetSnap && matchesProfSnap) {
                const viewModel = normalizeExecutionResult(summary);
                const context: ActiveExecutionResultContext = {
                  productionExecutionId: execId,
                  deploymentId: summary.deploymentId,
                  runId: summary.runId,
                  mode: 'PRODUCTION_WRITE',
                  summary,
                  viewModel,
                  completedAt: summary.finishedAt || new Date().toISOString()
                };

                // Context artifact を永続化
                writeContextArtifact(context);

                // Current Ledger を COMPLETED へ atomic 更新
                updateCurrentLedgerState('COMPLETED', {
                  finishedAt: context.completedAt
                });

                this.activeExecutionResultContext = context;
                boundSuccessfully = true;

                // イベント順序保証: productionApplyCompleted を stateChange より先に送出
                this.emit('productionApplyCompleted', { context: this.activeExecutionResultContext });
              } else {
                console.error('[ConsoleAdapter] Lineage mismatch for Production Summary:', {
                  summaryExec: summary.executionId,
                  expectedExec: execId,
                  matchesExec,
                  matchesMode,
                  matchesTargetSnap,
                  matchesProfSnap
                });
              }
            }
          }
        } catch (e: any) {
          console.error('[ConsoleAdapter] Error loading Production Apply result:', e);
        }

        if (!boundSuccessfully) {
          this.activeExecutionResultContext = null;
          if (execId) {
            const errorTail = this.stdoutBuffer.filter(l => l.includes('Error') || l.includes('ERROR') || l.includes('異常') || l.includes('拒絶')).slice(-3).join('; ');
            updateCurrentLedgerState('RESULT_INVALID', {
              finishedAt: new Date().toISOString(),
              errorMessage: errorTail ? `Production failed: ${errorTail}` : 'Production result binding failed or summary missing'
            });
          }
        }
        this.isApplyInFlight = false;
      }

      this.childProcess = null;
      this.emit('stateChange', { state: this.currentJobState, exitCode: code, signal, mode: executionMode });
    });

    // 定期的に Checkpoint / Progress をポーリング (Structured Data SSOT: 指示9)
    this.startProgressPoller();
  }

  stopDiscoveryProcess(): void {
    this.stopBatchProcess();
  }

  stopFinalPreflightProcess(): void {
    this.stopBatchProcess();
  }

  /**
   * 安全停止 (Graceful Shutdown): OS signalに依存せず stdin 制御メッセージで停止要求 (指示3, 4, 5)
   */
  stopBatchProcess(): void {
    if (this.currentJobState !== 'RUNNING') {
      throw new ConsoleError('JOB_NOT_RUNNING', '現在実行中のバッチ処理はありません');
    }

    this.currentJobState = 'STOPPING';
    this.emit('stateChange', { state: this.currentJobState });

    if (this.childProcess) {
      // 1. アプリケーションレベルの STOP コマンドを stdin 経由で送信 (OSシグナル非依存)
      try {
        if (this.childProcess.stdin && !this.childProcess.stdin.destroyed) {
          this.childProcess.stdin.write(JSON.stringify({ command: 'STOP' }) + '\n');
        }
      } catch (err: any) {
        console.error('[ConsoleAdapter] Failed to write STOP to child stdin:', err.message);
      }

      // 2. POSIX環境では補助的に SIGINT も送信 (Windows では TerminateProcess となるため送信しない)
      if (process.platform !== 'win32') {
        try {
          this.childProcess.kill('SIGINT');
        } catch {}
      }

      // 3. Fallback タイマー: 一定時間内に Graceful 終了しない場合は Force Terminate
      if (this.stopFallbackTimer) {
        clearTimeout(this.stopFallbackTimer);
      }
      this.stopFallbackTimer = setTimeout(() => {
        if (this.childProcess && this.currentJobState === 'STOPPING') {
          console.warn(`[ConsoleAdapter] Graceful stop timed out after ${this.stopFallbackTimeoutMs}ms. Triggering Force Terminate Fallback...`);
          this.currentJobState = 'FAILED';
          try {
            this.childProcess.kill(); // 強制終了
          } catch {}
          this.emit('stateChange', { state: this.currentJobState, error: 'FORCE_TERMINATED' });
        }
      }, this.stopFallbackTimeoutMs);
    }
  }

  /**
   * Checkpoint などの Structured Data から進捗を取得 (SSOT)
   */
  private startProgressPoller(): void {
    this.cleanupProgressPoller();
    this.progressInterval = setInterval(() => {
      this.pollStructuredProgress();
    }, 1000);
  }

  private cleanupProgressPoller(): void {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }
  }

  private pollStructuredProgress(): void {
    if (!this.runStartedAt || this.currentJobState !== 'RUNNING') return;

    const elapsedSeconds = Math.floor((Date.now() - this.runStartedAt) / 1000);

    // 最新のチェックポイントファイルを探索 (Discovery時は discovery-checkpoint- を優先)
    try {
      const checkpointsDir = getCheckpointsDir();
      if (fs.existsSync(checkpointsDir)) {
        const isDiscovery = this.currentExecutionPurpose === 'DISCOVERY';
        const prefix = isDiscovery ? 'discovery-checkpoint-' : 'checkpoint-';
        const files = fs.readdirSync(checkpointsDir).filter((f) => f.startsWith(prefix) && f.endsWith('.json'));
        if (files.length > 0) {
          files.sort((a, b) => fs.statSync(path.join(checkpointsDir, b)).mtimeMs - fs.statSync(path.join(checkpointsDir, a)).mtimeMs);
          const latestFile = path.join(checkpointsDir, files[0]);
          const cpData = JSON.parse(fs.readFileSync(latestFile, 'utf-8'));

          const entriesObj = cpData.entries || cpData.schools || {};
          const entries = Object.values(entriesObj) as any[];
          if (entries.length > 0 || cpData.deploymentId) {
            const processed = entries.filter((e) => e.status !== 'PENDING' && e.status !== 'RUNNING').length;
            const success = entries.filter((e) => e.status === 'SUCCESS' || e.status === 'SUCCESS_ALREADY_CONFIGURED').length;
            const failed = entries.filter((e) => e.status === 'FAILED' || e.status === 'TIMEOUT').length;
            const total = this.currentSnapshot?.enabledSchoolCount || cpData.totalSchools || cpData.total || entries.length;
            const remaining = Math.max(0, total - processed);
            const percentage = total > 0 ? Math.round((processed / total) * 100) : 0;

            let estimatedRemainingSeconds: number | null = null;
            if (processed > 0 && remaining > 0) {
              const secPerSchool = elapsedSeconds / processed;
              estimatedRemainingSeconds = Math.round(secPerSchool * remaining);
            }

            const currentSchoolEntry = entries.find((e) => e.status === 'RUNNING');
            const currentSchool = currentSchoolEntry
              ? { schoolCode: currentSchoolEntry.schoolCode, schoolName: currentSchoolEntry.schoolName || '' }
              : undefined;

            const progressInfo: BatchProgressInfo = {
              processed,
              total,
              percentage,
              success,
              failed,
              remaining,
              elapsedSeconds,
              estimatedRemainingSeconds,
              currentSchool
            };

            this.lastProgressInfo = progressInfo;
            this.emit('progress', progressInfo);
            return;
          }
        }
      }
    } catch {
      // ポーリングエラー時は無視
    }
  }

  private inspectStdoutForProgress(text: string): void {
    const elapsedSeconds = this.runStartedAt ? Math.floor((Date.now() - this.runStartedAt) / 1000) : 0;

    // パターン1: [1/3] SCH001 - SUCCESS (経過: 4.2s, 成功: 1, 失敗: 0, 残り: 2)
    const matchEnd = text.match(/\[(\d+)\/(\d+)\]\s+([A-Za-z0-9_-]+)\s+-\s+(\w+)\s+\(経過:\s*[^,]+,\s*成功:\s*(\d+),\s*失敗:\s*(\d+),\s*残り:\s*(\d+)\)/);
    if (matchEnd) {
      const processed = parseInt(matchEnd[1], 10);
      const total = parseInt(matchEnd[2], 10);
      const success = parseInt(matchEnd[5], 10);
      const failed = parseInt(matchEnd[6], 10);
      const remaining = parseInt(matchEnd[7], 10);
      const info: BatchProgressInfo = {
        processed,
        total,
        percentage: total > 0 ? Math.round((processed / total) * 100) : 0,
        success,
        failed,
        remaining,
        elapsedSeconds,
        estimatedRemainingSeconds: processed > 0 && remaining > 0 ? Math.round((elapsedSeconds / processed) * remaining) : 0
      };
      this.lastProgressInfo = info;
      this.emit('progress', info);
      return;
    }

    // パターン2: [1/3] 学校処理開始: テスト第一小学校 (SCH001)
    const matchStart = text.match(/\[(\d+)\/(\d+)\]\s+学校処理開始:\s*(.+?)\s*\((.+?)\)/);
    if (matchStart) {
      const currentIdx = parseInt(matchStart[1], 10);
      const total = parseInt(matchStart[2], 10);
      const schoolName = matchStart[3].trim();
      const schoolCode = matchStart[4].trim();
      const processed = Math.max(0, currentIdx - 1);
      // 学校開始ログからは成否カウント(success, failed)を捏造・上書きせず、確定値を引き継ぐ
      this.emit('progress', {
        processed: Math.max(processed, this.lastProgressInfo?.processed || 0),
        total,
        percentage: total > 0 ? Math.round((Math.max(processed, this.lastProgressInfo?.processed || 0) / total) * 100) : 0,
        success: this.lastProgressInfo?.success,
        failed: this.lastProgressInfo?.failed,
        remaining: Math.max(0, total - Math.max(processed, this.lastProgressInfo?.processed || 0)),
        elapsedSeconds,
        estimatedRemainingSeconds: this.lastProgressInfo?.estimatedRemainingSeconds ?? null,
        currentSchool: { schoolCode, schoolName }
      });
      return;
    }

    // パターン3: 補助的な進捗通知 (進捗: 1 / 3)
    const matchFallback = text.match(/進捗:\s*(\d+)\s*\/\s*(\d+)/);
    if (matchFallback) {
      const processed = parseInt(matchFallback[1], 10);
      const total = parseInt(matchFallback[2], 10);
      // 補助進捗ログからも成否カウント(success, failed)を捏造せず、確定値を引き継ぐ
      this.emit('progress', {
        processed: Math.max(processed, this.lastProgressInfo?.processed || 0),
        total,
        percentage: Math.round((Math.max(processed, this.lastProgressInfo?.processed || 0) / total) * 100),
        success: this.lastProgressInfo?.success,
        failed: this.lastProgressInfo?.failed,
        remaining: Math.max(0, total - Math.max(processed, this.lastProgressInfo?.processed || 0)),
        elapsedSeconds,
        estimatedRemainingSeconds: this.lastProgressInfo?.estimatedRemainingSeconds ?? null
      });
    }
  }
}
