import { AutomationError } from '../types/errors';

export type ApprovalState =
  | 'PLAN_CREATED'
  | 'AWAITING_USER_APPROVAL'
  | 'USER_APPROVAL_RECEIVED'
  | 'IMPLEMENTATION_ALLOWED';

export interface ApprovalAuditEvent {
  sequence: number;
  state: ApprovalState;
  occurredAt: string;
  source?: 'SYSTEM' | 'USER_MESSAGE';
  approvalMessageId?: string;
  detail?: string;
}

export interface TimelineValidationResult {
  valid: boolean;
  isValid: boolean;
  reason?: string;
  errorCode?: 'APPROVAL_AUDIT_INVALID';
}

/**
 * 期待される状態遷移シーケンス（厳格なState Machine）
 * 1: PLAN_CREATED
 * 2: AWAITING_USER_APPROVAL
 * 3: USER_APPROVAL_RECEIVED (source: 'USER_MESSAGE', approvalMessageId必須/推奨)
 * 4: IMPLEMENTATION_ALLOWED
 */
const EXPECTED_STATE_TRANSITIONS: Record<ApprovalState, { expectedSeq: number; allowedPreviousState: ApprovalState | null }> = {
  PLAN_CREATED: { expectedSeq: 1, allowedPreviousState: null },
  AWAITING_USER_APPROVAL: { expectedSeq: 2, allowedPreviousState: 'PLAN_CREATED' },
  USER_APPROVAL_RECEIVED: { expectedSeq: 3, allowedPreviousState: 'AWAITING_USER_APPROVAL' },
  IMPLEMENTATION_ALLOWED: { expectedSeq: 4, allowedPreviousState: 'USER_APPROVAL_RECEIVED' }
};

export class ApprovalAuditManager {
  private events: ApprovalAuditEvent[] = [];

  constructor(initialEvents: ApprovalAuditEvent[] = []) {
    if (initialEvents && Array.isArray(initialEvents)) {
      this.events = [...initialEvents];
    }
  }

  getCurrentState(): ApprovalState | 'NONE' {
    if (this.events.length === 0) return 'NONE';
    return this.events[this.events.length - 1].state;
  }

  getEvents(): ApprovalAuditEvent[] {
    return [...this.events];
  }

  /**
   * 1. PLAN_CREATED (sequence: 1, source: 'SYSTEM')
   */
  recordPlanCreated(input?: { occurredAt?: string; detail?: string }): void {
    const nextSeq = this.events.length + 1;
    if (nextSeq !== 1) {
      throw new AutomationError('APPROVAL_AUDIT_INVALID', 'PLAN_CREATEDはsequence: 1で開始する必要があります');
    }
    this.events.push({
      sequence: 1,
      state: 'PLAN_CREATED',
      occurredAt: input?.occurredAt || new Date().toISOString(),
      source: 'SYSTEM',
      detail: input?.detail
    });
  }

  /**
   * 2. AWAITING_USER_APPROVAL (sequence: 2, source: 'SYSTEM')
   */
  recordAwaitingApproval(input?: { occurredAt?: string; detail?: string }): void {
    const last = this.events[this.events.length - 1];
    if (!last || last.state !== 'PLAN_CREATED') {
      throw new AutomationError(
        'APPROVAL_AUDIT_INVALID',
        'AWAITING_USER_APPROVALへの遷移には直前のPLAN_CREATEDが必要です'
      );
    }
    const nextSeq = last.sequence + 1;
    if (nextSeq !== 2) {
      throw new AutomationError('APPROVAL_AUDIT_INVALID', 'AWAITING_USER_APPROVALはsequence: 2である必要があります');
    }
    this.events.push({
      sequence: 2,
      state: 'AWAITING_USER_APPROVAL',
      occurredAt: input?.occurredAt || new Date().toISOString(),
      source: 'SYSTEM',
      detail: input?.detail
    });
  }

  /**
   * 3. USER_APPROVAL_RECEIVED (sequence: 3, source: 'USER_MESSAGE')
   * 実際のユーザー明示承認メッセージ受信イベントに紐づけて記録する
   */
  recordUserApproval(input: {
    approvalMessageId?: string;
    occurredAt?: string;
    detail?: string;
  }): void {
    const last = this.events[this.events.length - 1];
    if (!last || last.state !== 'AWAITING_USER_APPROVAL') {
      throw new AutomationError(
        'APPROVAL_AUDIT_INVALID',
        'USER_APPROVAL_RECEIVEDを記録するには、直前にAWAITING_USER_APPROVALが存在する必要があります'
      );
    }
    const nextSeq = last.sequence + 1;
    if (nextSeq !== 3) {
      throw new AutomationError('APPROVAL_AUDIT_INVALID', 'USER_APPROVAL_RECEIVEDはsequence: 3である必要があります');
    }
    this.events.push({
      sequence: 3,
      state: 'USER_APPROVAL_RECEIVED',
      occurredAt: input.occurredAt || new Date().toISOString(),
      source: 'USER_MESSAGE',
      approvalMessageId: input.approvalMessageId,
      detail: input.detail
    });
  }

