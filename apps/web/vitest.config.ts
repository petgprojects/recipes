import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The grocery suite runs the whole aggregation twice — once in SQL, once in
    // memory — over every recipe in the database.
    testTimeout: 30_000,
  },
});
