import {
  db,
  desc,
  eq,
  recipes,
  scanRuns,
  sources,
  sql,
} from '@recipes/db';
import type { ScanRunKind, ScanRunStatus } from '@recipes/shared';

export interface OpsSource {
  id: string;
  name: string;
  baseUrl: string;
  feedUrl: string | null;
  enabled: boolean;
  lastScannedAt: Date | null;
  hasFeedCheckpoint: boolean;
  run: {
    id: string;
    status: ScanRunStatus;
    startedAt: Date;
    finishedAt: Date | null;
    found: number;
    newCount: number;
    noRecipeCount: number;
    costUsd: number;
    error: string | null;
  } | null;
}

export interface RecentScan {
  id: string;
  kind: ScanRunKind;
  sourceName: string;
  status: ScanRunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  found: number;
  newCount: number;
  noRecipeCount: number;
  costUsd: number;
  error: string | null;
}

export interface LatestAggregate {
  status: ScanRunStatus | 'idle';
  sourceCount: number;
  completedCount: number;
  found: number;
  newCount: number;
  noRecipeCount: number;
  costUsd: number;
  latestActivityAt: Date | null;
}

export interface OpsSnapshot {
  totals: {
    recipes: number;
    activeRecipes: number;
    pendingRecipes: number;
    rejectedRecipes: number;
    sources: number;
    enabledSources: number;
  };
  llmToday: {
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
  };
  latest: LatestAggregate;
  sources: OpsSource[];
  recentScans: RecentScan[];
}

const RECENT_SCAN_LIMIT = 24;

export async function loadOpsSnapshot(): Promise<OpsSnapshot> {
  const latestScan = db
    .select({
      id: scanRuns.id,
      status: scanRuns.status,
      startedAt: scanRuns.startedAt,
      finishedAt: scanRuns.finishedAt,
      found: scanRuns.found,
      newCount: scanRuns.newCount,
      noRecipeCount: scanRuns.noRecipeCount,
      costUsd: scanRuns.costUsd,
      error: scanRuns.error,
    })
    .from(scanRuns)
    .where(eq(scanRuns.sourceId, sources.id))
    .orderBy(desc(scanRuns.startedAt))
    .limit(1)
    .as('latest_source_scan');

  const [recipeTotal, sourceTotal, sourceRows, recentRows, llmToday] = await Promise.all([
    db
      .select({
        count: sql<number>`count(*)::int`,
        activeCount: sql<number>`count(*) filter (where ${recipes.status} = 'active')::int`,
        pendingCount: sql<number>`count(*) filter (where ${recipes.status} = 'pending')::int`,
        rejectedCount: sql<number>`count(*) filter (where ${recipes.status} = 'rejected')::int`,
      })
      .from(recipes),
    db
      .select({
        count: sql<number>`count(*)::int`,
        enabledCount: sql<number>`count(*) filter (where ${sources.enabled})::int`,
      })
      .from(sources),
    db
      .select({
        id: sources.id,
        name: sources.name,
        baseUrl: sources.baseUrl,
        feedUrl: sources.feedUrl,
        enabled: sources.enabled,
        lastScannedAt: sources.lastScannedAt,
        feedEtag: sources.feedEtag,
        feedLastModified: sources.feedLastModified,
        runId: latestScan.id,
        runStatus: latestScan.status,
        runStartedAt: latestScan.startedAt,
        runFinishedAt: latestScan.finishedAt,
        runFound: latestScan.found,
        runNewCount: latestScan.newCount,
        runNoRecipeCount: latestScan.noRecipeCount,
        runCostUsd: latestScan.costUsd,
        runError: latestScan.error,
      })
      .from(sources)
      .leftJoinLateral(latestScan, sql`true`)
      .orderBy(desc(sources.enabled), sources.name),
    db
      .select({
        id: scanRuns.id,
        kind: scanRuns.kind,
        sourceName: sources.name,
        status: scanRuns.status,
        startedAt: scanRuns.startedAt,
        finishedAt: scanRuns.finishedAt,
        found: scanRuns.found,
        newCount: scanRuns.newCount,
        noRecipeCount: scanRuns.noRecipeCount,
        costUsd: scanRuns.costUsd,
        error: scanRuns.error,
      })
      .from(scanRuns)
      .leftJoin(sources, eq(scanRuns.sourceId, sources.id))
      .orderBy(desc(scanRuns.startedAt))
      .limit(RECENT_SCAN_LIMIT),
    db
      .select({
        tokensIn: sql<number>`coalesce(sum(${scanRuns.tokensIn}), 0)::int`,
        tokensOut: sql<number>`coalesce(sum(${scanRuns.tokensOut}), 0)::int`,
        costUsd: sql<number>`coalesce(sum(${scanRuns.costUsd}), 0)::double precision`,
      })
      .from(scanRuns)
      .where(
        sql`${scanRuns.startedAt} >= (
          date_trunc('day', now() at time zone 'UTC')
          at time zone 'UTC'
        )`,
      ),
  ]);

  const sourceSnapshots: OpsSource[] = sourceRows.map((row) => ({
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    feedUrl: row.feedUrl,
    enabled: row.enabled,
    lastScannedAt: row.lastScannedAt,
    hasFeedCheckpoint: row.feedEtag !== null || row.feedLastModified !== null,
    run:
      row.runId === null ||
      row.runStatus === null ||
      row.runStartedAt === null ||
      row.runFound === null ||
      row.runNewCount === null ||
      row.runNoRecipeCount === null ||
      row.runCostUsd === null
        ? null
        : {
            id: row.runId,
            status: row.runStatus,
            startedAt: row.runStartedAt,
            finishedAt: row.runFinishedAt,
            found: row.runFound,
            newCount: row.runNewCount,
            noRecipeCount: row.runNoRecipeCount,
            costUsd: row.runCostUsd,
            error: row.runError,
          },
  }));

  return {
    totals: {
      recipes: recipeTotal[0]?.count ?? 0,
      activeRecipes: recipeTotal[0]?.activeCount ?? 0,
      pendingRecipes: recipeTotal[0]?.pendingCount ?? 0,
      rejectedRecipes: recipeTotal[0]?.rejectedCount ?? 0,
      sources: sourceTotal[0]?.count ?? 0,
      enabledSources: sourceTotal[0]?.enabledCount ?? 0,
    },
    llmToday: {
      tokensIn: llmToday[0]?.tokensIn ?? 0,
      tokensOut: llmToday[0]?.tokensOut ?? 0,
      costUsd: llmToday[0]?.costUsd ?? 0,
    },
    latest: aggregateLatest(sourceSnapshots),
    sources: sourceSnapshots,
    recentScans: recentRows.map((row) => ({
      ...row,
      sourceName:
        row.kind === 'search'
          ? 'Search'
          : row.sourceName ?? 'All sources',
    })),
  };
}

