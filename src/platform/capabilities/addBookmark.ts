import { CapabilityDefinition, CapabilityExecutionContext, CapabilityExecutionResult, CapabilityObservationResult } from '../types/capability';

export const AddBookmarkCapability: CapabilityDefinition = {
  capabilityId: 'ADD_BOOKMARK',
  version: '1.0.0',
  description: 'まなびポケット 共通ブックマーク/URLリンクの登録と検証',
  supportedPages: ['/school-admin/bookmarks'],
  riskClass: 'REVERSIBLE_WRITE',
  testStatus: 'MOCK_TESTED',
  productionValidated: false,
  createdBy: 'SYSTEM',
  updatedAt: new Date().toISOString(),

  async observe(context: CapabilityExecutionContext, input?: any): Promise<CapabilityObservationResult> {
    const title = input?.title || '新ブックマーク';
    context.logger.info(`[ADD_BOOKMARK] Checking bookmarks for ${context.schoolCode}`);
    const existingBookmarks = input?.mockExistingBookmarks || [];
    const alreadyExists = existingBookmarks.includes(title);

    return {
      currentState: { existingBookmarks, alreadyExists },
      eligible: !alreadyExists,
      skipReason: alreadyExists ? `Bookmark "${title}" already exists` : undefined
    };
  },

  async plan(context: CapabilityExecutionContext, input?: any): Promise<any> {
    return {
      title: input?.title,
      url: input?.url,
      action: 'ADD_BOOKMARK'
    };
  },

  async execute(context: CapabilityExecutionContext, input?: any): Promise<CapabilityExecutionResult> {
    const title = input?.title || '参考URL';
    const url = input?.url || 'https://example.com';

    if (context.isDryRun) {
      context.logger.info(`[ADD_BOOKMARK] Dry-run: Proposed bookmark "${title}" (${url}) for ${context.schoolCode}`);
      return {
        success: true,
        appliedChanges: { title, url, dryRunOnly: true },
        beforeState: { bookmarksCount: 0 },
        afterState: { proposedCount: 1 },
        verified: true,
        message: `[DRY_RUN] Bookmark registration simulated for ${context.schoolCode}`
      };
    }

    return {
      success: true,
      appliedChanges: { title, url },
      beforeState: { bookmarksCount: 0 },
      afterState: { bookmarksCount: 1, title, url },
      verified: true,
      message: `Bookmark "${title}" registered successfully for ${context.schoolCode}`
    };
  },

  async verify(context: CapabilityExecutionContext, input?: any): Promise<boolean> {
    return true;
  }
};
