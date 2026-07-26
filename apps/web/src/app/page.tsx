/**
 * Placeholder root page. Phase 3 owns the UI; this exists so `/` is not a 404
 * while the interesting surface is the two API routes below.
 */

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
      <h1>Recipe Planner — Phase 0</h1>
      <p>
        Scaffold only. The database is migrated and seeded with the canonical ingredient list; no
        recipes exist yet because every recipe arrives from a crawl (PLAN.md §5, Phase 1).
      </p>
      <ul>
        <li>
          <a href="/api/health">GET /api/health</a> — app status plus a real database round-trip.
        </li>
        <li>
          <a href="/api/recipes">GET /api/recipes</a> — returns <code>[]</code>, and that is the
          correct Phase 0 result. Supports <code>?since=&lt;iso&gt;</code> and <code>?limit=</code>.
        </li>
      </ul>
      <p>Next up: Phase 1 — deterministic ingestion (RSS/sitemap → JSON-LD → Postgres).</p>
    </main>
  );
}
