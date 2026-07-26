# Build Progress

Durable checkpoint log for the build described in [`PLAN.md`](./PLAN.md).
Each phase lands as its own commit (or several). This file records **what is
done**, **what was decided that differs from PLAN.md**, and **what is blocked
on Peter**.

---

## Setup still needed from Peter

| Item | Needed by | Status |
|---|---|---|
| `OPENROUTER_API_KEY` | Phase 2 | ⬜ not yet provided |
| Reddit API credentials | Phase 2 (Reddit source only) | ⛔ blocked — see below |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Phase 4 | ⬜ account exists, app not yet created |

**Reddit blocker.** App creation at reddit.com/prefs/apps fails with the
"Responsible Builder Policy" message; browser console shows a 401 from
`google.com/recaptcha/api2/pat`. Diagnosis: reCAPTCHA cannot complete, so the
form fails closed. Fixes to try, in order: disable ad/privacy extensions for
reddit.com *and* google.com; allow third-party cookies for reddit.com; disable
VPN; verify the account's email address.

Reddit is **not** a blocker for the build. The Reddit adapter ships in Phase 2
with its `sources` row `enabled = false`; flipping one boolean turns it on once
credentials exist.

---

## Amendments to PLAN.md

Decisions made during implementation that differ from the plan as written.
PLAN.md is left intact as the original design document; this section is the
authoritative delta.

### A1 — LLM access goes through OpenRouter, not DeepSeek direct
*Phase 2. Reason: Peter has an OpenRouter key, not a DeepSeek one.*

- Base URL `https://openrouter.ai/api/v1`, env var `OPENROUTER_API_KEY`
  (replaces `DEEPSEEK_API_KEY` throughout, including `.env.example`).
- Model id is `deepseek/deepseek-v4-flash`, not `deepseek-v4-flash`.
- Still the `openai` npm client with `baseURL` swapped, exactly as §2 describes.
  Nothing else in the architecture changes.

Verified live against OpenRouter's `/api/v1/models` on 2026-07-26:

| | PLAN.md assumed | OpenRouter actual |
|---|---|---|
| Context | 1M | 1,048,576 ✅ |
| Max output | 384K | 393,216 ✅ |
| Input | $0.14/M | $0.14/M ✅ |
| Output | $0.28/M | $0.28/M ✅ |
| Cached input | $0.0028/M | **$0.028/M** (80% off, not 98%) |

The cache discount is an order of magnitude weaker than the plan assumed. Cost
impact is negligible at this scale (~$3/mo → ~$3.50/mo) and the prompt
structuring advice in §2 still applies — it is simply worth less.

### A2 — Strict JSON Schema replaces the repair-retry as the primary mechanism
*Phase 2. Reason: OpenRouter exposes a capability DeepSeek's own API does not.*

PLAN.md §2 states DeepSeek supports only `response_format: {type: "json_object"}`
and therefore requires client-side Zod validation plus a repair retry. Via
OpenRouter, `deepseek/deepseek-v4-flash` reports `structured_outputs` in its
`supported_parameters`, so `response_format: {type: "json_schema", strict: true}`
is enforced server-side.

Consequence: Zod validation stays (it is the TypeScript type boundary and
guards against provider fallback), but the repair retry becomes a rarely-hit
safety net rather than the expected path. §2's "Alternative worth prototyping"
— the `emit_recipe` tool-calling hack — is **not needed** and will not be built.

### A3 — Source list resolved (PLAN.md §8, open question 11)
Budget Bytes, Pinch of Yum, Downshiftology, GypsyPlate, Classpop, Skinnytaste,
The Kitchn, Love & Lemons, Serious Eats.

### A4 — Unset and empty env vars are treated identically
*Phase 0. Found while bringing up compose from a clean state.*

`.env.example` deliberately ships Phase 2/4 secrets blank (`OPENROUTER_API_KEY=`),
and PLAN.md §3 expects a `.env` copied from it to boot. The original Zod helper
was `.string().trim().min(1).optional()`, but `.optional()` only rescues
`undefined` — `min(1)` rejects `""` before optionality is considered, so a stock
`.env` made every service refuse to boot. The emptiness check now happens inside
the `.transform()`. `FOO=` and an absent `FOO` are now the same thing: not
configured.

### A5 — Compose migrates in a dedicated one-shot service
*Phase 0.* `web` and `worker` both wait on a `migrate` service with
`condition: service_completed_successfully`, rather than either app migrating at
startup. Two services racing to migrate the same database is a real bug; this
removes it structurally.

---

## Phase checklist

- [x] **Phase 0 — Scaffold.** ✅ Monorepo, docker-compose, Drizzle schema +
      migration, vocabularies, Zod env module, 117 seeded canonical
      ingredients, `dev@local` user, `/api/health`, `/api/recipes`.
      *Exit verified: `docker compose up` from clean → 5 extensions, 15 tables,
      117 ingredients + 117 self-aliases, health 200, `/api/recipes` → `[]`.*
- [ ] **Phase 1 — Deterministic ingestion.** Polite fetcher, RSS/sitemap
      discovery, JSON-LD extraction, ingredient normalization, image pipeline,
      pg-boss, `scan_runs`, `/ops`.
      *Exit: hundreds of real recipes with photos, zero LLM involvement.*
- [ ] **Phase 2 — LLM enrichment.** OpenRouter client, suitability gate,
      derived fields, HTML + Reddit extraction, blurbs, budget cap, backfill.
      *Exit: recipes complete, junk filtered.*
- [ ] **Phase 3 — UI port.** Components, images, TanStack Query auto-refresh,
      "N new recipes" pill. Retire `meal-prep-planner.jsx`.
- [ ] **Phase 4 — Auth.** Auth.js + Google, localStorage migration on first sign-in.
- [ ] **Phase 5 — Grocery list server-side.** SQL aggregation, per-user checks,
      print + copy-to-clipboard.
- [ ] **Phase 6 — Ratings.** 1–5 stars, notes, fixed-vocabulary aspect tags.
- [ ] **Phase 7 — Personalization.** SQL-derived hard rules, LLM soft profile,
      batched scoring with visible reasons, cold-start guards.

---

## Log

### 2026-07-26 — Baseline
Repo had no commits. Committed `PLAN.md`, `reqs.md`, `meal-prep-planner.jsx`
as-is plus this file and a `.gitignore`. Verified toolchain: Node 24.13,
Docker 29.2, Compose v5.0.2. pnpm absent from PATH — **use `corepack pnpm`**
for every command (`corepack enable pnpm` needs sudo; not required).

### 2026-07-26 — Phase 0 complete
Extracted the artifact's lasting value before touching it: 117 canonical
`{name, aisle, defaultUnit}` ingredients, the real vocabularies (9 aisles in
store-walk order, 6 categories, 27 tags), the 24 recipes as UI fixtures, and
272 lines of CSS byte-identical for the Phase 3 port. `meal-prep-planner.jsx`
stays until Phase 3 retires it.

Built `packages/shared` (vocab, units, Zod env, schemas) and `packages/db`
(full §4 schema, extensions migration ordered first, idempotent seed), then
`apps/web`, `apps/worker` and the compose stack.

Verified independently, not just reported: typecheck clean across all projects,
38/38 tests pass, and `docker compose down -v` → `up --build` yields
`{"reachable":true,"migrated":true,"seeded":true,"ingredients":117}` with
`/api/recipes` → `[]`, which is the correct Phase 0 answer.

**Gotcha for later:** the compose bind mounts are shadowed by anonymous
`node_modules` volumes, so after any `package.json` change run
`docker compose down -v && docker compose up --build`.
