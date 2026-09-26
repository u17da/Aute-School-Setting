import * as fs from 'fs';
import * as path from 'path';
import { BatchCheckpoint, SchoolCheckpointEntry, CheckpointStatus, BatchSchoolItem, BatchLockInfo } from '../types/batch';
import { ExecutionStatus, AutomationError } from '../types/errors';
import { logger } from '../logger/logger';

export interface CheckpointManagerOptions {
  deploymentId: string;
  runId: string;
  profileHash: string;
  schoolsHash: string;
  toolVersion: string;
  toolFingerprint?: string;
  authMode: 'A' | 'B';
  schools: BatchSchoolItem[];
  isResume: boolean;
  clearStaleLock?: boolean;
  fsOverride?: {
    renameSync?: (oldPath: string, newPath: string) => void;
    closeSync?: (fd: number) => void;
  };
}

export class CheckpointManager {
  private checkpointDir: string;
  private checkpointPath: string;
  private lockPath: string;
  private checkpoint: BatchCheckpoint;
  private deploymentId: string;
  private runId: string;
  private fsRenameSync: typeof fs.renameSync;
  private fsCloseSync: typeof fs.closeSync;

  constructor(options: CheckpointManagerOptions) {
    const {
      deploymentId,
      runId,
      profileHash,
      schoolsHash,
      toolVersion,
      toolFingerprint,
      authMode,
      schools,
      isResume,
      clearStaleLock = false
    } = options;

    this.deploymentId = deploymentId;
    this.runId = runId;
    this.fsRenameSync = (options.fsOverride?.renameSync as any) ?? fs.renameSync;
    this.fsCloseSync = (options.fsOverride?.closeSync as any) ?? fs.closeSync;
    this.checkpointDir = path.resolve(process.cwd(), 'checkpoints');
    if (!fs.existsSync(this.checkpointDir)) {
      fs.mkdirSync(this.checkpointDir, { recursive: true });
    }
    this.checkpointPath = path.join(this.checkpointDir, `checkpoint-${deploymentId}.json`);
    this.lockPath = path.join(this.checkpointDir, `${deploymentId}.lock`);

    // 指示8, 11: 安全なLock取得
    this.acquireLock(clearStaleLock);

    // 古い .tmp.* ファイルが存在すればクリーンアップ (指示7)
    try {
      const files = fs.readdirSync(this.checkpointDir);
      for (const f of files) {
        if (f.startsWith(`checkpoint-${deploymentId}.json.tmp`)) {
          try {
            fs.unlinkSync(path.join(this.checkpointDir, f));
            logger.info(`未完了のテンポラリチェックポイントファイルをクリーンアップしました: ${f}`);
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }

    if (fs.existsSync(this.checkpointPath)) {
      // 既存チェックポイントのロード
      const raw = fs.readFileSync(this.checkpointPath, 'utf-8');
      const loaded: BatchCheckpoint = JSON.parse(raw);

      if (isResume) {
        // 指示5, 10: Resume 時の実行条件 Hash & toolFingerprint 整合性検証
        this.verifyCheckpointIntegrity(loaded, {
          profileHash,
          schoolsHash,
          toolVersion,
          toolFingerprint,
          authMode
        });

        logger.info(`【Checkpoint整合性OK】既存チェックポイントを正常に検証・ロードしました: ${this.checkpointPath}`);
      }

      loaded.runId = runId;
      this.checkpoint = loaded;
      this.sanitizeInterrupted();
      this.save();
    } else {
      // 新規チェックポイントの作成
      const entries: Record<string, SchoolCheckpointEntry> = {};
      for (const s of schools) {
        entries[s.schoolCode] = {
          schoolCode: s.schoolCode,
          schoolName: s.schoolName,
          credentialRef: s.credentialRef,
          status: s.enabled ? 'PENDING' : 'SUCCESS_ALREADY_CONFIGURED'
        };
      }

      this.checkpoint = {
        deploymentId,
        runId,
        profileHash,
        schoolsHash,
        toolVersion,
        toolFingerprint,
        authMode,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isCompleted: false,
        entries
      };
      this.save();
    }
  }

  /**
   * 指示11: プロセスの生存確認
   */
  private isPidAlive(pid: number): boolean {
    try {
      // シグナル0を送信して生存確認（シグナル自体は送信されず、エラーチェックのみ行われる）
      process.kill(pid, 0);
      return true;
    } catch (err: any) {
      // EPERM は権限がないだけでプロセス自体は存在している
      return err.code === 'EPERM';
    }
  }

  /**
   * 指示8, 11: Lockの取得と安全なstale解除
   */
  private acquireLock(clearStaleLock: boolean): void {
    if (fs.existsSync(this.lockPath)) {
      let existingLock: BatchLockInfo | null = null;
      try {
        existingLock = JSON.parse(fs.readFileSync(this.lockPath, 'utf-8'));
      } catch {
        // ignore
      }

      const pid = existingLock?.pid;
      const isAlive = pid ? this.isPidAlive(pid) : false;

      if (isAlive) {
        // プロセスが実際に生存している場合は、--clear-stale-lock があっても強制解除を拒否
        throw new AutomationError(
          'BATCH_LOCKED',
          `deploymentId "${this.deploymentId}" は現在PID ${pid} のプロセスで実行中です。稼働中のプロセスが存在するためロックを解除できません (--clear-stale-lock 拒否)。二重起動を防止しました。`,
          { existingLock, lockPath: this.lockPath }
        );
      }

      // プロセスが死んでいる場合 (明確にstale)
      if (clearStaleLock) {
        logger.warn(`【Stale Lock解除】PID ${pid} が存在しないことを確認したため、残存ロックを削除します: ${this.lockPath}`);
        fs.unlinkSync(this.lockPath);
      } else {
        throw new AutomationError(
          'BATCH_LOCKED',
          `deploymentId "${this.deploymentId}" に前回の異常終了によるロックが残っています (Lock情報: pid=${pid}, runId=${existingLock?.runId}, startedAt=${existingLock?.startedAt})。プロセス生存確認結果: 停止済み。安全を確認の上、再実行時は --clear-stale-lock を指定してください。`,
          { existingLock, lockPath: this.lockPath }
        );
      }
    }

    const lockInfo: BatchLockInfo = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      runId: this.runId,
      deploymentId: this.deploymentId
    };
    fs.writeFileSync(this.lockPath, JSON.stringify(lockInfo, null, 2), 'utf-8');
    logger.info(`【Lock取得】Batch実行ロックを取得しました (pid=${process.pid}, runId=${this.runId})`);
  }

  /**
   * Lockの解放
   */
  public releaseLock(): void {
    if (fs.existsSync(this.lockPath)) {
      try {
        fs.unlinkSync(this.lockPath);
        logger.info(`【Lock解放】Batch実行ロックを解放しました: ${this.lockPath}`);
      } catch (err: any) {
        logger.warn(`Lock解放エラー: ${err.message}`);
      }
    }
  }

  /**
   * 指示5, 10: Resume時の整合性チェック
   */
  private verifyCheckpointIntegrity(
    checkpoint: BatchCheckpoint,
    current: {
      profileHash: string;
      schoolsHash: string;
      toolVersion: string;
      toolFingerprint?: string;
      authMode: 'A' | 'B';
    }
  ): void {
    if (checkpoint.profileHash !== current.profileHash) {
      throw new AutomationError(
        'CHECKPOINT_MISMATCH',
        `Resume整合性エラー: 目的設定プロファイルのHashがCheckpointと不一致です (Checkpoint: ${checkpoint.profileHash.substring(0, 8)}, 現在: ${current.profileHash.substring(0, 8)})。異なる設定でのResumeは安全のため禁止されています`,
        { checkpointProfile: checkpoint.profileHash, currentProfile: current.profileHash }
      );
    }

    if (checkpoint.schoolsHash !== current.schoolsHash) {
      throw new AutomationError(
        'CHECKPOINT_MISMATCH',
        `Resume整合性エラー: 対象学校一覧・順序のHashがCheckpointと不一致です (Checkpoint: ${checkpoint.schoolsHash.substring(0, 8)}, 現在: ${current.schoolsHash.substring(0, 8)})。学校一覧・順序が変更された状態でのResumeは禁止されています`,
        { checkpointSchools: checkpoint.schoolsHash, currentSchools: current.schoolsHash }
      );
    }

    if (checkpoint.authMode !== current.authMode) {
      throw new AutomationError(
        'CHECKPOINT_MISMATCH',
        `Resume整合性エラー: 認証方式 (authMode) がCheckpointと不一致です (Checkpoint: ${checkpoint.authMode}, 現在: ${current.authMode})`,
        { checkpointAuthMode: checkpoint.authMode, currentAuthMode: current.authMode }
      );
    }

    if (checkpoint.toolVersion !== current.toolVersion) {
      throw new AutomationError(
        'CHECKPOINT_MISMATCH',
        `Resume整合性エラー: ツールバージョンがCheckpointと不一致です (Checkpoint: ${checkpoint.toolVersion}, 現在: ${current.toolVersion})`,
        { checkpointVersion: checkpoint.toolVersion, currentVersion: current.toolVersion }
      );
    }

    if (checkpoint.toolFingerprint !== current.toolFingerprint) {
      throw new AutomationError(
        'CHECKPOINT_MISMATCH',
        `Resume整合性エラー: 実行コードのFingerprintがCheckpointと不一致です (Checkpoint: ${checkpoint.toolFingerprint?.substring(0, 8)}, 現在: ${current.toolFingerprint?.substring(0, 8)})。コードが変更された状態でのResumeは安全のため禁止されています`,
        { checkpointFingerprint: checkpoint.toolFingerprint, currentFingerprint: current.toolFingerprint }
      );
    }
  }

  /**
   * 指示18: RUNNINGのまま異常終了した学校を起動時に INTERRUPTED へ変換する
   */
  private sanitizeInterrupted(): void {
    let interruptedCount = 0;
    for (const [code, entry] of Object.entries(this.checkpoint.entries)) {
      if (entry.status === 'RUNNING') {
        entry.status = 'INTERRUPTED';
        entry.error = '前回プロセスがRUNNINGのまま異常終了したためINTERRUPTEDへ遷移しました';
        interruptedCount++;
      }
    }
    if (interruptedCount > 0) {
      logger.warn(`【Checkpoint復元】前回異常終了でRUNNINGだった ${interruptedCount} 校を INTERRUPTED としてマークしました`);
      this.save();
    }
  }

  getEntries(): SchoolCheckpointEntry[] {
    return Object.values(this.checkpoint.entries);
  }

  getEntry(schoolCode: string): SchoolCheckpointEntry | undefined {
    return this.checkpoint.entries[schoolCode];
  }

  startSchool(schoolCode: string): void {
    const entry = this.checkpoint.entries[schoolCode];
    if (entry) {
      entry.status = 'RUNNING';
      entry.startedAt = new Date().toISOString();
      this.save();
    }
  }

  finishSchool(params: {
    schoolCode: string;
    status: CheckpointStatus;
    executionStatus: ExecutionStatus;
    actionsCount?: number;
    hasDestructiveChanges?: boolean;
    error?: string;
    resultLogPath?: string;
  }): void {
    const entry = this.checkpoint.entries[params.schoolCode];
    if (entry) {
      entry.status = params.status;
      entry.finishedAt = new Date().toISOString();
      entry.executionStatus = params.executionStatus;
      entry.actionsCount = params.actionsCount;
      entry.hasDestructiveChanges = params.hasDestructiveChanges;
      entry.error = params.error;
      entry.resultLogPath = params.resultLogPath;
      this.save();
    }
  }

  markBatchCompleted(): void {
    this.checkpoint.isCompleted = true;
    this.save();
  }

  isBatchCompleted(): boolean {
    return this.checkpoint.isCompleted;
  }

  private isWriting = false;

  /**
   * 指示7 & Phase 5A.1: Hardened Atomic Checkpoint Write
   * 一意tmp名 -> open -> write -> fsync -> close -> bounded retry rename -> cleanup
   */
  save(): void {
    if (this.isWriting) {
      // Single-writer 再入防止
      let waitCount = 0;
      while (this.isWriting && waitCount < 100) {
        const start = Date.now();
        while (Date.now() - start < 10) {}
        waitCount++;
      }
    }

    this.isWriting = true;
    this.checkpoint.updatedAt = new Date().toISOString();
    const jsonStr = JSON.stringify(this.checkpoint, null, 2);

    // 1. 一意なテンポラリファイル名 (PID + Timestamp + Random)
    const tmpPath = `${this.checkpointPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).substring(2, 8)}`;

    let fd: number | null = null;
    try {
      // 2. 明示的なハンドル管理: open -> write -> fsync (ディスクフラッシュ) -> close
      fd = fs.openSync(tmpPath, 'w');
      fs.writeFileSync(fd, jsonStr, 'utf-8');
      fs.fsyncSync(fd);
      this.fsCloseSync(fd);
      fd = null;

      // 3. Bounded Transient Retry による atomic replace/rename (Windows 一時ロック競合対策)
      const maxRetries = 5;
      let lastErr: any = null;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          this.fsRenameSync(tmpPath, this.checkpointPath);
          return; // 成功
        } catch (renameErr: any) {
          lastErr = renameErr;
          const isTransient = renameErr.code === 'EPERM' || renameErr.code === 'EBUSY' || renameErr.code === 'EACCES';
          if (!isTransient || attempt === maxRetries) {
            break;
          }
          // 指数バックオフ + ジッター (25ms, 50ms, 100ms, 200ms, 400ms)
          const baseDelay = 25 * Math.pow(2, attempt - 1);
          const jitter = Math.floor(Math.random() * 15);
          const delay = baseDelay + jitter;
          const start = Date.now();
          while (Date.now() - start < delay) {}
        }
      }

      // 全リトライ超過時
      throw new AutomationError(
        'CHECKPOINT_IO_ERROR',
        `チェックポイントのアトミック更新に失敗しました (rename retry ${maxRetries}回超過): ${lastErr?.message || 'Unknown error'}`,
        { tmpPath, checkpointPath: this.checkpointPath, code: lastErr?.code }
      );
    } catch (err: any) {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
      if (err instanceof AutomationError) {
        throw err;
      }
      throw new AutomationError(
        'CHECKPOINT_IO_ERROR',
        `チェックポイント保存中にI/Oエラーが発生しました: ${err.message}`,
        { checkpointPath: this.checkpointPath, originalError: err.message }
      );
    } finally {
      this.isWriting = false;
    }
  }

  getCheckpointPath(): string {
    return this.checkpointPath;
  }

  getDeploymentId(): string {
    return this.deploymentId;
  }
}
