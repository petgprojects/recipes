/**
 * Phase 7, the personalization loop (PLAN.md §5).
 *
 * Client-safe contract and pure decision logic only — the same split as
 * `@recipes/shared/planner` and `@recipes/shared/ratings`. This module owns
 * what a hard rule *is* and when one is allowed to exist; the worker owns the
 * SQL that gathers the evidence and the nightly job that applies it, and the
 * web app owns turning a rule into a `WHERE` clause. The UI imports the types
 * and `describeHardRule()` from here, so nothing in this file may touch the
 * database or `process.env`.
 *
 * The plan's framing is worth restating because it constrains everything
 * below: "Start with derived rules, not embeddings. With 20 ratings a vector
 * model has nothing to work with; explicit rules extracted from those same 20
 * ratings work immediately and — critically — you can read them and tell
 * whether they're right." A rule that cannot be rendered as one sentence in
 * the UI has no business being emitted.
 */

import { z } from 'zod';

// ── Thresholds ──────────────────────────────────────────────────────────────

/**
 * Scoring does not run at all below this many rated recipes (PLAN.md §5:
 * "scoring only runs once a user has ≥5 rated recipes; below that
 * `recipe_scores` stays empty and browse sorts by `published_at DESC` with
 * source rating as a tiebreak").
 */
export const MIN_RATED_RECIPES_FOR_SCORING = 5;

/**
 * A rule needs this many observations *in its own bucket*, not this many
 * ratings overall. PLAN.md is explicit about why: "so one bad experience with
 * a slow recipe can't silently hide every recipe over an hour."
 */
export const MIN_OBSERVATIONS_PER_RULE = 5;

/**
 * A bucket has to be genuinely disliked, not merely below average. The scale
 * is 1–5, so 2.5 is the bottom half; a median at or under it means at least
 * half the cooks in that bucket were rated 2 or worse.
 *
 * Median rather than mean, per PLAN.md, and it matters: one furious 1★ among
 * nine 4★ moves a mean enough to trip a threshold and does not move a median
 * at all. The whole point of a hard rule is that it hides things, so it should
 * take a sustained pattern to earn one.
 */
export const DISLIKE_MEDIAN_AT_OR_BELOW = 2.5;

/**
 * The only cook-time cut-offs a rule may use.
 *
 * A fixed ladder rather than a fitted number because these are shown to a
 * person and switched on and off by them: "don't show recipes over 1 hour" is
 * a sentence someone can agree or disagree with, and `max_minutes: 73` is not.
 * reqs.md asks for exactly the round-number version.
 */
export const TIME_RULE_THRESHOLDS = [30, 60, 90] as const;

// ── Shape ───────────────────────────────────────────────────────────────────

export const HARD_RULE_KINDS = ['max_minutes', 'exclude_category', 'exclude_tag'] as const;
export type HardRuleKind = (typeof HARD_RULE_KINDS)[number];

/**
 * Why these three and not the cost/cleanup rules PLAN.md §5 also lists — see
 * amendment A20. An aspect (`expensive`, `too_much_cleanup`) is a property of
 * *a cook*, recorded on `cook_logs`, and there is no corresponding column on
 * `recipes`. There is therefore nothing to put in a `WHERE` clause: the
 * database cannot answer "is this recipe expensive?" about a recipe nobody has
 * cooked yet. Those aspects are real signal and they are not discarded — they
 * go to the soft profile in step 2, which is the part of the loop allowed to
 * reason rather than filter.
 */
export interface HardRule {
  /**
   * Stable across nightly re-derivations, and the identity the UI's on/off
   * switch is keyed by. `max_minutes:60`, `exclude_category:Soup`.
   */
  id: string;
  kind: HardRuleKind;
  /** Minutes for `max_minutes`; the category or tag name otherwise. */
  value: string;
  /** False once the reader has switched this rule off. Never re-derived true. */
  enabled: boolean;
  /** Cook logs in this rule's bucket — the `n` behind the median. */
  observations: number;
  /** Median rating in the bucket, rounded to one decimal for display. */
  medianRating: number;
}

const hardRuleSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(HARD_RULE_KINDS),
  value: z.string().min(1),
  enabled: z.boolean(),
  observations: z.number().int().min(0),
  medianRating: z.number().min(0).max(5),
});

/**
 * Parsed rather than cast on the way out of `user_preferences.hard_rules`.
 * It is a `jsonb` column: last night's job, an older deploy's shape, or a hand
 * edit in psql can all put something in it that no longer typechecks, and the
 * failure mode of trusting it is a browse feed silently filtered by garbage.
 * Unknown or malformed entries are dropped, not thrown on — a bad rule should
 * cost its own filter, not the whole page.
 */
export const hardRulesSchema = z
  .array(z.unknown())
  .transform((rules) =>
    rules.flatMap((rule) => {
      const parsed = hardRuleSchema.safeParse(rule);
      return parsed.success ? [parsed.data] : [];
    }),
  )
  .default([]);

