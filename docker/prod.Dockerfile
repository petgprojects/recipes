# Production image. Multi-stage: one install/build stage, then a slim runtime.
# Used by compose.prod.yml. First actually built and run on 2026-07-29, which
# immediately found two bugs that no test could see — a build with no
# DATABASE_URL and a volume the `node` user could not write. Both are fixed and
# annotated below; PROGRESS.md amendment A22 has the reasoning.
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
# The build needs a *parseable* DATABASE_URL and never connects to it. `/` and
# `/api/health` both import `@recipes/shared/env`, whose Zod validation runs at
# module scope, and Next evaluates every route module during "collect page data";
# without the variable the build fails there. Nothing queries: both are
# `force-dynamic`, so neither is prerendered.
#
# `.env` is deliberately in `.dockerignore` — secrets must not enter an image
# layer — so the value cannot simply be inherited from the repo, and it is an ARG
# rather than an ENV so it does not persist into the runtime image and shadow the
# real one compose injects. A wrong value at *run* time must fail loudly rather
# than quietly point somewhere else.
ARG DATABASE_URL=postgresql://build:build@localhost:5432/build
# `next build` typechecks and compiles the transpiled workspace packages too.
RUN DATABASE_URL=$DATABASE_URL pnpm --filter @recipes/web run build

FROM web-build AS web-runtime
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
# The `recipe-images` volume mounts here, and `data/` is in `.dockerignore`, so
# without this the path does not exist in the image — Docker then creates the
# mountpoint root-owned and the `node` user cannot write to it. web only reads
# the directory, but it is created identically in both runtime stages so the two
# agree about ownership of a volume they share.
RUN mkdir -p /app/data/images && chown -R node:node /app/data
USER node
CMD ["pnpm", "--filter", "@recipes/web", "run", "start"]

# ── worker ───────────────────────────────────────────────────────────────────
FROM source AS worker-runtime
ENV NODE_ENV=production
# The worker is the *writer* of this volume (downloaded, downscaled photos), so
# this line is load-bearing rather than defensive. See the note on web-runtime.
RUN mkdir -p /app/data/images && chown -R node:node /app/data
USER node
CMD ["pnpm", "--filter", "@recipes/worker", "run", "start"]

# ── migrate (one-shot) ───────────────────────────────────────────────────────
FROM source AS migrate-runtime
ENV NODE_ENV=production
USER node
CMD ["sh", "-c", "pnpm db:migrate && pnpm db:seed"]
