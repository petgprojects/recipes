import type { Metadata } from 'next';
import { loadOpsSnapshot, type OpsSource } from '@/lib/ops-data';
import { ScanNowButton } from './scan-now-button';
import styles from './ops.module.css';

export const metadata: Metadata = {
  title: 'Operations · Recipe Planner',
  description: 'Recipe ingestion status, checkpoints, and scan history.',
};

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

const numberFormatter = new Intl.NumberFormat('en-US');

function formatDate(value: Date | null): string {
  return value === null ? 'Never' : dateFormatter.format(value);
}

function formatCost(value: number): string {
  return value === 0 ? '$0' : `$${value.toFixed(4)}`;
}

function duration(startedAt: Date, finishedAt: Date | null): string {
  if (finishedAt === null) return 'In progress';
  const seconds = Math.max(0, Math.round((finishedAt.getTime() - startedAt.getTime()) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

function sourceHealth(source: OpsSource): { label: string; tone: string } {
  if (!source.enabled) return { label: 'Disabled', tone: styles.statusQuiet };
  if (source.run === null) return { label: 'Awaiting first scan', tone: styles.statusQuiet };
  if (source.run.status === 'running') return { label: 'Scanning', tone: styles.statusActive };
  if (source.run.status === 'success') return { label: 'Healthy', tone: styles.statusGood };
  if (source.run.status === 'partial') return { label: 'Needs review', tone: styles.statusWarn };
  return { label: 'Failed', tone: styles.statusWarn };
}

export default async function OpsPage() {
  const snapshot = await loadOpsSnapshot();

  return (
    <main className={styles.shell}>
      <div className={styles.frame}>
        <header className={styles.header}>
          <div>
            <a className={styles.backLink} href="/">
              Recipe planner
            </a>
            <p className={styles.kicker}>Operations / deterministic ingestion</p>
            <h1>Source health</h1>
            <p className={styles.intro}>
              Current crawl checkpoints, latest source outcomes, and queue control.
            </p>
          </div>
          <ScanNowButton />
        </header>

        <section className={styles.metrics} aria-label="Current totals">
          <div>
            <span>Recipes</span>
            <strong>{numberFormatter.format(snapshot.totals.recipes)}</strong>
          </div>
          <div>
            <span>Sources</span>
            <strong>{numberFormatter.format(snapshot.totals.sources)}</strong>
          </div>
          <div>
            <span>Enabled</span>
            <strong>{numberFormatter.format(snapshot.totals.enabledSources)}</strong>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="latest-heading">
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.sectionIndex}>01 / latest state</p>
              <h2 id="latest-heading">Enabled sources</h2>
            </div>
            <p>
              Aggregates each enabled source’s most recent run. Latest activity:{' '}
              <strong>{formatDate(snapshot.latest.latestActivityAt)}</strong>
            </p>
          </div>
          <div className={styles.runSummary}>
            <div className={styles.outcome}>
              <span
                className={`${styles.statusDot} ${
                  snapshot.latest.status === 'success' ? styles.dotGood : ''
                }`}
                aria-hidden="true"
              />
              <div>
                <span>Outcome</span>
                <strong>{snapshot.latest.status}</strong>
              </div>
            </div>
            <dl>
              <div>
                <dt>Sources complete</dt>
                <dd>
                  {snapshot.latest.completedCount}/{snapshot.latest.sourceCount}
                </dd>
              </div>
              <div>
                <dt>Found</dt>
                <dd>{numberFormatter.format(snapshot.latest.found)}</dd>
              </div>
              <div>
                <dt>New</dt>
                <dd>{numberFormatter.format(snapshot.latest.newCount)}</dd>
              </div>
              <div>
                <dt>No Recipe</dt>
                <dd>{numberFormatter.format(snapshot.latest.noRecipeCount)}</dd>
              </div>
              <div>
                <dt>LLM cost</dt>
                <dd>{formatCost(snapshot.latest.costUsd)}</dd>
              </div>
            </dl>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="sources-heading">
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.sectionIndex}>02 / checkpoints</p>
              <h2 id="sources-heading">Source ledger</h2>
            </div>
            <p>Feed validators and scan boundaries advance only after retry-safe work.</p>
          </div>
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">Health</th>
                  <th scope="col">Last checkpoint</th>
                  <th scope="col">Latest counts</th>
                  <th scope="col">Feed validator</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.sources.map((source) => {
                  const health = sourceHealth(source);
                  return (
                    <tr key={source.id}>
                      <th scope="row">
                        <a href={source.baseUrl} target="_blank" rel="noreferrer">
                          {source.name}
                        </a>
                        {!source.enabled && <small>off</small>}
                      </th>
                      <td>
                        <span className={`${styles.status} ${health.tone}`}>
                          <span aria-hidden="true" />
                          {health.label}
                        </span>
                        {source.run?.error && (
                          <details className={styles.errorDetail}>
                            <summary>Details</summary>
                            <p>{source.run.error}</p>
                          </details>
                        )}
                      </td>
                      <td>
                        <time dateTime={source.lastScannedAt?.toISOString()}>
                          {formatDate(source.lastScannedAt)}
                        </time>
                      </td>
                      <td className={styles.counts}>
                        {source.run === null ? (
                          '—'
                        ) : (
                          <>
                            <strong>{source.run.newCount}</strong> new · {source.run.found} found
                          </>
                        )}
                      </td>
                      <td>
                        {source.feedUrl === null
                          ? 'Sitemap only'
                          : source.hasFeedCheckpoint
                            ? 'Present'
                            : 'None'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="history-heading">
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.sectionIndex}>03 / recent activity</p>
              <h2 id="history-heading">Scan history</h2>
            </div>
            <p>The 24 most recent source runs, newest first.</p>
          </div>
          {snapshot.recentScans.length === 0 ? (
            <p className={styles.emptyState}>No scan runs yet. Queue the first scan above.</p>
          ) : (
            <div className={styles.tableScroll}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Started</th>
                    <th scope="col">Source</th>
                    <th scope="col">Status</th>
                    <th scope="col">Duration</th>
                    <th scope="col">Found / new</th>
                    <th scope="col">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.recentScans.map((run) => (
                    <tr key={run.id}>
                      <td>
                        <time dateTime={run.startedAt.toISOString()}>{formatDate(run.startedAt)}</time>
                      </td>
                      <th scope="row">{run.sourceName}</th>
                      <td>
                        <span
                          className={`${styles.status} ${
                            run.status === 'success'
                              ? styles.statusGood
                              : run.status === 'running'
                                ? styles.statusActive
                                : styles.statusWarn
                          }`}
                        >
                          <span aria-hidden="true" />
                          {run.status}
                        </span>
                      </td>
                      <td>{duration(run.startedAt, run.finishedAt)}</td>
                      <td className={styles.counts}>
                        {run.found} / <strong>{run.newCount}</strong>
                      </td>
                      <td>{formatCost(run.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <footer className={styles.footer}>
          <span>Times shown in America/New_York</span>
          <a href="/ops">Refresh data</a>
        </footer>
      </div>
    </main>
  );
}
