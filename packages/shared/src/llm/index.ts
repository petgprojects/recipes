/**
 * OpenRouter transport for `@recipes/shared`.
 *
 * **Server-only, exactly like `./env`** — and for a second reason on top of
 * that one. This subpath pulls in the `openai` SDK, which has no business in a
 * browser bundle and would carry the shape of every provider request into it.
 * It is therefore deliberately absent from the package barrel (`./src/index.ts`)
 * and reachable only as `@recipes/shared/llm`, so an accidental client import
 * has to be written on purpose rather than inherited from `@recipes/shared`.
 *
 * Nothing here reads `process.env` or opens a connection at import time: the
 * caller supplies the key and the model, which is what lets the worker and the
 * web app configure the same transport differently.
 */

export * from './openrouter';
export * from './usage';
