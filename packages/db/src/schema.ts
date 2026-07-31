/**
 * The data model from PLAN.md §4, in full.
 *
 * Two rules shape this file:
 *
 * 1. **Vocabularies are derived, never retyped.** Every `pgEnum` below is built
 *    from a constant in `@recipes/shared/vocab`. PLAN.md §4: "a TS constant
 *    with a Drizzle pgEnum derived from it keeps them in lockstep, and a
 *    vocabulary change becomes a reviewable diff plus a migration." The two
 *    array columns (`recipes.tags`, `cook_logs.aspects`) cannot be enums, so
 *    they carry CHECK constraints generated from the same constants.
 *
 * 2. **Multi-user from day one.** PLAN.md §8: "build it properly, `user_id` on
 *    every table from Phase 0; `dev@local` stands in until Phase 4." Nothing
 *    here is single-user-shaped, even though auth does not exist yet.
 *
 * Columns are named explicitly rather than relying on `casing: 'snake_case'`,
 * so the SQL name of a column is visible at the point it is declared and can
 * never drift with a config change.
 */

import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  AISLES,
  CATEGORIES,
  DEFAULT_SCAN_RUN_KIND,
  FALLBACK_AISLE,
  RATING_ASPECTS,
  RECIPE_STATUS,
  SCAN_RUN_KIND,
  SCAN_RUN_STATUS,
  SOURCE_KIND,
  TAGS,
  type InstructionStep,
  type ScanRunKind,
} from '@recipes/shared';

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * `citext`, created by `0000_extensions.sql`. Drizzle has no built-in for it.
 * PLAN.md §4 specifies it for `users.email` so that `A@b.com` and `a@b.com`
 * cannot become two accounts.
 */
const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'citext';
  },
});

/** Every timestamp in this schema is `timestamptz`. */
const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** A SQL `text[]` literal, for CHECK constraints built from a TS constant. */
function textArrayLiteral(values: readonly string[]): string {
  return `ARRAY[${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ')}]::text[]`;
}

// ── Enums, derived from the shared vocabularies ─────────────────────────────

export const aisleEnum = pgEnum('aisle', AISLES);
export const categoryEnum = pgEnum('recipe_category', CATEGORIES);
export const recipeStatusEnum = pgEnum('recipe_status', RECIPE_STATUS);
export const sourceKindEnum = pgEnum('source_kind', SOURCE_KIND);
export const scanRunStatusEnum = pgEnum('scan_run_status', SCAN_RUN_STATUS);

// ── Sources & provenance ────────────────────────────────────────────────────