export function aggregateLatest(sourceSnapshots: OpsSource[]): LatestAggregate {
  const enabledSourceCount = sourceSnapshots.filter((source) => source.enabled).length;
  const latestRuns = sourceSnapshots
    .filter((source) => source.enabled)
    .flatMap((source) => (source.run === null ? [] : [source.run]));
  const statuses = latestRuns.map((run) => run.status);

  let status: LatestAggregate['status'] = 'idle';
  if (statuses.includes('running')) {
    status = 'running';
  } else if (latestRuns.length > 0 && latestRuns.length < enabledSourceCount) {
    status = 'partial';
  } else if (statuses.length > 0 && statuses.every((value) => value === 'error')) {
    status = 'error';
  } else if (statuses.some((value) => value === 'partial' || value === 'error')) {
    status = 'partial';
  } else if (statuses.length > 0) {
    status = 'success';
  }

  const latestActivityAt = latestRuns.reduce<Date | null>((latest, run) => {
    const activity = run.finishedAt ?? run.startedAt;
    return latest === null || activity > latest ? activity : latest;
  }, null);

  return {
    status,
    sourceCount: enabledSourceCount,
    completedCount: statuses.filter((value) => value !== 'running').length,
    found: latestRuns.reduce((sum, run) => sum + run.found, 0),
    newCount: latestRuns.reduce((sum, run) => sum + run.newCount, 0),
    noRecipeCount: latestRuns.reduce((sum, run) => sum + run.noRecipeCount, 0),
    costUsd: latestRuns.reduce((sum, run) => sum + run.costUsd, 0),
    latestActivityAt,
  };
}
