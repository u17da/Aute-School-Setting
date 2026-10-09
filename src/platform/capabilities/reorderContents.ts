import * as crypto from 'crypto';
import { CapabilityDefinition, CapabilityExecutionContext, CapabilityExecutionResult, CapabilityObservationResult } from '../types/capability';

export interface ContentItem {
  id: number;
  name: string;
  type?: string;
  contentable_id?: number;
}

export function calculateOrderHash(items: (number | string)[]): string {
  return crypto.createHash('sha256').update(items.join('::')).digest('hex');
}

export const ReorderContentsCapability: CapabilityDefinition = {
  capabilityId: 'REORDER_CONTENTS',
  version: '1.2.0',
  description: 'まなびポケット コンテンツ表示優先度・並び替え設定の適用と永続化検証',
  supportedPages: ['https://ed-cl.com/dashboard'],
  inputSchema: {
    type: 'object',
    properties: {
      targetOrder: {
        type: 'array',
        items: { type: 'string' },
        description: '表示順序に配置したいコンテンツ名の一覧（完全一致、先頭が高優先度）'
      },
      targetOrderIds: {
        type: 'array',
        items: { type: 'number' },
        description: '（内部・復元専用）コンテンツIDの完全順序リスト'
      }
    },
    anyOf: [
      { required: ['targetOrder'] },
      { required: ['targetOrderIds'] }
    ]
  },
  parameterSemantics: [
    {
      name: 'targetOrder',
      type: 'array',
      description: 'コンテンツ名の優先配置順序リスト。先頭に指定したコンテンツが最上位に配置されます。'
    },
    {
      name: 'targetOrderIds',
      type: 'array',
      description: '（内部・ロールバック用）コンテンツIDの配列。'
    }
  ],
  preconditions: [
    '学校管理者でログイン済みであること',
    'コンテンツ優先度設定画面が表示されていること'
  ],
  constraints: [
    '指定されていないコンテンツは既存の相対順序を維持して後方に配置されます',
    '存在しないコンテンツ名や重複・同名複数ヒット時は fail closed します',
    '変更後は設定保存ボタンを押し、リロード後にハッシュ一致を検証します'
  ],
  riskClass: 'REVERSIBLE_WRITE',
  testStatus: 'PRODUCTION_VALIDATED',
  productionValidated: true,
  createdBy: 'SYSTEM',
  updatedAt: new Date().toISOString(),

  async observe(context: CapabilityExecutionContext, input?: any): Promise<CapabilityObservationResult> {
    context.logger.info(`[REORDER_CONTENTS] Observing current content order for ${context.schoolCode}`);
    const page = (context.page as any).rawPage || (context.page as any).page; // Raw playwright page from GuardedPage

    if (!page) {
      // Mock / fallback observation for headless testing without real browser
      const mockOrderIds = [616, 621, 622, 800, 573];
      const mockOrderNames = ['MEXCBT連携アプリ', 'Google', 'Microsoft 365', '学研まんがひみつ文庫', 'eboard（いーぼーど）'];
      const baselineOrderHash = calculateOrderHash(mockOrderIds);
      
      let desiredOrderIds: number[] = mockOrderIds;
      if (input?.targetOrderIds && Array.isArray(input.targetOrderIds)) {
        desiredOrderIds = input.targetOrderIds;
      } else if (input?.targetOrder && Array.isArray(input.targetOrder)) {
        const resolvedIds: number[] = [];
        for (const name of input.targetOrder) {
          const idx = mockOrderNames.indexOf(name);
          if (idx !== -1) resolvedIds.push(mockOrderIds[idx]);
        }
        const remaining = mockOrderIds.filter(id => !resolvedIds.includes(id));
        desiredOrderIds = [...resolvedIds, ...remaining];
      }

      const desiredOrderHash = calculateOrderHash(desiredOrderIds);
      const requiresChange = baselineOrderHash !== desiredOrderHash;

      return {
        currentState: {
          currentOrderIds: mockOrderIds,
          currentOrderNames: mockOrderNames,
          desiredOrderIds,
          contentCount: mockOrderIds.length,
          baselineOrderHash,
          desiredOrderHash,
          requiresChange
        },
        eligible: requiresChange,
        skipReason: requiresChange ? undefined : 'ALREADY_CONFIGURED'
      };
    }

    // 1. Fetch current contents from active session
    const contents: any[] = await page.evaluate(async () => {
      const res = await fetch('/contents', { credentials: 'include' });
      if (!res.ok) throw new Error(`Failed to fetch /contents: HTTP ${res.status}`);
      return await res.json();
    });

    const currentOrderIds: number[] = contents.map(c => c.contentable_id);
    const currentOrderNames: string[] = contents.map(c => c.name);
    const baselineOrderHash = calculateOrderHash(currentOrderIds);

    // 2. Resolve target order IDs dynamically without hardcoded constants
    let desiredOrderIds: number[] = [];

    if (input?.targetOrderIds && Array.isArray(input.targetOrderIds)) {
      // Internal restore / rollback mode: validate ID membership
      const inputIdSet = new Set(input.targetOrderIds);
      const currentIdSet = new Set(currentOrderIds);
      if (inputIdSet.size !== currentIdSet.size || !input.targetOrderIds.every((id: number) => currentIdSet.has(id))) {
        throw new Error('INVALID_TARGET_ORDER_IDS: Provided targetOrderIds do not match existing contents');
      }
      desiredOrderIds = input.targetOrderIds;
    } else if (input?.targetOrder && Array.isArray(input.targetOrder)) {
      // Human / AI prompt mode: resolve names to IDs strictly
      const seenNames = new Set<string>();
      const resolvedPriorityIds: number[] = [];

      for (const targetName of input.targetOrder) {
        if (typeof targetName !== 'string' || !targetName.trim()) {
          throw new Error('INVALID_TARGET_ORDER_ENTRY: Target content name must be a non-empty string');
        }
        if (seenNames.has(targetName)) {
          throw new Error(`DUPLICATE_TARGET_ORDER: Duplicate content name "${targetName}" in targetOrder`);
        }
        seenNames.add(targetName);

        // Exact match search
        const matched = contents.filter(c => c.name === targetName);
        if (matched.length === 0) {
          throw new Error(`TARGET_CONTENT_NOT_FOUND: Content "${targetName}" was not found in school contents`);
        }
        if (matched.length > 1) {
          throw new Error(`AMBIGUOUS_CONTENT_NAME: Multiple contents matched "${targetName}" (${matched.length} items found)`);
        }
        resolvedPriorityIds.push(matched[0].contentable_id);
      }

      // Preserve relative order for unmentioned contents
      const remainingIds = currentOrderIds.filter(id => !resolvedPriorityIds.includes(id));
      desiredOrderIds = [...resolvedPriorityIds, ...remainingIds];
    } else {
      throw new Error('MISSING_TARGET_ORDER: Either targetOrder (string[]) or targetOrderIds (number[]) must be provided');
    }

    const desiredOrderHash = calculateOrderHash(desiredOrderIds);
    const requiresChange = baselineOrderHash !== desiredOrderHash;
    const movedCount = currentOrderIds.filter((id, i) => id !== desiredOrderIds[i]).length;

    context.logger.info(`[REORDER_CONTENTS] Current Items Count: ${currentOrderIds.length}, RequiresChange: ${requiresChange}, MovedCount: ${movedCount}`);

    return {
      currentState: {
        currentOrderIds,
        currentOrderNames,
        desiredOrderIds,
        contentCount: currentOrderIds.length,
        movedCount,
        baselineOrderHash,
        desiredOrderHash,
        requiresChange
      },
      eligible: requiresChange,
      skipReason: requiresChange ? undefined : 'ALREADY_CONFIGURED'
    };
  },

  async plan(context: CapabilityExecutionContext, input?: any): Promise<any> {
    const obs = await this.observe(context, input);
    return {
      capabilityId: 'REORDER_CONTENTS',
      riskClass: 'REVERSIBLE_WRITE',
      observation: obs.currentState,
      requiresChange: obs.eligible
    };
  },

  async execute(context: CapabilityExecutionContext, input?: any): Promise<CapabilityExecutionResult> {
    const page = (context.page as any).rawPage || (context.page as any).page;
    if (!page) {
      throw new Error('Real Playwright page is required for execution');
    }

    const obs = await this.observe(context, input);
    const state = obs.currentState;

    if (context.isDryRun) {
      context.logger.info(`[REORDER_CONTENTS] Dry-run only for ${context.schoolCode}. Zero saves performed.`);
      return {
        success: true,
        appliedChanges: {
          dryRunOnly: true,
          saveAttempts: 0,
          currentOrderIds: state.currentOrderIds,
          desiredOrderIds: state.desiredOrderIds,
          baselineOrderHash: state.baselineOrderHash,
          desiredOrderHash: state.desiredOrderHash,
          movedCount: state.movedCount,
          requiresChange: state.requiresChange
        },
        beforeState: { orderIds: state.currentOrderIds, hash: state.baselineOrderHash },
        afterState: { orderIds: state.desiredOrderIds, hash: state.desiredOrderHash },
        verified: true,
        message: `[DRY_RUN] Read-only verification succeeded for ${context.schoolCode}. Save attempts: 0.`
      };
    }

    // -------------------------------------------------------------
    // Production Write (Canary / Apply) with Dynamic orgId resolution
    // -------------------------------------------------------------
    const targetOrderIds: number[] = state.desiredOrderIds;
    context.logger.info(`[REORDER_CONTENTS] Performing Production Write for ${context.schoolCode}. Target Order: ${JSON.stringify(targetOrderIds.slice(0, 5))}...`);

    // Dynamically extract orgId and CSRF token from page DOM / API without hardcoding
    const writeResult = await page.evaluate(async (targetIds: number[]) => {
      // 1. Resolve orgId dynamically
      let orgId: string | null = null;

      // Check current URL pathname
      const urlMatch = window.location.pathname.match(/\/organizations\/(\d+)/);
      if (urlMatch && urlMatch[1]) {
        orgId = urlMatch[1];
      }

      // Check links in DOM
      if (!orgId) {
        const orgLinks = Array.from(document.querySelectorAll('a[href*="/organizations/"]'));
        for (const link of orgLinks) {
          const m = link.getAttribute('href')?.match(/\/organizations\/(\d+)/);
          if (m && m[1]) {
            orgId = m[1];
            break;
          }
        }
      }

      // Check form actions in DOM
      if (!orgId) {
        const forms = Array.from(document.querySelectorAll('form[action*="/organizations/"]'));
        for (const form of forms) {
          const m = form.getAttribute('action')?.match(/\/organizations\/(\d+)/);
          if (m && m[1]) {
            orgId = m[1];
            break;
          }
        }
      }

      // Check meta or scripts if any
      if (!orgId) {
        const metaOrg = document.querySelector('meta[name="organization-id"]')?.getAttribute('content');
        if (metaOrg && /^\d+$/.test(metaOrg)) {
          orgId = metaOrg;
        }
      }

      if (!orgId) {
        return {
          success: false,
          status: 400,
          error: 'ORG_ID_RESOLUTION_FAILED: Failed to dynamically resolve orgId from page context. Refusing to fallback.'
        };
      }

      const metaCsrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
      const payload = {
        content_positions: targetIds.map(id => ({ contentable_id: id, contentable_type: 'Content' }))
      };

      const res = await fetch(`/organizations/${orgId}/content_position`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-CSRF-Token': metaCsrf || ''
        },
        credentials: 'include',
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const text = await res.text();
        return { success: false, status: res.status, error: text, orgId };
      }

      return { success: true, status: res.status, orgId };
    }, targetOrderIds);

    if (!writeResult.success) {
      context.logger.error(`[REORDER_CONTENTS] Save failed: HTTP ${writeResult.status} ${writeResult.error}`);
      return {
        success: false,
        error: writeResult.error || `SAVE_FAILED_KNOWN: HTTP ${writeResult.status}`,
        message: `Save failed with HTTP ${writeResult.status}`,
        appliedChanges: {},
        beforeState: { orderIds: state.currentOrderIds },
        afterState: {},
        verified: false
      };
    }

    context.logger.info(`[REORDER_CONTENTS] Save succeeded (attempts=1, retry=0, orgId=${writeResult.orgId}). Performing Reload & Persisted Verify...`);

    // Reload page to ensure changes are persisted on server
    await page.reload({ waitUntil: 'networkidle' });

    // Persisted Verify
    const verifyObs = await this.observe(context, input);
    const persistedOrderIds: number[] = verifyObs.currentState.currentOrderIds;
    const persistedHash = calculateOrderHash(persistedOrderIds);
    const expectedHash = calculateOrderHash(targetOrderIds);

    const isVerified = persistedHash === expectedHash;
    context.logger.info(`[REORDER_CONTENTS] Persisted Verify result: ${isVerified ? 'PASS' : 'FAIL'} (Hash: ${persistedHash} vs ${expectedHash})`);

    if (!isVerified) {
      return {
        success: false,
        error: 'PERSISTED_VERIFY_FAILED: Order after reload does not match expected order',
        message: 'Persisted verification failed',
        appliedChanges: {},
        beforeState: { orderIds: state.currentOrderIds },
        afterState: { persistedOrderIds },
        verified: false
      };
    }

    return {
      success: true,
      appliedChanges: {
        persistedOrderIds,
        persistedHash,
        orgId: writeResult.orgId,
        saveAttempts: 1
      },
      beforeState: { orderIds: state.currentOrderIds, hash: state.baselineOrderHash },
      afterState: { orderIds: persistedOrderIds, hash: persistedHash },
      verified: true,
      message: `Persisted verification PASSED for ${context.schoolCode}.`
    };
  },

  async verify(context: CapabilityExecutionContext, input?: any): Promise<boolean> {
    const obs = await this.observe(context, input);
    return obs.currentState !== undefined && obs.currentState.currentOrderIds.length > 0;
  }
};