export function parseHardRules(value: unknown): HardRule[] {
  if (value === null || value === undefined) return [];
  const parsed = hardRulesSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

/** Only enabled rules filter anything. The rest stay visible but inert. */
export function activeHardRules(rules: HardRule[]): HardRule[] {
  return rules.filter((rule) => rule.enabled);
}

// ── Evidence ────────────────────────────────────────────────────────────────

/** One bucket's worth of gathered evidence, as the worker's SQL returns it. */
export interface RuleObservation {
  kind: HardRuleKind;
  value: string;
  /** Every rating in the bucket. Median is computed here, not in SQL. */
  ratings: number[];
}

/**
 * The median, on the convention that an even-sized sample averages the middle
 * two. Exported because the threshold constant above is meaningless without
 * agreeing on how the number it is compared against was produced.
 */
export function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function isDisliked(ratings: number[]): boolean {
  return (
    ratings.length >= MIN_OBSERVATIONS_PER_RULE &&
    median(ratings) <= DISLIKE_MEDIAN_AT_OR_BELOW
  );
}

// ── Derivation ──────────────────────────────────────────────────────────────

/**
 * Which cook-time rule, if any, the evidence supports.
 *
 * The ladder is evaluated as nested buckets — the 30 bucket contains every
 * cook over 30 minutes, including the ones over 90 — and when more than one
 * threshold trips we emit the **largest**, which is the loosest filter that
 * still matches the evidence.
 *
 * That direction is deliberate and it is the same instinct as amendment A18's
 * ingredient guard. Both errors are silent, but they are not equal: too loose
 * a filter shows a recipe someone scrolls past, while too tight a filter hides
 * food they would have liked and gives them no way to notice. Nesting is also
 * exactly why the tight end is untrustworthy — a reader who loves 40-minute
 * dinners and loathes 3-hour braises drags the ">30" median down with the
 * braises alone, and emitting `max_minutes: 30` off that would hide the very
 * recipes they rated 5★.
 */
export function deriveTimeRule(observations: RuleObservation[]): HardRule | null {
  const candidates = TIME_RULE_THRESHOLDS.map((threshold) => {
    const found = observations.find(
      (o) => o.kind === 'max_minutes' && o.value === String(threshold),
    );
    return { threshold, ratings: found?.ratings ?? [] };
  }).filter((candidate) => isDisliked(candidate.ratings));

  const loosest = candidates.at(-1);
  if (loosest === undefined) return null;

  return {
    id: `max_minutes:${loosest.threshold}`,
    kind: 'max_minutes',
    value: String(loosest.threshold),
    enabled: true,
    observations: loosest.ratings.length,
    medianRating: round1(median(loosest.ratings)),
  };
}

/**
 * Category and tag exclusions. Unlike the time ladder these buckets are
 * disjoint, so every one that clears the bar is emitted on its own evidence.
 */
export function deriveExclusionRules(observations: RuleObservation[]): HardRule[] {
  return observations
    .filter((o) => o.kind !== 'max_minutes' && isDisliked(o.ratings))
    .map((o) => ({
      id: `${o.kind}:${o.value}`,
      kind: o.kind,
      value: o.value,
      enabled: true,
      observations: o.ratings.length,
      medianRating: round1(median(o.ratings)),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Last night's rules merged with tonight's evidence.
 *
 * The one rule that matters here: **a rule the reader switched off stays off.**
 * The derivation is not wrong about the evidence — the reader is simply
 * overriding it, and a nightly job that quietly re-enables an override is a
 * setting that does not work. So a rule whose id the reader has disabled keeps
 * `enabled: false` while its evidence is refreshed, and disabled rules whose
 * evidence has since evaporated are kept too: dropping one would silently
 * re-arm it the moment the pattern reappeared.
 */
export function mergeHardRules(previous: HardRule[], derived: HardRule[]): HardRule[] {
  const disabled = new Set(previous.filter((rule) => !rule.enabled).map((rule) => rule.id));
  const derivedIds = new Set(derived.map((rule) => rule.id));

  const refreshed = derived.map((rule) => ({ ...rule, enabled: !disabled.has(rule.id) }));

  const retained = previous.filter((rule) => !rule.enabled && !derivedIds.has(rule.id));

  return [...refreshed, ...retained].sort((a, b) => a.id.localeCompare(b.id));
}

// ── Display ─────────────────────────────────────────────────────────────────

/**
 * The sentence shown next to the rule's switch. PLAN.md §5: "Show the active
 * rules in the UI with a switch to disable each one — a filter you can't see
 * is indistinguishable from a bug."
 */
export function describeHardRule(rule: HardRule): string {
  switch (rule.kind) {
    case 'max_minutes':
      return `Hide recipes that take more than ${rule.value} minutes`;
    case 'exclude_category':
      return `Hide ${rule.value} recipes`;
    case 'exclude_tag':
      return `Hide recipes tagged “${rule.value}”`;
  }
}

/** The evidence line under it — why the app believes this. */
export function explainHardRule(rule: HardRule): string {
  const cooks = rule.observations === 1 ? '1 cook' : `${rule.observations} cooks`;
  return `You rated ${cooks} in this group ${rule.medianRating}★ on average`;
}

