import type { Database } from '@recipes/db/client';
import { sql } from '@recipes/db/operators';
import type {
  LlmRequestContext,
  StructuredOutputCallOptions,
} from '../llm/openrouter';
import {
  getDailyLlmUsage,
  recordLlmUsage,
} from './postgres';

const LLM_BUDGET_LOCK_NAMESPACE = 1_382_369_547;
const LLM_BUDGET_LOCK_KEY = 2;

export class LlmBudgetExceededError extends Error {
  readonly spentUsd: number;
  readonly limitUsd: number;

  constructor(spentUsd: number, limitUsd: number) {
    super(
      `daily LLM budget reached ($${spentUsd.toFixed(6)} spent of $${limitUsd.toFixed(2)})`,
    );
    this.name = 'LlmBudgetExceededError';
    this.spentUsd = spentUsd;
    this.limitUsd = limitUsd;
  }
}

export interface BudgetedLlmCallOptions {
  readonly db: Database;
  readonly runId: string;
  readonly dailyBudgetUsd: number;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

/**
 * Build per-task hooks that enforce the durable daily budget and account for
 * every provider response before its content is parsed.
 *
 * Scan fallback and enrichment run on separate queues and may overlap. A
 * transaction-scoped advisory lock serializes the preflight through the
 * durable usage write across worker processes. Therefore only the one request
 * already admitted below the cap can cross the remaining budget.
 */
export function createBudgetedLlmCallOptions(
  options: BudgetedLlmCallOptions,
): StructuredOutputCallOptions {
  if (!Number.isFinite(options.dailyBudgetUsd) || options.dailyBudgetUsd <= 0) {
    throw new TypeError('dailyBudgetUsd must be a positive finite number');
  }

  let activeLease: BudgetLease | null = null;

  return {
    signal: options.signal,
    async beforeRequest(context) {
      if (activeLease !== null) {
        throw new Error(
          `LLM budget lease already held before ${requestLabel(context)}`,
        );
      }
      activeLease = await acquireBudgetLease(
        options.db,
        options.dailyBudgetUsd,
        options.now?.() ?? new Date(),
      );
    },
    async onUsage(usage) {
      if (activeLease === null) {
        throw new Error('Cannot record LLM usage without an active budget lease');
      }
      // Write through the ordinary pool so this increment commits before the
      // advisory-lock transaction is released. The next admitted preflight
      // will therefore observe it, and a later parsing failure cannot erase it.
      await recordLlmUsage(options.db, options.runId, {
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        costUsd: usage.costUsd,
      });
    },
    async afterRequest(context) {
      const lease = activeLease;
      activeLease = null;
      if (lease === null) {
        throw new Error(
          `Cannot release missing LLM budget lease after ${requestLabel(context)}`,
        );
      }
      await lease.release();
    },
  };
}

export function isLlmBudgetExceeded(
  error: unknown,
): error is LlmBudgetExceededError {
  return error instanceof LlmBudgetExceededError;
}

interface BudgetLease {
  release(): Promise<void>;
}

async function acquireBudgetLease(
  db: Database,
  dailyBudgetUsd: number,
  at: Date,
): Promise<BudgetLease> {
  let releaseTransaction!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseTransaction = resolve;
  });
  let resolveAcquired!: () => void;
  let rejectAcquired!: (error: unknown) => void;
  let acquisitionSettled = false;
  const acquired = new Promise<void>((resolve, reject) => {
    resolveAcquired = resolve;
    rejectAcquired = reject;
  });

  const transaction = db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${LLM_BUDGET_LOCK_NAMESPACE}, ${LLM_BUDGET_LOCK_KEY})`,
    );
    const usage = await getDailyLlmUsage(tx as unknown as Database, at);
    if (usage.costUsd >= dailyBudgetUsd) {
      throw new LlmBudgetExceededError(usage.costUsd, dailyBudgetUsd);
    }
    acquisitionSettled = true;
    resolveAcquired();
    await held;
  });

  void transaction.catch((error: unknown) => {
    if (!acquisitionSettled) {
      acquisitionSettled = true;
      rejectAcquired(error);
    }
  });

  await acquired;
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      releaseTransaction();
      await transaction;
    },
  };
}

function requestLabel(context: LlmRequestContext): string {
  return `${context.taskName} ${context.attempt} request`;
}
