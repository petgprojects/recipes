/**
 * Durable server-side LLM budget enforcement and accounting.
 *
 * This module deliberately lives outside either application: both the worker
 * and the web search route spend through the same implementation, so there is
 * one lease and one definition of each daily pot. It is a server-only package
 * subpath and is intentionally absent from the `@recipes/db` barrel.
 */

import type {
  LlmRequestContext,
  StructuredOutputCallOptions,
} from '@recipes/shared/llm';
import type { ScanRunKind } from '@recipes/shared';
import { and, eq, gte, lt, sql } from './operators';
import { scanRuns } from './schema';
import type { Database } from './client';

const LLM_BUDGET_LOCK_NAMESPACE = 1_382_369_547;
const LLM_BUDGET_LOCK_KEYS = {
  scan: 2,
  search: 3,
} as const satisfies Record<ScanRunKind, number>;

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

export interface LlmUsageIncrement {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
}

export interface DailyLlmUsage extends LlmUsageIncrement {
  readonly dayStartedAt: Date;
  readonly dayEndsAt: Date;
}

export interface BudgetedLlmCallOptions {
  readonly db: Database;
  readonly runId: string;
  readonly kind: ScanRunKind;
  readonly dailyBudgetUsd: number;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

/**
 * Build per-task hooks that enforce the kind-specific durable daily budget and
 * account for every provider response before its content is parsed.
 *
 * Each genuinely independent budget has its own transaction-scoped advisory
 * lock. Same-kind requests serialize preflight through the durable usage write,
 * while a search never waits behind enrichment merely because both use an LLM.
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
        options.kind,
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
      await recordLlmUsage(options.db, options.runId, options.kind, {
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

/**
 * Budget day is UTC and is attributed by run start. The kind is mandatory so
 * search and enrichment spend cannot silently leak into each other's pots.
 */
export async function getDailyLlmUsage(
  db: Database,
  kind: ScanRunKind,
  at = new Date(),
): Promise<DailyLlmUsage> {
  const dayStartedAt = utcDayStart(at);
  const dayEndsAt = nextUtcDay(dayStartedAt);
  const [usage] = await db
    .select({
      tokensIn: sql<number>`coalesce(sum(${scanRuns.tokensIn}), 0)::int`,
      tokensOut: sql<number>`coalesce(sum(${scanRuns.tokensOut}), 0)::int`,
      costUsd: sql<number>`coalesce(sum(${scanRuns.costUsd}), 0)::double precision`,
    })
    .from(scanRuns)
    .where(
      and(
        eq(scanRuns.kind, kind),
        gte(scanRuns.startedAt, dayStartedAt),
        lt(scanRuns.startedAt, dayEndsAt),
      ),
    );

  return {
    dayStartedAt,
    dayEndsAt,
    tokensIn: usage?.tokensIn ?? 0,
    tokensOut: usage?.tokensOut ?? 0,
    costUsd: usage?.costUsd ?? 0,
  };
}

/**
 * Records each provider response immediately. The arithmetic happens in
 * Postgres, so concurrent callbacks cannot lose one another's increments.
 *
 * Matching the row kind is part of the write guard: passing a search run to a
 * scan budget (or vice versa) fails rather than charging the wrong pot.
 */
export async function recordLlmUsage(
  db: Database,
  runId: string,
  kind: ScanRunKind,
  usage: LlmUsageIncrement,
): Promise<void> {
  assertUsage(usage);
  const updated = await db
    .update(scanRuns)
    .set({
      tokensIn: sql`${scanRuns.tokensIn} + ${usage.tokensIn}`,
      tokensOut: sql`${scanRuns.tokensOut} + ${usage.tokensOut}`,
      costUsd: sql`${scanRuns.costUsd} + ${usage.costUsd}`,
    })
    .where(and(eq(scanRuns.id, runId), eq(scanRuns.kind, kind)))
    .returning({ id: scanRuns.id });

  if (updated.length === 0) {
    throw new Error(
      `Cannot record ${kind} LLM usage for missing or mismatched scan run ${runId}`,
    );
  }
}

/**
 * Returns the UTC day's single search accumulator, creating it lazily.
 *
 * The search budget lock also protects row creation, so concurrent first
 * searches cannot create two accumulators. Every call marks the accumulator as
 * a successful completed operation and advances `finished_at` monotonically;
 * it never appears as an all-day stuck run in `/ops`.
 */
export async function getOrCreateDailySearchRun(
  db: Database,
  at = new Date(),
): Promise<string> {
  const dayStartedAt = utcDayStart(at);
  const dayEndsAt = nextUtcDay(dayStartedAt);

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${LLM_BUDGET_LOCK_NAMESPACE}, ${LLM_BUDGET_LOCK_KEYS.search})`,
    );

    const [existing] = await tx
      .select({
        id: scanRuns.id,
        finishedAt: scanRuns.finishedAt,
      })
      .from(scanRuns)
      .where(
        and(
          eq(scanRuns.kind, 'search'),
          gte(scanRuns.startedAt, dayStartedAt),
          lt(scanRuns.startedAt, dayEndsAt),
        ),
      )
      .limit(1);

    if (existing !== undefined) {
      await tx
        .update(scanRuns)
        .set({
          status: 'success',
          finishedAt:
            existing.finishedAt === null || existing.finishedAt < at
              ? at
              : existing.finishedAt,
        })
        .where(and(eq(scanRuns.id, existing.id), eq(scanRuns.kind, 'search')));
      return existing.id;
    }

    const [created] = await tx
      .insert(scanRuns)
      .values({
        sourceId: null,
        kind: 'search',
        startedAt: at,
        finishedAt: at,
        status: 'success',
        found: 0,
        newCount: 0,
        noRecipeCount: 0,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
      })
      .returning({ id: scanRuns.id });

    if (created === undefined) {
      throw new Error('Could not create daily search scan run');
    }
    return created.id;
  });
}

interface BudgetLease {
  release(): Promise<void>;
}

async function acquireBudgetLease(
  db: Database,
  kind: ScanRunKind,
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
      sql`select pg_advisory_xact_lock(${LLM_BUDGET_LOCK_NAMESPACE}, ${LLM_BUDGET_LOCK_KEYS[kind]})`,
    );
    const usage = await getDailyLlmUsage(
      tx as unknown as Database,
      kind,
      at,
    );
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

function utcDayStart(at: Date): Date {
  if (Number.isNaN(at.getTime())) throw new TypeError('Budget date is invalid');
  return new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()),
  );
}

function nextUtcDay(dayStartedAt: Date): Date {
  return new Date(dayStartedAt.getTime() + 24 * 60 * 60 * 1_000);
}

function assertUsage(usage: LlmUsageIncrement): void {
  if (!Number.isSafeInteger(usage.tokensIn) || usage.tokensIn < 0) {
    throw new TypeError('tokensIn must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(usage.tokensOut) || usage.tokensOut < 0) {
    throw new TypeError('tokensOut must be a non-negative safe integer');
  }
  if (!Number.isFinite(usage.costUsd) || usage.costUsd < 0) {
    throw new TypeError('costUsd must be a non-negative finite number');
  }
}

function requestLabel(context: LlmRequestContext): string {
  return `${context.taskName} ${context.attempt} request`;
}
