# Production image. Multi-stage: one install/build stage, then a slim runtime.
# Used by compose.prod.yml. Not exercised by Phase 0 — the dev stack is the
# tested path, this is the shape production will take.
#
# `target: web-runtime` builds Next; `target: worker-runtime` runs the worker
# under tsx (the workspace packages ship raw .ts by design, so the worker has no
# build step of its own).

# ── deps ─────────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile

# ── source ───────────────────────────────────────────────────────────────────
FROM deps AS source
COPY . .

# ── web ──────────────────────────────────────────────────────────────────────
FROM source AS web-build
ENV NEXT_TELEMETRY_DISABLED=1
# NEXT_PUBLIC_* is inlined into the client bundle at build time, so it has to be
# a build arg — setting it at run time would have no effect.
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
# `next build` typechecks and compiles the transpiled workspace packages too.
# DATABASE_URL is only read at request time, never during the build.
RUN pnpm --filter @recipes/web run build

FROM web-build AS web-runtime
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
USER node
CMD ["pnpm", "--filter", "@recipes/web", "run", "start"]

# ── worker ───────────────────────────────────────────────────────────────────
FROM source AS worker-runtime
ENV NODE_ENV=production
USER node
CMD ["pnpm", "--filter", "@recipes/worker", "run", "start"]

# ── migrate (one-shot) ───────────────────────────────────────────────────────
FROM source AS migrate-runtime
ENV NODE_ENV=production
USER node
CMD ["sh", "-c", "pnpm db:migrate && pnpm db:seed"]
