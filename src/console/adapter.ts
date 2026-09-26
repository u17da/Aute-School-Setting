import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { ValidationSnapshot, ConsoleJobState, ConsoleError, ActiveUploadedBatch, InputDataSource, ProfileSnapshot } from './types';
import { loadSchoolsList, validateCredentialsExist } from '../batch/runBatch';
import { RequestedSettingsSchema } from '../config/schema';
import { RequestedSettings } from '../types/config';
import { generateSettingsHash, generateSchoolsHash, getToolVersion, generateToolFingerprint } from '../utils/hash';
import { FileCredentialProvider, EnvCredentialProvider } from '../batch/credentialProvider';
import { loadEnvConfig } from '../config/loader';
import { AutomationError } from '../types/errors';
import { sanitizeString } from './sanitizer';
import { validateGlobalGateAndBuildManifest, ConfirmationTokenManager } from './manifest';
import { PreflightReport, ApplyTargetManifest, ConfirmationTokenData } from '../types/batch';

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
  private profileSnapshots: Map<string, ProfileSnapshot> = new Map();
  private activeProfileSnapshot: ProfileSnapshot | null = null;
  private runStartedAt: number | null = null;
  private currentRunId: string | null = null;
  private progressInterval: NodeJS.Timeout | null = null;
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

  getInputSource(): InputDataSource {
    return this.inputSource;
  }

  setInputSource(source: InputDataSource): void {
    if (this.currentJobState === 'RUNNING' || this.currentJobState === 'STOPPING') {
      throw new ConsoleError('JOB_CONFLICT', 'ジョブ実行中または停止処理中は入力ソースを変更できません');
    }
    this.inputSource = source;
    this.invalidateValidation('SOURCE_CHANGED');
  }

  setUploadedBatch(batch: ActiveUploadedBatch): void {
    if (this.currentJobState === 'RUNNING' || this.currentJobState === 'STOPPING') {
      throw new ConsoleError('JOB_CONFLICT', 'ジョブ実行中または停止処理中は新しいCSVをアップロードできません');
    }
    // 旧アップロードの置換と秘密情報参照の切断
    this.activeUpload = batch;
    this.inputSource = 'UPLOAD';
    this.invalidateValidation('BATCH_UPLOADED');
  }

  getActiveProfileSnapshot(): ProfileSnapshot | null {
    return this.activeProfileSnapshot;
  }

  getProfileSnapshot(id: string): ProfileSnapshot | undefined {
    return this.profileSnapshots.get(id);
  }

  createAndSetActiveProfileSnapshot(requestedSettings: RequestedSettings): ProfileSnapshot {
    const profileHash = generateSettingsHash(requestedSettings);
    const snapshotId = `prof-snap-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const snapshot: ProfileSnapshot = {
      snapshotId,
      profileHash,
      requestedSettings: { ...requestedSettings },
      createdAt: new Date().toISOString()
    };
    this.profileSnapshots.set(snapshotId, snapshot);
    this.activeProfileSnapshot = snapshot;
    return snapshot;
  }

  invalidateValidation(reason?: string): void {
    this.currentSnapshot = null;
    if (this.currentJobState === 'READY' || this.currentJobState === 'VALIDATING') {
      this.currentJobState = 'IDLE';
    }
    this.emit('stateChange', { state: this.currentJobState, reason: reason || 'VALIDATION_INVALIDATED' });
    this.emit('snapshotInvalidated', { reason });
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

  loadLatestPreflightReport(): { preflight: PreflightReport | null; summary: any | null } {
    const dir = path.resolve(process.cwd(), 'reports');
    if (!fs.existsSync(dir)) return { preflight: null, summary: null };

    const pfFiles = fs.readdirSync(dir).filter((f) => f.startsWith('preflight-') && f.endsWith('.json'));
    if (pfFiles.length === 0) return { preflight: null, summary: null };
    pfFiles.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
    const latestPfFile = path.join(dir, pfFiles[0]);

    let preflight: PreflightReport | null = null;
    let summary: any | null = null;

    try {
      preflight = JSON.parse(fs.readFileSync(latestPfFile, 'utf-8'));
    } catch {
      return { preflight: null, summary: null };
    }

    if (preflight && (preflight.deploymentId || preflight.runId)) {
      const summaryFile = path.join(dir, `summary-${preflight.deploymentId || preflight.runId}.json`);
      if (fs.existsSync(summaryFile)) {
        try {
          summary = JSON.parse(fs.readFileSync(summaryFile, 'utf-8'));
        } catch {}
      }
    }

    return { preflight, summary };
  }

  /**
   * 指示5: Production Apply の準備 (Global Gate 検証, Manifest 生成, Confirmation Token 発行)
   */
  prepareProductionApply(customPreflight?: PreflightReport, customSummary?: any): { manifest: ApplyTargetManifest; tokenData: ConfirmationTokenData } {
    if (this.currentJobState === 'RUNNING' || this.currentJobState === 'STOPPING') {
      throw new ConsoleError('JOB_CONFLICT', '現在別の処理が実行中または停止処理中のため、Production Applyの準備を開始できません');
    }

    let preflightReport: PreflightReport | null = customPreflight || null;
    let summaryReport: any | null = customSummary || null;

    if (!preflightReport) {
      const loaded = this.loadLatestPreflightReport();
      preflightReport = loaded.preflight;
      summaryReport = loaded.summary;
    }

    if (!preflightReport) {
      throw new AutomationError('CONFIG_INVALID', 'Preflight レポートが見つかりません。先に Preflight を実行してください');
    }

    // Global Gate 検証と Manifest 導出
    const manifest = validateGlobalGateAndBuildManifest({
      preflightReport,
      activeProfileSnapshot: this.activeProfileSnapshot,
      currentValidationSnapshot: this.currentSnapshot,
      summaryReport
    });

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
  startBatchProcess(mode: 'START' | 'RESUME' | 'RETRY_FAILED', params: {
    schoolsFilePath?: string;
    profileFilePath?: string;
    credentialsFilePath?: string;
    expectedSchoolCount?: number;
    schoolTimeoutMs?: number;
  }): void {
    if (this.currentJobState === 'RUNNING' || this.currentJobState === 'STOPPING') {
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

    this.spawnChildInternal(args, doCleanup, 'PREFLIGHT_DRY_RUN');
  }

  /**
   * 指示2.7, 5: Production Apply プロセス起動 (Process Boundary, 完全分離, 固定引数)
   */
  startProductionApplyProcess(confirmationToken: string): void {
    if (this.currentJobState === 'RUNNING' || this.currentJobState === 'STOPPING') {
      throw new ConsoleError('JOB_CONFLICT', 'すでに別のバッチ処理が実行中または停止処理中です');
    }

    // 1. 最新 Preflight レポートの取得
    const latest = this.loadLatestPreflightReport();
    if (!latest.preflight) {
      throw new AutomationError('CONFIG_INVALID', '有効な Preflight レポートが見つかりません');
    }

    // 2. Global Gate 再検証 & Manifest 導出
    const manifest = validateGlobalGateAndBuildManifest({
      preflightReport: latest.preflight,
      activeProfileSnapshot: this.activeProfileSnapshot,
      currentValidationSnapshot: this.currentSnapshot,
      summaryReport: latest.summary
    });

    // 3. Confirmation Token の厳格検証と一回限り消費 (再利用・二重実行防止)
    this.tokenManager.verifyAndConsumeToken(confirmationToken, manifest);

    // 4. 一時ファイルの安全な materialize
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

    // 5. 厳格な引数列構築 (サーバー側固定: Write関連フラグを明示付与, クライアントからの任意注入排除)
    const args: string[] = [
      '-T',
      'src/index.ts',
      '--batch',
      '--apply',
      '--allow-live-write',
      '--batch-apply',
      '--schools', schoolsPath,
      '--profile', effectiveProfilePath
    ];

    if (this.activeProfileSnapshot?.snapshotId) {
      args.push('--profile-snapshot-id', this.activeProfileSnapshot.snapshotId);
    }

    if (credentialsPath && fs.existsSync(path.resolve(process.cwd(), credentialsPath))) {
      args.push('--credentials', credentialsPath);
    }

    const pfPath = path.resolve(process.cwd(), 'reports', `preflight-${manifest.preflightId}.json`);
    if (fs.existsSync(pfPath)) {
      args.push('--preflight-report', pfPath);
    }

    this.spawnChildInternal(args, doCleanup, 'PRODUCTION_WRITE');
  }

  /**
   * 共通子プロセス起動ロジック (shell: false, executable + args[] 分離)
   */
  private spawnChildInternal(args: string[], doCleanup: () => void, executionMode: 'PREFLIGHT_DRY_RUN' | 'PRODUCTION_WRITE'): void {
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
        const total = this.currentSnapshot?.enabledSchoolCount || 1;
        const elapsedSeconds = this.runStartedAt ? Math.floor((Date.now() - this.runStartedAt) / 1000) : 0;
        this.emit('progress', {
          processed: total,
          total,
          percentage: 100,
          success: total,
          failed: 0,
          remaining: 0,
          elapsedSeconds,
          estimatedRemainingSeconds: 0
        });
      } else {
        this.currentJobState = 'FAILED';
      }
      this.childProcess = null;
      this.emit('stateChange', { state: this.currentJobState, exitCode: code, signal, mode: executionMode });
    });

    // 定期的に Checkpoint / Progress をポーリング (Structured Data SSOT: 指示9)
    this.startProgressPoller();
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

    // 最新のチェックポイントファイルを探索
    try {
      const checkpointsDir = path.resolve(process.cwd(), 'checkpoints');
      if (fs.existsSync(checkpointsDir)) {
        const files = fs.readdirSync(checkpointsDir).filter((f) => f.startsWith('checkpoint-') && f.endsWith('.json'));
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

    // パターン1: [1/3] PAKCW - SUCCESS (経過: 4.2s, 成功: 1, 失敗: 0, 残り: 2)
    const matchEnd = text.match(/\[(\d+)\/(\d+)\]\s+([A-Za-z0-9_-]+)\s+-\s+(\w+)\s+\(経過:\s*[^,]+,\s*成功:\s*(\d+),\s*失敗:\s*(\d+),\s*残り:\s*(\d+)\)/);
    if (matchEnd) {
      const processed = parseInt(matchEnd[1], 10);
      const total = parseInt(matchEnd[2], 10);
      const success = parseInt(matchEnd[5], 10);
      const failed = parseInt(matchEnd[6], 10);
      const remaining = parseInt(matchEnd[7], 10);
      this.emit('progress', {
        processed,
        total,
        percentage: total > 0 ? Math.round((processed / total) * 100) : 0,
        success,
        failed,
        remaining,
        elapsedSeconds,
        estimatedRemainingSeconds: processed > 0 && remaining > 0 ? Math.round((elapsedSeconds / processed) * remaining) : 0
      });
      return;
    }

    // パターン2: [1/3] 学校処理開始: まなホーダイデモ学校 (PAKCW)
    const matchStart = text.match(/\[(\d+)\/(\d+)\]\s+学校処理開始:\s*(.+?)\s*\((.+?)\)/);
    if (matchStart) {
      const currentIdx = parseInt(matchStart[1], 10);
      const total = parseInt(matchStart[2], 10);
      const schoolName = matchStart[3].trim();
      const schoolCode = matchStart[4].trim();
      const processed = Math.max(0, currentIdx - 1);
      this.emit('progress', {
        processed,
        total,
        percentage: total > 0 ? Math.round((processed / total) * 100) : 0,
        success: processed,
        failed: 0,
        remaining: Math.max(0, total - processed),
        elapsedSeconds,
        estimatedRemainingSeconds: null,
        currentSchool: { schoolCode, schoolName }
      });
      return;
    }

    // パターン3: 補助的な進捗通知 (進捗: 1 / 3)
    const matchFallback = text.match(/進捗:\s*(\d+)\s*\/\s*(\d+)/);
    if (matchFallback) {
      const processed = parseInt(matchFallback[1], 10);
      const total = parseInt(matchFallback[2], 10);
      this.emit('progress', {
        processed,
        total,
        percentage: Math.round((processed / total) * 100),
        success: processed,
        failed: 0,
        remaining: Math.max(0, total - processed),
        elapsedSeconds,
        estimatedRemainingSeconds: null
      });
    }
  }
}
