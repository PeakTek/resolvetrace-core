# syntax=docker/dockerfile:1.7
#
# Production Docker image for the ResolveTrace OSS bundle.
#
# Single image, two entry points. The default CMD runs the Fastify ingest
# server (unchanged from the original single-service image); the
# `docker-compose.yml` override drives a second container off the same
# image with `node web/.next/standalone/server.js` to serve the portal.
#
# Three-stage multi-stage build:
#   1. `builder-server`  installs dev+prod deps under /app, compiles TypeScript
#                        to /app/dist, prunes dev deps
#   2. `builder-portal`  installs portal deps under /app/web, runs `next build`
#                        (Next.js `output: "standalone"` emits .next/standalone
#                        + .next/static and a self-contained node_modules tree)
#   3. `runtime`         copies the compiled server + portal standalone bundle
#                        into a minimal image run as `node`
#
# Base is `node:20-bookworm-slim` on every stage. We deliberately avoid
# `-alpine` because `bcrypt` (and potentially future native deps) ship
# prebuilt binaries for glibc; sticking to a glibc base removes the need
# for a build-from-source toolchain step in the runtime stage.
#
# Build locally for a quick check:
#     docker build -f deploy/Dockerfile -t resolvetrace-core:dev .
#
# Multi-arch buildx build (what CI runs):
#     docker buildx build \
#       --platform linux/amd64,linux/arm64 \
#       -f deploy/Dockerfile \
#       -t ghcr.io/peaktek/resolvetrace-core:latest \
#       --push .

ARG NODE_VERSION=20-bookworm-slim

# --- Builder: server -------------------------------------------------------
FROM node:${NODE_VERSION} AS builder-server
WORKDIR /app

# Copy manifests first so the npm install layer can be reused across
# source-only edits.
COPY package.json ./
COPY package-lock.json* ./

# If a lockfile is present prefer `npm ci` (reproducible); otherwise fall
# back to `npm install`. `--include=dev` ensures the TypeScript compiler
# is available for the build step below.
RUN if [ -f package-lock.json ]; then \
      npm ci --include=dev --no-audit --no-fund; \
    else \
      npm install --include=dev --no-audit --no-fund; \
    fi

# Copy sources required to produce the build output. `tests/` are
# excluded from the tsc include list already (see tsconfig.json).
COPY tsconfig.json ./
COPY server ./server

# Compile to ./dist
RUN npm run build

# Prune dev dependencies from the tree we'll copy into the runtime image.
RUN npm prune --omit=dev

# --- Builder: portal -------------------------------------------------------
FROM node:${NODE_VERSION} AS builder-portal
WORKDIR /app/web

# Portal lives in its own workspace with its own package.json; keep the
# install layer isolated from the server's so an unrelated server edit
# doesn't invalidate the portal's node_modules cache (and vice versa).
COPY web/package.json ./
COPY web/package-lock.json* ./

RUN if [ -f package-lock.json ]; then \
      npm ci --include=dev --no-audit --no-fund; \
    else \
      npm install --include=dev --no-audit --no-fund; \
    fi

# Copy the rest of the portal sources.
COPY web/ ./

# `output: "standalone"` in next.config.ts tells Next.js to emit a
# self-contained server bundle at .next/standalone/. Static assets end up
# at .next/static (and public/ if present) — both must be copied
# alongside the standalone bundle at runtime.
RUN npm run build

# --- Runtime ---------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=4317 \
    HOST=0.0.0.0

# --- Server payload ---
# Compiled TypeScript + production-only node_modules from builder-server.
# Ownership set to node:node so the non-root runtime user can read them.
COPY --from=builder-server --chown=node:node /app/dist ./dist
COPY --from=builder-server --chown=node:node /app/node_modules ./node_modules
COPY --from=builder-server --chown=node:node /app/package.json ./package.json

# --- Portal payload ---
# Next.js "standalone" emits its own node_modules tree + server.js under
# .next/standalone; .next/static and public/ are sibling assets that the
# standalone server reads at runtime. Lay them out under /app/web so the
# portal command in docker-compose can `cd web && node .next/standalone/server.js`.
COPY --from=builder-portal --chown=node:node /app/web/.next/standalone ./web
COPY --from=builder-portal --chown=node:node /app/web/.next/static ./web/.next/static
COPY --from=builder-portal --chown=node:node /app/web/public ./web/public

# The ingest API listens on 4317 by default (override via PORT env var);
# the portal listens on 3000 when the portal command is used.
EXPOSE 4317 3000

# Run as the unprivileged `node` user baked into the official image.
USER node

# Healthcheck pokes the in-process /health endpoint. Using Node's stdlib
# http client avoids shipping curl/wget into the runtime image. The
# healthcheck targets the server by default; docker-compose's portal
# service overrides the healthcheck to target the portal's /-served page.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || '4317') + '/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Build-time metadata. CI populates these via --build-arg; local builds
# fall back to sensible defaults so the image is still well-formed.
ARG IMAGE_VERSION=0.0.0-dev
ARG IMAGE_REVISION=unknown
ARG IMAGE_CREATED=unknown

# OCI image annotations. These are the canonical labels that GHCR, other
# registries, and scanners surface in their UIs. Keep the source URL
# pointed at the public GitHub repo only.
LABEL org.opencontainers.image.title="resolvetrace-core" \
      org.opencontainers.image.description="ResolveTrace OSS bundle — Fastify ingest server + Next.js portal (single-tenant, BSL 1.1)." \
      org.opencontainers.image.source="https://github.com/PeakTek/resolvetrace-core" \
      org.opencontainers.image.url="https://github.com/PeakTek/resolvetrace-core" \
      org.opencontainers.image.documentation="https://github.com/PeakTek/resolvetrace-core/blob/main/README.md" \
      org.opencontainers.image.licenses="BUSL-1.1" \
      org.opencontainers.image.vendor="PeakTek" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.revision="${IMAGE_REVISION}" \
      org.opencontainers.image.created="${IMAGE_CREATED}"

# Default CMD: the ingest server. docker-compose's portal service
# overrides this to launch Next.js standalone.
CMD ["node", "dist/ingest-api/main.js"]
