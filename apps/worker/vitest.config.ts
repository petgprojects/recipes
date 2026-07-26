import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The fixture suite parses ~25 pages of real HTML; the default 5s timeout
    // is tight on a cold cheerio parse.
    testTimeout: 30_000,
  },
});
