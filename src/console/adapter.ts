import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import { ValidationSnapshot, ConsoleJobState, ConsoleError } from './types';
import { loadSchoolsList, validateCredentialsExist } from '../batch/runBatch';
import { RequestedSettingsSchema } from '../config/schema';
import { generateSettingsHash, generateSchoolsHash, getToolVersion, generateToolFingerprint } from '../utils/hash';
import { FileCredentialProvider, EnvCredentialProvider } from '../batch/credentialProvider';
import { loadEnvConfig } from '../config/loader';
import { AutomationError } from '../types/errors';
import { sanitizeString } from './sanitizer';

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

export class BatchProcessAdapter extends EventEmitter {
  private childProcess: ChildProcess | null = null;
  private currentJobState: ConsoleJobState = 'IDLE';
  private currentSnapshot: ValidationSnapshot | null = null;
  private runStartedAt: number | null = null;
  private currentRunId: string | null = null;
  private progressInterval: NodeJS.Timeout | null = null;
  private stdoutBuffer: string[] = [];
  private spawnFn: typeof spawn;
  private lastSpawnInfo: { command: string; args: string[]; env: any } | null = null;
  private lastValidationParams: any = {};
  private stopFallbackTimeoutMs: number;
  private stopFallbackTimer: NodeJS.Timeout | null = null;