export const sources = pgTable(
  'sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    kind: sourceKindEnum('kind').notNull(),
    baseUrl: text('base_url').notNull(),
    /** Primary RSS/Atom entry point. Null for sitemap-only sources. */
    feedUrl: text('feed_url'),
    /** Conditional-GET validators for the source's feed. */
    feedEtag: text('feed_etag'),
    feedLastModified: text('feed_last_modified'),
    enabled: boolean('enabled').notNull().default(true),
    /** Politeness delay between requests (PLAN.md §7). */
    crawlDelayS: integer('crawl_delay_s').notNull().default(2),
    robotsCheckedAt: tstz('robots_checked_at'),
    lastScannedAt: tstz('last_scanned_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('sources_base_url_key').on(t.baseUrl), index('sources_enabled_idx').on(t.enabled)],
);

// ── Recipes ─────────────────────────────────────────────────────────────────

export const recipes = pgTable(
  'recipes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * `restrict`, not `cascade`: deleting a source should not silently take
     * hundreds of already-ingested (and possibly saved, rated) recipes with it.
     * Disabling a source is `sources.enabled = false`.
     */
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'restrict', onUpdate: 'cascade' }),

    /** The dedupe key (PLAN.md §4). Always a real URL — there is no seed data. */
    sourceUrl: text('source_url').notNull(),
    /** Detects upstream edits, so a daily re-scan is idempotent. */
    contentHash: text('content_hash'),
    /** Conditional-GET validators for the canonical recipe page. */
    pageEtag: text('page_etag'),
    pageLastModified: text('page_last_modified'),

    title: text('title').notNull(),
    slug: text('slug').notNull(),
    /** OUR text, LLM-written in Phase 2. Never the source's prose (§7). */
    blurb: text('blurb'),

    totalMinutes: integer('total_minutes'),
    activeMinutes: integer('active_minutes'),
    servings: integer('servings'),

    /** Shelf life. Schema.org has no equivalent; Phase 2 infers both (§1). */
    keepsDays: integer('keeps_days'),
    freezerMonths: integer('freezer_months'),

    /** Null until the Phase 2 derive step runs — Phase 1 inserts without it. */
    category: categoryEnum('category'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),

    imageUrl: text('image_url'),
    imageLocalPath: text('image_local_path'),
    imageW: integer('image_w'),
    imageH: integer('image_h'),
    imageBlurhash: text('image_blurhash'),

    author: text('author'),
    sourceRating: real('source_rating'),
    sourceRatingCount: integer('source_rating_count'),

    /** Ordered steps. */
    instructions: jsonb('instructions').$type<InstructionStep[]>().notNull().default(sql`'[]'::jsonb`),
    /** Kept so fields can be re-derived without re-crawling (§4). */
    rawJsonld: jsonb('raw_jsonld'),

    status: recipeStatusEnum('status').notNull().default('pending'),
    /**
     * Not in PLAN.md §4's column list, but §1 and §5 both require it: "store
     * rejects as `status='rejected'` rather than dropping them, so the filter's
     * mistakes stay auditable." A reason with nowhere to live is not auditable.
     */
    rejectionReason: text('rejection_reason'),

    publishedAt: tstz('published_at'),
    firstSeenAt: tstz('first_seen_at').notNull().defaultNow(),
    lastSeenAt: tstz('last_seen_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('recipes_source_url_key').on(t.sourceUrl),
    // The browse query: active recipes, newest first (PLAN.md §7 cold start).
    index('recipes_status_published_at_idx').on(t.status, t.publishedAt.desc()),
    index('recipes_source_id_idx').on(t.sourceId),
    index('recipes_slug_idx').on(t.slug),
    // `?since=<ts>` polling in Phase 3.
    index('recipes_last_seen_at_idx').on(t.lastSeenAt.desc()),
    // FILTER_PLAN.md §5's two search indexes. Different tools: FTS is word and
    // stem matching over our own prose, which is what finds "spicy" in a blurb;
    // trigram is fuzzy spelling, for a typo in the raw query. The FTS
    // expression is duplicated in `ftsDocument()` in apps/web/src/lib/search.ts
    // and the two must match character for character, or the compiled query
    // sequential-scans instead of using this index.
    index('recipes_search_fts_idx').using(
      'gin',
      sql`to_tsvector('english', ${t.title} || ' ' || coalesce(${t.blurb}, ''))`,
    ),
    index('recipes_title_trgm_idx').using('gin', sql`${t.title} gin_trgm_ops`),
    check('recipes_tags_vocab', sql.raw(`"tags" <@ ${textArrayLiteral(TAGS)}`)),
    check('recipes_source_rating_range', sql`${t.sourceRating} is null or (${t.sourceRating} >= 0 and ${t.sourceRating} <= 5)`),
    // A rejected row must explain the gate decision; pending/active rows must
    // not carry a stale reason from an earlier classification.
    check(
      'recipes_rejection_reason_status',
      sql`(${t.status} = 'rejected' and ${t.rejectionReason} is not null) or (${t.status} <> 'rejected' and ${t.rejectionReason} is null)`,
    ),
    // `active` is the public, fully enriched state. Shelf life may genuinely
    // be unknown and an empty tag list is valid, but every active card needs
    // our own blurb and one controlled category.
    check(
      'recipes_active_enrichment_complete',
      sql`${t.status} <> 'active' or (${t.blurb} is not null and ${t.category} is not null)`,
    ),
  ],
);

// ── Ingredient canonicalisation ─────────────────────────────────────────────

