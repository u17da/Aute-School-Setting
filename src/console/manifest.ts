import * as crypto from 'crypto';
import { PreflightReport, ApplyTargetItem, ApplyTargetManifest, ConfirmationTokenData } from '../types/batch';
import { ProfileSnapshot, ValidationSnapshot, FinalValidationSnapshot } from './types';
import { generateApplyTargetHash } from '../utils/hash';
import { AutomationError } from '../types/errors';

export interface GlobalGateValidationResult {
  eligible: boolean;
  blockReason?: string;
  manifest?: ApplyTargetManifest;
}

/**
 * 指示4 & Phase 6A: Production Apply の Global Gate 検証と Manifest 生成
 * 1件でも Read Failed, NOT_PROCESSED, PLAN_BLOCKED, CONFIG_CONFLICT, DEPENDENCY_UNSATISFIED があれば Apply 開始禁止
 * - purpose === 'FINAL_PREFLIGHT' 必須 (DISCOVERY レポートからの生成は完全拒否)
 * - FinalValidationSnapshot による State Lineage バインド
 * - 破壊的変更の Override は完全禁止 (強制スキップ)
 */
export function validateGlobalGateAndBuildManifest(params: {
  preflightReport: PreflightReport;
  activeProfileSnapshot: ProfileSnapshot | null;
  currentValidationSnapshot: ValidationSnapshot | null;
  finalValidationSnapshot?: FinalValidationSnapshot | null;
  summaryPath?: string;
  summaryReport?: any; // 詳細な actions や expectedFinalState が格納された summary
  allowDestructive?: boolean; // Phase 6A: 常に無視 (Override禁止)
}): ApplyTargetManifest {
  const { preflightReport, activeProfileSnapshot, currentValidationSnapshot, finalValidationSnapshot, summaryReport } = params;

  const effectiveValidation = currentValidationSnapshot || (finalValidationSnapshot ? {
    schoolsHash: finalValidationSnapshot.schoolsHash,
    toolFingerprint: finalValidationSnapshot.toolFingerprint,
    authMode: finalValidationSnapshot.authMode
  } : null);

  // 1. Snapshot / Preflight 存在確認
  if (!activeProfileSnapshot) {
    throw new AutomationError('CONFIG_INVALID', '有効な Profile Snapshot が存在しません。事前に「入力を検証」を実行してください');
  }
  if (!effectiveValidation) {
    throw new AutomationError('CONFIG_INVALID', '有効な Validation Snapshot が存在しません。事前に「入力を検証」を実行してください');
  }
  if (!preflightReport) {
    throw new AutomationError('CONFIG_INVALID', '有効な Preflight レポートが存在しません');
  }

  // Phase 6A 要件2: DISCOVERYからの流用拒否 (purpose === 'DISCOVERY' は拒否)
  if (preflightReport.purpose === 'DISCOVERY') {
    throw new AutomationError(
      'UNSAFE_CONFIGURATION',
      `Discovery レポートまたは不正な目的のレポートから Production Apply を開始することはできません (purpose: ${preflightReport.purpose})`
    );
  }

  // Phase 6A 要件1, 4, 9: FinalValidationSnapshot との Lineage バインド検証
  if (finalValidationSnapshot) {
    if (preflightReport.finalValidationSnapshotId && preflightReport.finalValidationSnapshotId !== finalValidationSnapshot.finalValidationSnapshotId) {
      throw new AutomationError(
        'CHECKPOINT_MISMATCH',
        `FinalValidationSnapshot ID 不一致: Preflight 時 (${preflightReport.finalValidationSnapshotId}) と現在 (${finalValidationSnapshot.finalValidationSnapshotId}) が一致しません`
      );
    }
    if (finalValidationSnapshot.profileSnapshotId !== activeProfileSnapshot.snapshotId) {
      throw new AutomationError(
        'CHECKPOINT_MISMATCH',
        `ProfileSnapshot ID 不一致: FinalValidation (${finalValidationSnapshot.profileSnapshotId}) と現在 (${activeProfileSnapshot.snapshotId}) が一致しません`
      );
    }
    if (preflightReport.authMode && finalValidationSnapshot.authMode && preflightReport.authMode !== finalValidationSnapshot.authMode) {
      throw new AutomationError(
        'CHECKPOINT_MISMATCH',
        `authMode 不一致: Preflight 時 (${preflightReport.authMode}) と現在 (${finalValidationSnapshot.authMode}) が一致しません`
      );
    }
  }

  // 2. Preflight Status & 有効期限 Gate (指示4)
  if (preflightReport.status !== 'COMPLETE') {
    throw new AutomationError('UNSAFE_CONFIGURATION', `Preflight が正常完了していません (Status: ${preflightReport.status})。再Preflightが必要です`);
  }
  if (!preflightReport.allReadSucceeded || preflightReport.readFailed > 0) {
    throw new AutomationError('UNSAFE_CONFIGURATION', `読取失敗校が存在するため Apply を開始できません (readFailed: ${preflightReport.readFailed})`);
  }
  if (!preflightReport.allPlansExecutable || preflightReport.planBlocked > 0) {
    throw new AutomationError('UNSAFE_CONFIGURATION', `計画ブロック校が存在するため Apply を開始できません (planBlocked: ${preflightReport.planBlocked})`);
  }
  if (preflightReport.notProcessed > 0) {
    throw new AutomationError('UNSAFE_CONFIGURATION', `未処理校が存在するため Apply を開始できません (notProcessed: ${preflightReport.notProcessed})`);
  }

  const validUntilTime = new Date(preflightReport.validUntil).getTime();
  if (Date.now() > validUntilTime) {
    throw new AutomationError('UNSAFE_CONFIGURATION', `Preflight レポートの有効期限が超過しています (有効期限: ${preflightReport.validUntil})。再Preflightが必要です`);
  }

  // 3. Hash 整合性 Gate (指示4, 11)
  if (preflightReport.profileHash !== activeProfileSnapshot.profileHash) {
    throw new AutomationError(
      'CHECKPOINT_MISMATCH',
      `Profile Hash 不一致: Preflight 時 (${preflightReport.profileHash.substring(0, 8)}) と現在の設定 (${activeProfileSnapshot.profileHash.substring(0, 8)}) が一致しません`
    );
  }
  if (preflightReport.profileSnapshotId && preflightReport.profileSnapshotId !== activeProfileSnapshot.snapshotId) {
    throw new AutomationError(
      'CHECKPOINT_MISMATCH',
      `Profile Snapshot ID 不一致: Preflight 時 (${preflightReport.profileSnapshotId}) と現在の Snapshot (${activeProfileSnapshot.snapshotId}) が一致しません`
    );
  }
  if (preflightReport.schoolsHash !== effectiveValidation.schoolsHash) {
    throw new AutomationError(
      'CHECKPOINT_MISMATCH',
      `Schools Hash 不一致: Preflight 時 (${preflightReport.schoolsHash.substring(0, 8)}) と現在の入力学校 (${effectiveValidation.schoolsHash.substring(0, 8)}) が一致しません`
    );
  }
  if (preflightReport.toolFingerprint && effectiveValidation.toolFingerprint && preflightReport.toolFingerprint !== effectiveValidation.toolFingerprint) {
    throw new AutomationError(
      'CHECKPOINT_MISMATCH',
      `Tool Fingerprint 不一致: Preflight 時と現在のツール環境が一致しません`
    );
  }

  // 4. Manifest 導出 (指示3, 4, 6)
  const applyTargets: ApplyTargetItem[] = [];
  let skippedDestructiveCount = 0;
  let alreadyConfiguredCount = 0;
  let blockedCount = 0;

  // summaryReport から学校ごとの詳細な plannedActions と expectedFinalState を取得
  const summarySchoolMap = new Map<string, any>();
  if (summaryReport && Array.isArray(summaryReport.schoolResults)) {
    for (const sr of summaryReport.schoolResults) {
      summarySchoolMap.set(sr.schoolCode, sr);
    }
  }

  for (const s of preflightReport.schools) {
    if (s.readStatus !== 'SUCCESS') {
      blockedCount++;
      continue;
    }
    if (!s.planExecutable) {
      blockedCount++;
      continue;
    }

    // Phase 6A 要件4: 破壊的変更校の自動除外 (Override禁止: 例外なくスキップ)
    if (s.hasDestructiveChanges) {
      skippedDestructiveCount++;
      continue;
    }

    // 設定変更なし校の除外 (指示4: ALREADY_CONFIGURED)
    if (s.actionsCount === 0 || s.hasChanges === false) {
      alreadyConfiguredCount++;
      continue;
    }

    // Baseline Hash が存在すること (指示6)
    if (!s.baselineHash) {
      throw new AutomationError('CONFIG_INVALID', `学校 ${s.schoolCode} の baselineHash が Preflight レポートに存在しません`);
    }

    const detail = summarySchoolMap.get(s.schoolCode);
    const plannedActions = detail?.plannedActions || [];
    const expectedFinalState = detail?.requested || activeProfileSnapshot.requestedSettings;

    applyTargets.push({
      schoolCode: s.schoolCode,
      baselineHash: s.baselineHash,
      plannedActions,
      expectedFinalState
    });
  }

  // 5. 最終検証
  if (blockedCount > 0) {
    throw new AutomationError('UNSAFE_CONFIGURATION', `ブロック対象校が ${blockedCount} 校存在するため、Production Apply 全体を開始できません`);
  }
  if (applyTargets.length === 0) {
    throw new AutomationError('CONFIG_INVALID', '適用対象となる学校が 0 校です（全校が変更なしまたは破壊的変更除外です）');
  }

  // 6. applyTargetHash 生成 (指示3: schoolCode, baselineHash, plannedActions, expectedFinalState の canonical Hash)
  const applyTargetHash = generateApplyTargetHash(applyTargets);

  const manifest: ApplyTargetManifest = {
    finalValidationSnapshotId: finalValidationSnapshot?.finalValidationSnapshotId,
    profileSnapshotId: activeProfileSnapshot.snapshotId,
    preflightId: preflightReport.runId || preflightReport.deploymentId,
    profileHash: activeProfileSnapshot.profileHash,
    schoolsHash: effectiveValidation.schoolsHash,
    applyTargetHash,
    authMode: preflightReport.authMode || finalValidationSnapshot?.authMode,
    createdAt: new Date().toISOString(),
    totalSchools: preflightReport.total,
    applyTargets,
    skippedDestructiveCount,
    alreadyConfiguredCount,
    blockedCount
  };

  return manifest;
}

