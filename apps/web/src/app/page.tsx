/** Placeholder root page. Phase 3 owns the recipe-planning UI. */

const wrap: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  lineHeight: 1.6,
  maxWidth: '46rem',
  margin: '4rem auto',
  padding: '0 1.5rem',
};

export default function Home() {
  return (
    <main style={wrap}>
      <h1>Recipe Planner</h1>
      <p>
        Deterministic ingestion is operational. Every recipe in the database arrives from an
        approved source crawl; the planning interface follows in Phase 3.
      </p>
      <ul>
        <li>
          <a href="/ops">Operations</a> — source checkpoints, scan telemetry, and the manual scan
          queue.
        </li>
        <li>
          <a href="/api/health">GET /api/health</a> — app status plus a real database round-trip.
        </li>
        <li>
          <a href="/api/recipes">GET /api/recipes</a> — browse newly ingested recipes. Supports{' '}
          <code>?since=&lt;iso&gt;</code> and <code>?limit=</code>.
        </li>
      </ul>
      <p>Pipeline: RSS/sitemap → JSON-LD → normalized ingredients → Postgres.</p>
    </main>
  );
}
