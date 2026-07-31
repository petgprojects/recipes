/**
 * Zod-validated environment. PLAN.md §3: "The app fails fast at boot on a
 * missing required var ... rather than throwing at 3am mid-scan."
 *
 * Validation runs at *import* time, so importing this module is the boot check.
 * It is deliberately NOT re-exported from `src/index.ts` — import it from
 * `@recipes/shared/env` in server code only, so that pulling a vocabulary into
 * a client component can never drag secrets into the browser bundle or blow up
 * a build that has no `DATABASE_URL`.
 *
 * Phase gating: only `DATABASE_URL` is required today. Phase 2 (OpenRouter,
 * Reddit) and Phase 4 (Google OAuth, Auth.js) have not shipped, so their vars
 * are optional here and enforced at point of use via `requireEnv()`. That way a
 * missing `OPENROUTER_API_KEY` fails the LLM call with a clear message instead
 * of preventing the app from booting at all.
 *
 * PROGRESS.md amendment A1: the LLM provider is OpenRouter, so the key is
 * `OPENROUTER_API_KEY`. There is no `DEEPSEEK_API_KEY` anywhere in this repo.
 */

import { z } from 'zod';

// Treat an unset var and an empty/whitespace var identically; a `.env` with
// `OPENROUTER_API_KEY=` is a var that is not configured, not a var set to "".
//
// The trim/emptiness check has to happen inside the transform rather than as a
// `.trim().min(1)` prefix: `.optional()` only rescues `undefined`, so a leading
// `.min(1)` fails on the empty string before optionality is ever considered —
// which made `docker compose up` refuse to boot on a stock `.env` copied from
// `.env.example`, where every Phase 2/4 secret is deliberately blank.
const nonEmpty = z
  .string()
  .optional()
  .transform((v) => {
    const trimmed = v?.trim();
    return trimmed === undefined || trimmed === '' ? undefined : trimmed;
  });

const booleanString = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((value) => value === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // ── Required from Phase 0 ────────────────────────────────────────────────
  DATABASE_URL: z
    .string({ error: 'DATABASE_URL is required (e.g. postgresql://recipes:recipes@localhost:5432/recipes)' })
    .min(1, 'DATABASE_URL is required')
    .refine(
      (v) => /^postgres(ql)?:\/\//.test(v),
      'DATABASE_URL must be a postgres:// or postgresql:// connection string',
    ),

  // ── Phase 2 — LLM enrichment (OpenRouter) ────────────────────────────────
  OPENROUTER_API_KEY: nonEmpty,
  OPENROUTER_BASE_URL: z.url().default('https://openrouter.ai/api/v1'),
  OPENROUTER_MODEL: z.string().min(1).default('deepseek/deepseek-v4-flash'),
  LLM_DAILY_BUDGET_USD: z.coerce.number().positive().default(1.0),

  // ── Phase 1 — deterministic scan worker ─────────────────────────────────
  RECIPE_IMAGES_DIR: z.string().trim().min(1).default('./data/images'),
  SCAN_CRON_SCHEDULE: z.string().trim().min(1).default('0 3 * * *'),
  SCAN_CRON_TIMEZONE: z.string().trim().min(1).default('America/New_York'),
  SCAN_DISCOVERY_LIMIT: z.coerce.number().int().positive().max(1_000).default(200),
  /**
   * A fresh database gets one scan immediately instead of waiting until 3am.
   * Disable this for startup smoke tests or deliberately cron-only deployments.
   */
  SCAN_BOOTSTRAP_ENABLED: booleanString('true'),

  // ── Phase 2 — Reddit ─────────────────────────────────────────────────────
  REDDIT_CLIENT_ID: nonEmpty,
  REDDIT_CLIENT_SECRET: nonEmpty,
  REDDIT_USER_AGENT: nonEmpty,

  // ── Phase 4 — Auth.js + Google ───────────────────────────────────────────
  GOOGLE_CLIENT_ID: nonEmpty,
  GOOGLE_CLIENT_SECRET: nonEmpty,
  AUTH_SECRET: nonEmpty,
  /**
   * Treat an unauthenticated development request as the seeded `dev@local`
   * user (PLAN.md §4). **Off by default** — see PROGRESS.md amendment A15.
   * Phase 4 has to be able to exercise the signed-out planner and the
   * first-sign-in migration, and an automatic fallback makes both unreachable
   * in the only environment that exists. Ignored when `NODE_ENV=production`.
   */
  DEV_AUTH_FALLBACK: booleanString('false'),

  /**
   * Auth.js's public origin. Read by Auth.js straight from `process.env`; it is
   * declared here so a bad value fails at boot with the rest of them.
   *
   * Must be set whenever the server is bound to `0.0.0.0` (every container),
   * because Auth.js would otherwise infer `http://0.0.0.0:3000` from
   * `request.url` and send that as the OAuth `redirect_uri` — which Google
   * rejects as a policy violation. docker-compose.yml derives it from
   * `NEXT_PUBLIC_APP_URL` for you.
   *
   * Deployed behind a proxy or a Cloudflare Tunnel this is the *public* origin,
   * not the container's — the last hop is plain HTTP but the browser and Google
   * both see `https://…`, and pinning it here is what keeps the `redirect_uri`
   * in the token exchange identical to the one registered with Google. An
   * `https` value also switches Auth.js to `__Secure-`-prefixed cookies, so the
   * public origin must genuinely be HTTPS (amendment A22).
   */
  AUTH_URL: z.url().default('http://localhost:3000'),

  // ── Web ──────────────────────────────────────────────────────────────────
  NEXT_PUBLIC_APP_URL: z.url().default('http://localhost:3000'),
});

