import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

/**
 * `@recipes/db` and `@recipes/shared` have no build step — their `exports` point
 * straight at `.ts` sources (see their package.json). Next therefore has to
 * compile them itself, which is exactly what `transpilePackages` is for. Without
 * it the first `import { AISLES } from '@recipes/shared'` fails with a syntax
 * error on TypeScript that node never agreed to parse.
 */
const nextConfig: NextConfig = {
  transpilePackages: ['@recipes/db', '@recipes/shared'],

  /**
   * `postgres` (postgres.js) opens raw TCP sockets and is not something the
   * bundler should touch. Keeping it external also keeps the connection-pool
   * singleton in `@recipes/db/client` a genuine singleton per process.
   */
  serverExternalPackages: ['postgres'],

  /**
   * pnpm monorepo: the app's dependencies live in the workspace root, several
   * directories above `apps/web`. Without this, Next's file tracing infers the
   * wrong root and warns on every build.
   */
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),

  // Phase 1 downloads and downscales recipe images into the `recipe-images`
  // volume; Phase 3 renders them through next/image. Remote patterns get added
  // then — nothing hot-links today.
  images: {
    remotePatterns: [],
  },
};

export default nextConfig;
