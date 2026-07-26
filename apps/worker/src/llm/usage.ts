import type { ChatCompletion } from 'openai/resources/chat/completions';

/** Verified OpenRouter pricing for deepseek/deepseek-v4-flash (PROGRESS A1). */
export const DEEPSEEK_V4_FLASH_PRICING = {
  inputPerMillionUsd: 0.14,
  cachedInputPerMillionUsd: 0.028,
  outputPerMillionUsd: 0.28,
} as const;

export interface LlmPricing {
  readonly inputPerMillionUsd: number;
  readonly cachedInputPerMillionUsd: number;
  readonly outputPerMillionUsd: number;
}

export interface LlmUsage {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly totalTokens: number;
  readonly cachedTokensIn: number;
  readonly costUsd: number;
  readonly costSource: 'provider' | 'estimated';
}

export interface LlmUsageContext {
  readonly taskName: string;
  readonly attempt: 'initial' | 'repair';
  readonly responseId: string;
  readonly model: string;
}

export type LlmUsageCallback = (
  usage: LlmUsage,
  context: LlmUsageContext,
) => void | Promise<void>;

interface OpenRouterUsageExtension {
  readonly cost?: unknown;
  readonly prompt_tokens_details?: {
    readonly cached_tokens?: unknown;
  } | null;
}

/**
 * Read standard token counts plus OpenRouter's runtime-only `usage.cost`.
 *
 * The OpenAI SDK intentionally does not type vendor extensions, but it keeps
 * unknown response properties at runtime. Provider-reported cost is
 * authoritative; the model's verified rates are only a fallback.
 */
export function normalizeOpenRouterUsage(
  response: Pick<ChatCompletion, 'usage'>,
  pricing: LlmPricing = DEEPSEEK_V4_FLASH_PRICING,
): LlmUsage {
  const usage = response.usage;
  const tokensIn = nonnegativeInteger(usage?.prompt_tokens);
  const tokensOut = nonnegativeInteger(usage?.completion_tokens);
  const extension = usage as (typeof usage & OpenRouterUsageExtension) | undefined;
  const cachedTokensIn = Math.min(
    tokensIn,
    nonnegativeInteger(extension?.prompt_tokens_details?.cached_tokens),
  );
  const reportedCost = nonnegativeNumber(extension?.cost);

  if (reportedCost !== null) {
    return {
      tokensIn,
      tokensOut,
      totalTokens: nonnegativeInteger(usage?.total_tokens) || tokensIn + tokensOut,
      cachedTokensIn,
      costUsd: reportedCost,
      costSource: 'provider',
    };
  }

  const uncachedTokensIn = Math.max(0, tokensIn - cachedTokensIn);
  const costUsd =
    (uncachedTokensIn * pricing.inputPerMillionUsd +
      cachedTokensIn * pricing.cachedInputPerMillionUsd +
      tokensOut * pricing.outputPerMillionUsd) /
    1_000_000;

  return {
    tokensIn,
    tokensOut,
    totalTokens: nonnegativeInteger(usage?.total_tokens) || tokensIn + tokensOut,
    cachedTokensIn,
    costUsd,
    costSource: 'estimated',
  };
}

export function addLlmUsage(left: LlmUsage, right: LlmUsage): LlmUsage {
  return {
    tokensIn: left.tokensIn + right.tokensIn,
    tokensOut: left.tokensOut + right.tokensOut,
    totalTokens: left.totalTokens + right.totalTokens,
    cachedTokensIn: left.cachedTokensIn + right.cachedTokensIn,
    costUsd: left.costUsd + right.costUsd,
    costSource:
      left.costSource === 'provider' && right.costSource === 'provider'
        ? 'provider'
        : 'estimated',
  };
}

function nonnegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function nonnegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}
