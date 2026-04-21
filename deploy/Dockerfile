# syntax=docker/dockerfile:1.7
#
# Production Docker image for the ResolveTrace OSS ingest server.
#
# Multi-stage build:
#   1. `builder`  — installs dev+prod deps, compiles TypeScript, prunes dev deps.
#   2. `runtime`  — copies the pruned tree into a minimal image run as `node`.
#
# Base is `node:20-bookworm-slim` on both stages. We deliberately avoid
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

# --- Builder ---------------------------------------------------------------
FROM node:${NODE_VERSION} AS builder
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

# --- Runtime ---------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=4317 \
    HOST=0.0.0.0

# Copy the compiled output + production-only node_modules from the builder.
# Ownership is set to `node:node` so the non-root runtime user can read them.
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json

# The ingest API listens on 4317 by default (override via PORT env var).
EXPOSE 4317

# Run as the unprivileged `node` user baked into the official image.
USER node

# Healthcheck pokes the in-process /health endpoint. Using Node's stdlib
# http client avoids shipping curl/wget into the runtime image.
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
      org.opencontainers.image.description="ResolveTrace OSS ingest server (single-tenant, BSL 1.1)." \
      org.opencontainers.image.source="https://github.com/PeakTek/resolvetrace-core" \
      org.opencontainers.image.url="https://github.com/PeakTek/resolvetrace-core" \
      org.opencontainers.image.documentation="https://github.com/PeakTek/resolvetrace-core/blob/main/README.md" \
      org.opencontainers.image.licenses="BUSL-1.1" \
      org.opencontainers.image.vendor="PeakTek" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.revision="${IMAGE_REVISION}" \
      org.opencontainers.image.created="${IMAGE_CREATED}"

CMD ["node", "dist/ingest-api/main.js"]