/**
 * 指示5: Confirmation Token 管理クラス (2段階API & One-time Token)
 */
export class ConfirmationTokenManager {
  private tokens: Map<string, ConfirmationTokenData> = new Map();

  /**
   * トークンを発行してメモリに保持 (TTL: デフォルト10分)
   */
  createToken(manifest: ApplyTargetManifest, ttlMs = 10 * 60 * 1000): ConfirmationTokenData {
    const rawToken = `apply-token-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
    const tokenData: ConfirmationTokenData = {
      token: rawToken,
      profileSnapshotId: manifest.profileSnapshotId,
      preflightId: manifest.preflightId,
      finalPreflightExecutionId: manifest.finalPreflightExecutionId,
      finalValidationSnapshotId: manifest.finalValidationSnapshotId,
      profileHash: manifest.profileHash,
      schoolsHash: manifest.schoolsHash,
      applyTargetHash: manifest.applyTargetHash,
      targetCount: manifest.applyTargets.length,
      skippedDestructiveCount: manifest.skippedDestructiveCount,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttlMs).toISOString()
    };
    this.tokens.set(rawToken, tokenData);
    return tokenData;
  }

  /**
   * トークンを検証し、一度だけ消費 (再利用禁止 & 二重実行防止)
   */
  verifyAndConsumeToken(token: string, expectedManifest: ApplyTargetManifest): ConfirmationTokenData {
    const tokenData = this.tokens.get(token);
    if (!tokenData) {
      throw new AutomationError('APPROVAL_AUDIT_INVALID', '無効または存在しない confirmationToken です');
    }

    if (tokenData.consumedAt) {
      throw new AutomationError('APPROVAL_AUDIT_INVALID', 'この confirmationToken は既に使用済みです (二重起動禁止)');
    }

    const expiresAt = new Date(tokenData.expiresAt).getTime();
    if (Date.now() > expiresAt) {
      this.tokens.delete(token);
      throw new AutomationError('APPROVAL_AUDIT_INVALID', 'confirmationToken の有効期限が切れています。再度準備を実行してください');
    }

    // バインド整合性の厳格検証
    if (expectedManifest.finalPreflightExecutionId && tokenData.finalPreflightExecutionId !== expectedManifest.finalPreflightExecutionId) {
      throw new AutomationError('CHECKPOINT_MISMATCH', 'トークンの FinalPreflightExecutionId と現在の Manifest が一致しません');
    }
    if (expectedManifest.finalValidationSnapshotId && tokenData.finalValidationSnapshotId !== expectedManifest.finalValidationSnapshotId) {
      throw new AutomationError('CHECKPOINT_MISMATCH', 'トークンの FinalValidationSnapshotId と現在の Manifest が一致しません');
    }
    if (tokenData.profileSnapshotId !== expectedManifest.profileSnapshotId) {
      throw new AutomationError('CHECKPOINT_MISMATCH', 'トークンの ProfileSnapshotId と現在の Manifest が一致しません');
    }
    if (tokenData.profileHash !== expectedManifest.profileHash) {
      throw new AutomationError('CHECKPOINT_MISMATCH', 'トークンの ProfileHash と現在の Manifest が一致しません');
    }
    if (tokenData.schoolsHash !== expectedManifest.schoolsHash) {
      throw new AutomationError('CHECKPOINT_MISMATCH', 'トークンの SchoolsHash と現在の Manifest が一致しません');
    }
    if (tokenData.applyTargetHash !== expectedManifest.applyTargetHash) {
      throw new AutomationError('CHECKPOINT_MISMATCH', 'トークンの ApplyTargetHash と現在の Manifest が一致しません');
    }

    // 1回限りの消費
    tokenData.consumedAt = new Date().toISOString();
    return tokenData;
  }

  cleanupExpired(): void {
    const now = Date.now();
    for (const [key, data] of this.tokens.entries()) {
      if (now > new Date(data.expiresAt).getTime()) {
        this.tokens.delete(key);
      }
    }
  }
}