export const ingredients = pgTable(
  'ingredients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    aisle: aisleEnum('aisle').notNull().default(FALLBACK_AISLE),
    defaultUnit: text('default_unit'),
    /** Only populated where a mass↔volume conversion is worth the risk. */
    densityGPerMl: real('density_g_per_ml'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ingredients_name_key').on(t.name),
    index('ingredients_aisle_idx').on(t.aisle),
    // Stage 2 of the matcher: pg_trgm similarity above a threshold (§4).
    index('ingredients_name_trgm_idx').using('gin', sql`${t.name} gin_trgm_ops`),
  ],
);

export const ingredientAliases = pgTable(
  'ingredient_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ingredientId: uuid('ingredient_id')
      .notNull()
      .references(() => ingredients.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    alias: text('alias').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    // Stage 2, exact match — the hot path, hit once per ingredient line.
    uniqueIndex('ingredient_aliases_alias_key').on(t.alias),
    index('ingredient_aliases_ingredient_id_idx').on(t.ingredientId),
    index('ingredient_aliases_alias_trgm_idx').using('gin', sql`${t.alias} gin_trgm_ops`),
  ],
);

export const recipeIngredients = pgTable(
  'recipe_ingredients',
  {
    recipeId: uuid('recipe_id')
      .notNull()
      .references(() => recipes.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    position: integer('position').notNull(),
    rawText: text('raw_text').notNull(),
    /**
     * NULL on purpose (PLAN.md §4): "An unmapped ingredient still renders (we
     * have `raw_text`) and still shows on the grocery list under a fallback
     * aisle; it just doesn't merge with anything. Failure is degraded, not
     * broken." `set null` on delete for the same reason.
     */
    ingredientId: uuid('ingredient_id').references(() => ingredients.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    qty: numeric('qty', { precision: 12, scale: 4, mode: 'number' }),
    /** As written by the source; `normalizeUnit()` interprets it at read time. */
    unit: text('unit'),
    note: text('note'),
    optional: boolean('optional').notNull().default(false),
  },
  (t) => [
    primaryKey({ name: 'recipe_ingredients_pkey', columns: [t.recipeId, t.position] }),
    // The grocery-list aggregation joins from saved recipes to this column.
    index('recipe_ingredients_ingredient_id_idx').on(t.ingredientId),
  ],
);

// ── Users (Auth.js Drizzle adapter shape) ───────────────────────────────────
// These four tables match what `@auth/drizzle-adapter` expects, so Phase 4
// wires up the adapter without a migration.

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: citext('email').notNull(),
    name: text('name'),
    /**
     * PLAN.md §4 calls this `avatar_url`; the Auth.js adapter reads a property
     * called `image`. Keeping the plan's column name and the adapter's property
     * name means neither has to be worked around.
     */
    image: text('avatar_url'),
    /** Required by the Auth.js adapter; unused by the Google provider flow. */
    emailVerified: tstz('email_verified'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_key').on(t.email)],
);

export const accounts = pgTable(
  'accounts',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    type: text('type').$type<'oauth' | 'oidc' | 'email' | 'webauthn'>().notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (t) => [
    primaryKey({ name: 'accounts_pkey', columns: [t.provider, t.providerAccountId] }),
    index('accounts_user_id_idx').on(t.userId),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    sessionToken: text('session_token').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    expires: tstz('expires').notNull(),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
);

export const verificationTokens = pgTable(
  'verification_tokens',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: tstz('expires').notNull(),
  },
  (t) => [primaryKey({ name: 'verification_tokens_pkey', columns: [t.identifier, t.token] })],
);

// ── Per-user state ──────────────────────────────────────────────────────────

export const savedRecipes = pgTable(
  'saved_recipes',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    recipeId: uuid('recipe_id')
      .notNull()
      .references(() => recipes.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    /** The grocery-list multiplier: "I'm making two batches of this." */
    batches: integer('batches').notNull().default(1),
    savedAt: tstz('saved_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'saved_recipes_pkey', columns: [t.userId, t.recipeId] }),
    index('saved_recipes_recipe_id_idx').on(t.recipeId),
    check('saved_recipes_batches_positive', sql`${t.batches} > 0`),
  ],
);

export const groceryChecks = pgTable(
  'grocery_checks',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    /**
     * `{ingredient_id}:{unit_dimension}` — see `unitDimensionKey()` in
     * `@recipes/shared/units`. Unmapped ingredients fall back to
     * `raw:{slugified_raw_text}` (PLAN.md §4). Deliberately a free string and
     * not a foreign key: it has to survive an ingredient being merged away.
     */
    itemKey: text('item_key').notNull(),
    checkedAt: tstz('checked_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'grocery_checks_pkey', columns: [t.userId, t.itemKey] })],
);

export const cookLogs = pgTable(
  'cook_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    recipeId: uuid('recipe_id')
      .notNull()
      .references(() => recipes.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    rating: integer('rating').notNull(),
    /** Fixed vocabulary — this is what makes the Phase 7 rules tractable. */
    aspects: text('aspects').array().notNull().default(sql`'{}'::text[]`),
    notes: text('notes'),
    cookedAt: tstz('cooked_at').notNull().defaultNow(),
  },
  (t) => [
    index('cook_logs_user_id_cooked_at_idx').on(t.userId, t.cookedAt.desc()),
    index('cook_logs_recipe_id_idx').on(t.recipeId),
    check('cook_logs_rating_range', sql`${t.rating} between 1 and 5`),
    check('cook_logs_aspects_vocab', sql.raw(`"aspects" <@ ${textArrayLiteral(RATING_ASPECTS)}`)),
  ],
);

// ── Personalization & ops ───────────────────────────────────────────────────

export const userPreferences = pgTable('user_preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  /** Prose profile written by the LLM from rating history (PLAN.md §7 step 2). */
  profile: jsonb('profile'),
  /** Deterministic SQL-derived rules, e.g. `{"max_minutes": 60}` (§7 step 1). */
  hardRules: jsonb('hard_rules'),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const recipeScores = pgTable(
  'recipe_scores',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    recipeId: uuid('recipe_id')
      .notNull()
      .references(() => recipes.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    score: real('score').notNull(),
    /** Shown in the UI — "an opaque ranking is one you can't debug or trust". */
    reason: text('reason'),
    scoredAt: tstz('scored_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'recipe_scores_pkey', columns: [t.userId, t.recipeId] }),
    index('recipe_scores_user_id_score_idx').on(t.userId, t.score.desc()),
  ],
);

export const scanRuns = pgTable(
  'scan_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null for a run that spans every source rather than one. */
    sourceId: uuid('source_id').references(() => sources.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    /**
     * What this row accounts for (FILTER_PLAN.md §6). Text with a CHECK rather
     * than a pgEnum, exactly as `recipes.tags` is, and generated from the same
     * shared constant.
     *
     * It exists because `source_id is null` is already spoken for — it means "a
     * run spanning every source" — so it cannot double as the discriminator
     * between a nightly scan and the day's search accumulator. Without this
     * column the two budgets are one number.
     */
    kind: text('kind').notNull().default(DEFAULT_SCAN_RUN_KIND).$type<ScanRunKind>(),
    startedAt: tstz('started_at').notNull().defaultNow(),
    finishedAt: tstz('finished_at'),
    status: scanRunStatusEnum('status').notNull().default('running'),
    found: integer('found').notNull().default(0),
    /** Fetched pages with no schema.org Recipe node (zero-token rejection). */
    noRecipeCount: integer('no_recipe').notNull().default(0),
    /** Column is `new` per PLAN.md §4; the TS property avoids the keyword. */
    newCount: integer('new').notNull().default(0),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    /** Feeds the daily budget cap in `LLM_DAILY_BUDGET_USD`. */
    costUsd: numeric('cost_usd', { precision: 12, scale: 6, mode: 'number' })
      .notNull()
      .default(0),
    error: text('error'),
  },
  (t) => [
    index('scan_runs_started_at_idx').on(t.startedAt.desc()),
    index('scan_runs_source_id_idx').on(t.sourceId),
    check('scan_runs_kind_vocab', sql.raw(`"kind" = ANY (${textArrayLiteral(SCAN_RUN_KIND)})`)),
  ],
);

// ── Relations ───────────────────────────────────────────────────────────────

export const sourcesRelations = relations(sources, ({ many }) => ({
  recipes: many(recipes),
  scanRuns: many(scanRuns),
}));

export const recipesRelations = relations(recipes, ({ one, many }) => ({
  source: one(sources, { fields: [recipes.sourceId], references: [sources.id] }),
  ingredients: many(recipeIngredients),
  savedBy: many(savedRecipes),
  cookLogs: many(cookLogs),
  scores: many(recipeScores),
}));

export const ingredientsRelations = relations(ingredients, ({ many }) => ({
  aliases: many(ingredientAliases),
  recipeIngredients: many(recipeIngredients),
}));

export const ingredientAliasesRelations = relations(ingredientAliases, ({ one }) => ({
  ingredient: one(ingredients, {
    fields: [ingredientAliases.ingredientId],
    references: [ingredients.id],
  }),
}));

export const recipeIngredientsRelations = relations(recipeIngredients, ({ one }) => ({
  recipe: one(recipes, { fields: [recipeIngredients.recipeId], references: [recipes.id] }),
  ingredient: one(ingredients, {
    fields: [recipeIngredients.ingredientId],
    references: [ingredients.id],
  }),
}));

export const usersRelations = relations(users, ({ many, one }) => ({
  accounts: many(accounts),
  sessions: many(sessions),
  savedRecipes: many(savedRecipes),
  groceryChecks: many(groceryChecks),
  cookLogs: many(cookLogs),
  recipeScores: many(recipeScores),
  preferences: one(userPreferences, {
    fields: [users.id],
    references: [userPreferences.userId],
  }),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const savedRecipesRelations = relations(savedRecipes, ({ one }) => ({
  user: one(users, { fields: [savedRecipes.userId], references: [users.id] }),
  recipe: one(recipes, { fields: [savedRecipes.recipeId], references: [recipes.id] }),
}));

export const cookLogsRelations = relations(cookLogs, ({ one }) => ({
  user: one(users, { fields: [cookLogs.userId], references: [users.id] }),
  recipe: one(recipes, { fields: [cookLogs.recipeId], references: [recipes.id] }),
}));

export const recipeScoresRelations = relations(recipeScores, ({ one }) => ({
  user: one(users, { fields: [recipeScores.userId], references: [users.id] }),
  recipe: one(recipes, { fields: [recipeScores.recipeId], references: [recipes.id] }),
}));

export const scanRunsRelations = relations(scanRuns, ({ one }) => ({
  source: one(sources, { fields: [scanRuns.sourceId], references: [sources.id] }),
}));

// ── Inferred row types ──────────────────────────────────────────────────────

export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type RecipeRow = typeof recipes.$inferSelect;
export type NewRecipeRow = typeof recipes.$inferInsert;
export type Ingredient = typeof ingredients.$inferSelect;
export type NewIngredient = typeof ingredients.$inferInsert;
export type IngredientAlias = typeof ingredientAliases.$inferSelect;
export type NewIngredientAlias = typeof ingredientAliases.$inferInsert;
export type RecipeIngredientRow = typeof recipeIngredients.$inferSelect;
export type NewRecipeIngredientRow = typeof recipeIngredients.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type SavedRecipe = typeof savedRecipes.$inferSelect;
export type GroceryCheck = typeof groceryChecks.$inferSelect;
export type CookLog = typeof cookLogs.$inferSelect;
export type NewCookLog = typeof cookLogs.$inferInsert;
export type UserPreferences = typeof userPreferences.$inferSelect;
export type RecipeScore = typeof recipeScores.$inferSelect;
export type ScanRun = typeof scanRuns.$inferSelect;
export type NewScanRun = typeof scanRuns.$inferInsert;
