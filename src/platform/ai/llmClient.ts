import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
}

export interface LlmResponse<T> {
  data: T;
  usage: LlmUsage;
  provider: string;
  model: string;
  isRealApiCall: boolean;
}

export class LlmClient {
  /**
   * Claude Haiku 5.5 による厳格な Structured Outputs 呼び出し
   * - model: claude-haiku-5-5 (or process.env.ANTHROPIC_MODEL)
   * - effort: high
   * - output_config: json_schema による厳格拘束
   * - ANTHROPIC_API_KEY なしの場合は例外をスロー（Fail-Closed: PLAN_AI_UNAVAILABLE）
   */
  static async callClaudeStructured<T>(params: {
    systemPrompt: string;
    userPrompt: string;
    jsonSchema: Record<string, any>;
    schema: z.ZodSchema<T>;
    effort?: 'low' | 'medium' | 'high';
  }): Promise<LlmResponse<T>> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('PLAN_AI_UNAVAILABLE: ANTHROPIC_API_KEY is not configured in environment.');
    }

    const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
    const effort = params.effort || 'high';
    const client = new Anthropic({ apiKey });

    const startTime = Date.now();

    // Anthropic Structured Outputs via Tool Use (Guaranteed schema enforcement)
    const toolName = 'submit_plan';
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: params.systemPrompt,
      messages: [
        {
          role: 'user',
          content: `${params.userPrompt}\n\n必ず submit_plan ツールを呼び出して構造化計画を出力してください。`
        }
      ],
      tools: [
        {
          name: toolName,
          description: '自律的に策定した構造化実行計画 (Execution Plan) を出力する',
          input_schema: params.jsonSchema as any
        }
      ],
      tool_choice: {
        type: 'tool',
        name: toolName
      }
    });

    const latencyMs = Date.now() - startTime;

    // Extract tool call
    const toolUseBlock = response.content.find((c: any) => c.type === 'tool_use');
    if (!toolUseBlock || toolUseBlock.type !== 'tool_use') {
      throw new Error('PLAN_AI_STRUCTURE_FAILED: Claude Haiku 5.5 did not return a valid structured tool output.');
    }

    const rawData = toolUseBlock.input;

    // Double validation: Zod validation
    const validatedData = params.schema.parse(rawData);

    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;

    return {
      data: validatedData,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        latencyMs
      },
      provider: 'Anthropic Claude',
      model,
      isRealApiCall: true
    };
  }
}
