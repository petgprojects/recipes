// The transport itself now lives in `@recipes/shared/llm` (FILTER_PLAN.md §2.2)
// so the web app can call it without depending on the worker. Re-exported here
// because the worker's own modules address the whole LLM surface — transport and
// task prompts alike — through this barrel.
export * from '@recipes/shared/llm';
export * from './recipe-context';
export * from './suitability';
export * from './derive-fields';
export * from './blurb';
export * from './extract-recipe';
export * from './extract-recipe-from-post';
export * from './map-ingredients';
export * from './taste-profile';
export * from './score-recipes';
// `parse-search-query` is deliberately absent: it moved to `@recipes/shared/llm`
// so the web search route could call it (amendment A35), and the first line of
// this file already re-exports that subpath whole. Everything addressing it
// through this barrel — the fixtures, the suite, the check script — is
// unaffected.