export type Env = z.infer<typeof envSchema>;

/** Keys that are optional today because their phase has not shipped. */
export type DeferredEnvKey =
  | 'OPENROUTER_API_KEY'
  | 'REDDIT_CLIENT_ID'
  | 'REDDIT_CLIENT_SECRET'
  | 'REDDIT_USER_AGENT'
  | 'GOOGLE_CLIENT_ID'
  | 'GOOGLE_CLIENT_SECRET'
  | 'AUTH_SECRET';

const DEFERRED_PHASE: Record<DeferredEnvKey, string> = {
  OPENROUTER_API_KEY: 'Phase 2 (LLM enrichment) — get one at https://openrouter.ai/keys',
  REDDIT_CLIENT_ID: 'Phase 2 (Reddit source) — create an app at https://reddit.com/prefs/apps',
  REDDIT_CLIENT_SECRET: 'Phase 2 (Reddit source) — create an app at https://reddit.com/prefs/apps',
  REDDIT_USER_AGENT:
    'Phase 2 (Reddit source) — e.g. "recipes/0.1 by u/<you> (+https://example.com)"',
  GOOGLE_CLIENT_ID: 'Phase 4 (auth) — Google Cloud console, OAuth 2.0 client',
  GOOGLE_CLIENT_SECRET: 'Phase 4 (auth) — Google Cloud console, OAuth 2.0 client',
  AUTH_SECRET: 'Phase 4 (auth) — generate with `openssl rand -base64 32`',
};

function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;

  const details = result.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');

  throw new Error(
    `Invalid environment configuration:\n${details}\n\n` +
      `Copy .env.example to .env and fill in the missing values.`,
  );
}

/** Validated environment. Reading this module at all performs the boot check. */
export const env: Env = parseEnv(process.env);

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';

/**
 * Read a phase-gated variable, throwing a message that says which phase needs
 * it and how to get it. Use this at the point of use — never at module scope,
 * or it becomes a boot requirement again.
 *
 *   const key = requireEnv('OPENROUTER_API_KEY');
 */
export function requireEnv(key: DeferredEnvKey): string {
  const value = env[key];
  if (value === undefined) {
    throw new Error(
      `Missing required environment variable ${key}.\n` +
        `Needed by: ${DEFERRED_PHASE[key]}\n` +
        `Add it to your .env (see .env.example) and restart.`,
    );
  }
  return value;
}

/** Non-throwing probe, for "is this integration configured?" branches. */
export function hasEnv(key: DeferredEnvKey): boolean {
  return env[key] !== undefined;
}
