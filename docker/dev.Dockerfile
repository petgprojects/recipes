# Development image, shared by `web`, `worker` and the one-shot `migrate`
# service. One image rather than three because in dev every service runs the
# same workspace from the same bind mount and differs only in its command —
# three near-identical Dockerfiles would just be three things to keep in sync.
#
# Production is a different story and lives in docker/prod.Dockerfile.

FROM node:24-bookworm-slim

# corepack pins pnpm from package.json#packageManager. The prompt must be
# disabled or a non-interactive build hangs waiting for a keypress.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# Manifests first, so a source edit does not invalidate the install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/

RUN pnpm install --frozen-lockfile

# The source is bind-mounted over this at run time; it is copied anyway so the
# image is runnable on its own (and so `migrate` works without a mount).
COPY . .

EXPOSE 3000
CMD ["node", "--version"]
