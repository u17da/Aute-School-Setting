import { CapabilityDefinition } from '../types/capability';
import { LoginAndVerifyCapability } from './loginAndVerify';
import { ReorderContentsCapability } from './reorderContents';
import { ChangeSchoolSettingsCapability } from './changeSchoolSettings';
import { CreateSchoolAdminCapability } from './createSchoolAdmin';
import { CreateGradeAndClassCapability } from './createGradeAndClass';
import { AddBookmarkCapability } from './addBookmark';

export class CapabilityRegistry {
  private static instance: CapabilityRegistry | null = null;
  private capabilities: Map<string, CapabilityDefinition> = new Map();

  constructor() {
    this.register(LoginAndVerifyCapability);
    this.register(ReorderContentsCapability);
    this.register(ChangeSchoolSettingsCapability);
    this.register(CreateSchoolAdminCapability);
    this.register(CreateGradeAndClassCapability);
    this.register(AddBookmarkCapability);
  }

  static getInstance(): CapabilityRegistry {
    if (!CapabilityRegistry.instance) {
      CapabilityRegistry.instance = new CapabilityRegistry();
    }
    return CapabilityRegistry.instance;
  }

  register(capability: CapabilityDefinition): void {
    this.capabilities.set(capability.capabilityId.toUpperCase(), capability);
  }

  get(capabilityId: string): CapabilityDefinition | undefined {
    return this.capabilities.get(capabilityId.toUpperCase());
  }

  has(capabilityId: string): boolean {
    return this.capabilities.has(capabilityId.toUpperCase());
  }

  list(): CapabilityDefinition[] {
    return Array.from(this.capabilities.values());
  }

  resolveOperations(operationTypes: string[]): {
    resolved: CapabilityDefinition[];
    unresolved: string[];
    unsupported: string[];
  } {
    const resolved: CapabilityDefinition[] = [];
    const unresolved: string[] = [];
    const unsupported: string[] = [];

    for (const opType of operationTypes) {
      const cap = this.get(opType);
      if (!cap) {
        unresolved.push(opType);
        unsupported.push(opType);
      } else if (!cap.productionValidated) {
        // Not yet production-validated in V1 (e.g. ADD_BOOKMARK)
        unsupported.push(`${opType} (NOT_PRODUCTION_VALIDATED)`);
        resolved.push(cap);
      } else {
        resolved.push(cap);
      }
    }


    return { resolved, unresolved, unsupported };
  }

  /**
   * AI (Claude Haiku 5.5) へ渡す動的 Capability カタログ情報
   * PRODUCTION_VALIDATED 済みの Capability のみを対象とする
   */
  getCatalogForAi(): Array<{

    capabilityId: string;
    version: string;
    description: string;
    riskClass: string;
    inputSchema?: Record<string, any>;
    parameterSemantics?: any[];
    preconditions?: string[];
    constraints?: string[];
  }> {
    return this.list()
      .filter(cap => cap.productionValidated && cap.testStatus === 'PRODUCTION_VALIDATED')
      .map(cap => ({
        capabilityId: cap.capabilityId,
        version: cap.version,
        description: cap.description,
        riskClass: cap.riskClass,
        inputSchema: cap.inputSchema,
        parameterSemantics: cap.parameterSemantics || [],
        preconditions: cap.preconditions || [],
        constraints: cap.constraints || []
      }));
  }

  /**
   * Claude Structured Outputs 用の dynamic JSON Schema 生成
   * anyOf / const により capabilityId と専用 inputSchema を厳格にペアリング
   */
  getPlanJsonSchema(): Record<string, any> {
    const validCaps = this.getCatalogForAi();

    const operationAnyOf = validCaps.map(cap => ({
      type: 'object',
      properties: {
        capabilityId: {
          type: 'string',
          const: cap.capabilityId
        },
        capabilityVersion: {
          type: 'string',
          default: cap.version
        },
        input: cap.inputSchema || { type: 'object' },
        skipCondition: {
          type: 'string',
          enum: ['NONE', 'CURRENT_VALUE_EQUALS_DESIRED', 'ALREADY_EXISTS'],
          default: 'NONE',
          description: '操作スキップ条件（設定済みならスキップの場合 CURRENT_VALUE_EQUALS_DESIRED）'
        },
        riskClass: {
          type: 'string',
          const: cap.riskClass
        }
      },
      required: ['capabilityId', 'input', 'riskClass'],
      additionalProperties: false
    }));

    return {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['READY', 'NEEDS_CLARIFICATION', 'UNSUPPORTED'],
          description: 'READY: 実行計画策定完了, NEEDS_CLARIFICATION: 意図が曖昧で質問が必要, UNSUPPORTED: 既存Capabilityで対応不可'
        },
        summary: {
          type: 'object',
          properties: {
            interpretedIntent: { type: 'string', description: 'ユーザー指示の解釈概要' },
            targetScope: { type: 'string', description: '対象学校（指定された学校 / 全学校など）' },
            actionSummary: { type: 'string', description: '実行する具体的な変更内容' },
            settingValueSummary: { type: 'string', description: '設定値（例: studentPasswordChange: SHOW）' },
            skipBehavior: { type: 'string', description: '設定済み時の挙動（スキップするか等）' },
            capabilityUsed: { type: 'string', description: '使用するCapability名' },
            riskLevel: { type: 'string', description: 'リスク分類' }
          },
          required: ['interpretedIntent', 'actionSummary', 'capabilityUsed', 'riskLevel'],
          description: '人間向け解釈サマリー（Raw JSONではなく人間に伝わる自然な説明）'
        },
        operations: {
          type: 'array',
          items: {
            anyOf: operationAnyOf
          },
          description: '実行する操作一覧（最小限の操作のみを選択）'
        },
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              question: { type: 'string' },
              context: { type: 'string' }
            },
            required: ['id', 'question', 'context']
          },
          description: '意図が曖昧な場合にユーザーへ確認すべき本当に必要な質問'
        },
        assumptions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              description: { type: 'string' },
              impactIfFalse: { type: 'string' }
            },
            required: ['id', 'description']
          },
          description: 'プラン立案にあたって置いた前提事項'
        },
        validationScopeProposal: {
          type: 'object',
          properties: {
            unit: {
              type: 'string',
              enum: ['SCHOOL', 'ACCOUNT', 'CLASS', 'SETTING_ITEM', 'CUSTOM'],
              description: '先行検証の対象単位'
            },
            count: {
              type: 'number',
              description: '先行検証で実行する対象の件数'
            },
            description: {
              type: 'string',
              description: '先行検証の提案内容の分かりやすい説明（例: 代表デモ学校1校で先行確認）'
            }
          },
          required: ['unit', 'count', 'description'],
          description: 'AIが提案する適切な先行検証の単位と規模'
        },
        planDiff: {
          type: 'object',
          properties: {
            added: { type: 'array', items: { type: 'string' }, description: '前回計画からの追加項目' },
            unchanged: { type: 'array', items: { type: 'string' }, description: '前回計画から変更のない項目' },
            removed: { type: 'array', items: { type: 'string' }, description: '前回計画から削除された項目' },
            summaryText: { type: 'string', description: '前回計画からの変更差分の人間向け日本語サマリー' }
          },
          required: ['added', 'unchanged', 'removed', 'summaryText'],
          description: '再計画時の前回計画との変更差分'
        }
      },
      required: ['status', 'summary', 'operations', 'questions', 'assumptions'],
      additionalProperties: false
    };
  }

}

