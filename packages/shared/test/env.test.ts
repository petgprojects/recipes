import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_DATABASE_URL = 'postgresql://recipes:recipes@localhost:5432/recipes';

async function loadEnv(searchDailyBudgetUsd?: string) {
  vi.stubEnv('DATABASE_URL', TEST_DATABASE_URL);
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('SEARCH_DAILY_BUDGET_USD', searchDailyBudgetUsd);
  return import('../src/env');
}

describe('SEARCH_DAILY_BUDGET_USD', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to a separate $0.10 daily search budget', async () => {
    const { env } = await loadEnv();

    expect(env.SEARCH_DAILY_BUDGET_USD).toBe(0.1);
    expect(env.LLM_DAILY_BUDGET_USD).toBe(1);
  });

  it('accepts a positive override', async () => {
    const { env } = await loadEnv('0.25');

    expect(env.SEARCH_DAILY_BUDGET_USD).toBe(0.25);
  });

  it.each(['0', '-0.01'])('rejects the non-positive value %s', async (value) => {
    await expect(loadEnv(value)).rejects.toThrow(/SEARCH_DAILY_BUDGET_USD/);
  });
});