  constructor(options?: { spawnFn?: typeof spawn; stopFallbackTimeoutMs?: number }) {
    super();
    this.spawnFn = options?.spawnFn ?? spawn;
    this.stopFallbackTimeoutMs = options?.stopFallbackTimeoutMs ?? 15000;
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

  /**
   * Static Validation の実行と ValidationSnapshot の生成 (指示2, 6)
   * ※ 既存の Hash / Schema / CredentialProvider を SSOT として再利用
   */
  executeValidation(params: {
    schoolsFilePath?: string;
    profileFilePath?: string;
    credentialsFilePath?: string;
    expectedSchoolCount?: number;
  }): { snapshot: ValidationSnapshot; profileDetails: any; schoolsCount: number; enabledCount: number } {
    const resolveExisting = (candidates: string[]): string => {
      for (const c of candidates) {
        if (fs.existsSync(path.resolve(process.cwd(), c))) return c;
      }
      return candidates[0];
    };
    const schoolsPath = params.schoolsFilePath || resolveExisting(['config/schools.live.csv', 'config/schools-live.csv', 'config/schools.sample.csv']);
    const profilePath = params.profileFilePath || resolveExisting(['config/production-profile.live.json', 'config/production-profile.sample.json']);
    const credentialsPath = params.credentialsFilePath || resolveExisting(['config/credentials.json', 'config/credentials.sample.json']);

    // 1. Profile Validation & Hash
    const resolvedProfile = path.resolve(process.cwd(), profilePath);
    if (!fs.existsSync(resolvedProfile)) {
      throw new AutomationError('CONFIG_INVALID', `プロファイル設定ファイルが見つかりません: ${resolvedProfile}`);
    }
    const rawProfile = JSON.parse(fs.readFileSync(resolvedProfile, 'utf-8'));
    const parsedProfile = RequestedSettingsSchema.safeParse(rawProfile);
    if (!parsedProfile.success) {
      throw new AutomationError(
        'CONFIG_INVALID',
        `プロファイルスキーマ検証エラー: ${parsedProfile.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`
      );
    }
    const profileHash = generateSettingsHash(parsedProfile.data);

    // 2. Schools Validation & Hash
    const schools = loadSchoolsList(schoolsPath);
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

    // 4. Credential Resolution (秘密情報は非保持・非露出)
    const envConfig = loadEnvConfig();
    let credProvider;
    if (fs.existsSync(path.resolve(process.cwd(), credentialsPath))) {
      credProvider = new FileCredentialProvider(path.resolve(process.cwd(), credentialsPath));
    } else {
      credProvider = new EnvCredentialProvider(envConfig.userId, envConfig.password);
    }

    validateCredentialsExist(schools, credProvider);

    const toolVersion = getToolVersion();
    const toolFingerprint = generateToolFingerprint();

    const snapshot: ValidationSnapshot = {
      profileHash,
      schoolsHash,
      toolVersion,
      toolFingerprint,
      expectedSchoolCount: params.expectedSchoolCount,
      enabledSchoolCount: enabledSchools.length,
      totalSchoolCount: schools.length,
      resolvedCredentialsCount: enabledSchools.length,
      validatedAt: new Date().toISOString()
    };

    this.currentSnapshot = snapshot;
    this.currentJobState = 'READY';
    this.lastValidationParams = { ...params };

    return {
      snapshot,
      profileDetails: parsedProfile.data,
      schoolsCount: schools.length,
      enabledCount: enabledSchools.length
    };
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

    // 1. 二重安全Gate: Snapshot 再検証
    this.verifyValidationSnapshot(effectiveParams);

    const resolveExisting = (candidates: string[]): string => {
      for (const c of candidates) {
        if (fs.existsSync(path.resolve(process.cwd(), c))) return c;
      }
      return candidates[0];
    };
    const schoolsPath = effectiveParams.schoolsFilePath || resolveExisting(['config/schools.live.csv', 'config/schools-live.csv', 'config/schools.sample.csv']);
    const profilePath = effectiveParams.profileFilePath || resolveExisting(['config/production-profile.live.json', 'config/production-profile.sample.json']);
    const credentialsPath = effectiveParams.credentialsFilePath || resolveExisting(['config/credentials.json', 'config/credentials.sample.json']);

    // 2. 引数列の厳格構築 (Write関連フラグは一切含めない = 既存仕様通りRead-only Preflight)
    const args: string[] = [
      '-T',
      'src/index.ts',
      '--batch',
      '--schools', schoolsPath,
      '--profile', profilePath
    ];

    if (fs.existsSync(path.resolve(process.cwd(), credentialsPath))) {
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

    // 3. Process Boundary: Node.js executable (process.execPath) + ts-node entrypoint を直接起動 (shell: false)
    let tsNodeBin: string;
    try {
      tsNodeBin = require.resolve('ts-node/dist/bin.js');
    } catch {
      const localFallback = path.resolve(process.cwd(), 'node_modules/ts-node/dist/bin.js');
      if (fs.existsSync(localFallback)) {
        tsNodeBin = localFallback;
      } else {
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

    this.emit('stateChange', { state: this.currentJobState, runId: this.currentRunId });

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
      this.currentJobState = 'FAILED';
      this.childProcess = null;
      this.emit('stateChange', { state: this.currentJobState, error: err.message });
      throw new ConsoleError('PROCESS_SPAWN_FAILED', `子プロセスの起動に失敗しました: ${err.message}`);
    }

    this.childProcess.on('error', (err: Error) => {
      this.cleanupProgressPoller();
      this.currentJobState = 'FAILED';
      this.childProcess = null;
      this.emit('stateChange', { state: this.currentJobState, error: err.message });
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
      this.cleanupProgressPoller();
      if (this.stopFallbackTimer) {
        clearTimeout(this.stopFallbackTimer);
        this.stopFallbackTimer = null;
      }
      if (this.currentJobState === 'STOPPING') {
        this.currentJobState = 'INTERRUPTED'; // 安全停止完了時は INTERRUPTED
      } else if (code === 0) {
        this.currentJobState = 'COMPLETED';
      } else {
        this.currentJobState = 'FAILED';
      }
      this.childProcess = null;
      this.emit('stateChange', { state: this.currentJobState, exitCode: code, signal });
    });

    // 4. 定期的に Checkpoint / Progress をポーリング (Structured Data SSOT: 指示9)
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

          if (cpData && cpData.metadata && cpData.schools) {
            const entries = Object.values(cpData.schools) as any[];
            const processed = entries.filter((e) => e.status !== 'PENDING' && e.status !== 'RUNNING').length;
            const success = entries.filter((e) => e.status === 'SUCCESS' || e.status === 'SUCCESS_ALREADY_CONFIGURED').length;
            const failed = entries.filter((e) => e.status === 'FAILED' || e.status === 'TIMEOUT').length;
            const total = cpData.metadata.totalSchools || this.currentSnapshot?.enabledSchoolCount || entries.length;
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
    // 補助的な進捗通知
    const match = text.match(/進捗:\s*(\d+)\s*\/\s*(\d+)/);
    if (match) {
      const processed = parseInt(match[1], 10);
      const total = parseInt(match[2], 10);
      const elapsedSeconds = this.runStartedAt ? Math.floor((Date.now() - this.runStartedAt) / 1000) : 0;
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