  /**
   * 4. IMPLEMENTATION_ALLOWED (sequence: 4, source: 'SYSTEM')
   * 直前が USER_APPROVAL_RECEIVED である場合のみ遷移可能
   */
  recordImplementationAllowed(input?: { occurredAt?: string; detail?: string }): void {
    const last = this.events[this.events.length - 1];
    if (!last || last.state !== 'USER_APPROVAL_RECEIVED') {
      throw new AutomationError(
        'APPROVAL_AUDIT_INVALID',
        'IMPLEMENTATION_ALLOWEDへの遷移には、直前のUSER_APPROVAL_RECEIVEDの存在が必須です（未承認着手禁止）'
      );
    }
    const nextSeq = last.sequence + 1;
    if (nextSeq !== 4) {
      throw new AutomationError('APPROVAL_AUDIT_INVALID', 'IMPLEMENTATION_ALLOWEDはsequence: 4である必要があります');
    }
    this.events.push({
      sequence: 4,
      state: 'IMPLEMENTATION_ALLOWED',
      occurredAt: input?.occurredAt || new Date().toISOString(),
      source: 'SYSTEM',
      detail: input?.detail
    });
  }

  /**
   * sequenceを中心とするState Machineの厳格検証
   * - 途中状態を飛ばさない
   * - 逆戻りしない
   * - 同じsequenceを重複させない
   * - IMPLEMENTATION_ALLOWEDへ遷移できるのは直前のstate === USER_APPROVAL_RECEIVED の場合のみ
   */
  validateSequence(events: ApprovalAuditEvent[] = this.events): TimelineValidationResult {
    if (!events || events.length === 0) {
      return { valid: false, isValid: false, errorCode: 'APPROVAL_AUDIT_INVALID', reason: '承認イベントが一切存在しません' };
    }

    // 1. sequenceの一意性・重複チェック
    const seenSequences = new Set<number>();
    for (const ev of events) {
      if (seenSequences.has(ev.sequence)) {
        return {
          valid: false,
          isValid: false,
          errorCode: 'APPROVAL_AUDIT_INVALID',
          reason: `重複したsequence (${ev.sequence}) が存在します`
        };
      }
      seenSequences.add(ev.sequence);
    }

    // 2. sequenceの連番チェック（1, 2, 3...）
    for (let i = 0; i < events.length; i++) {
      const expectedSeq = i + 1;
      if (events[i].sequence !== expectedSeq) {
        return {
          valid: false,
          isValid: false,
          errorCode: 'APPROVAL_AUDIT_INVALID',
          reason: `sequence番号が連番になっていません (期待: ${expectedSeq}, 実際: ${events[i].sequence})`
        };
      }
    }

    // 3. 状態遷移順序の検証
    const expectedStates: ApprovalState[] = [
      'PLAN_CREATED',
      'AWAITING_USER_APPROVAL',
      'USER_APPROVAL_RECEIVED',
      'IMPLEMENTATION_ALLOWED'
    ];

    if (events.length !== 4) {
      return {
        valid: false,
        isValid: false,
        errorCode: 'APPROVAL_AUDIT_INVALID',
        reason: `必須の4イベントが完結していません (現在: ${events.length}件)`
      };
    }

    for (let i = 0; i < 4; i++) {
      if (events[i].state !== expectedStates[i]) {
        return {
          valid: false,
          isValid: false,
          errorCode: 'APPROVAL_AUDIT_INVALID',
          reason: `sequence ${i + 1} の状態が不正です (期待: ${expectedStates[i]}, 実際: ${events[i].state})`
        };
      }
    }

    // 4. USER_APPROVAL_RECEIVED の属性検証（USER_MESSAGE）
    const approvedEvent = events[2];
    if (approvedEvent.source !== 'USER_MESSAGE') {
      return {
        valid: false,
        isValid: false,
        errorCode: 'APPROVAL_AUDIT_INVALID',
        reason: 'USER_APPROVAL_RECEIVEDのsourceはUSER_MESSAGEである必要があります'
      };
    }

    return { valid: true, isValid: true };
  }

  /**
   * 互換性のためのタイムライン検証
   */
  validateTimeline(): TimelineValidationResult {
    return this.validateSequence(this.events);
  }

  /**
   * 実装着手可能であることをアサート
   */
  assertImplementationAllowed(): void {
    const val = this.validateSequence(this.events);
    if (!val.valid) {
      throw new AutomationError('APPROVAL_AUDIT_INVALID', `承認監査不整合のため実装着手を拒否します: ${val.reason}`);
    }
    const current = this.getCurrentState();
    if (current !== 'IMPLEMENTATION_ALLOWED') {
      throw new AutomationError(
        'APPROVAL_AUDIT_INVALID',
        `現在のステータスが IMPLEMENTATION_ALLOWED ではありません (現在: ${current})`
      );
    }
  }
}
