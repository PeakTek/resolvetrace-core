# Two-stage build for the ResolveTrace OSS server.
# Stage 1 compiles TypeScript; stage 2 ships the runtime image.

# --- Builder ---------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app

# Copy manifests first to leverage layer caching for the npm install step.
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

# Copy the rest of the sources and compile.
COPY tsconfig.json ./
COPY server ./server
RUN npm run build

# Drop dev dependencies; keep production-only modules.
RUN npm prune --omit=dev

# --- Runtime ---------------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4317
ENV HOST=0.0.0.0

# Copy compiled output and pruned node_modules from the builder.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

EXPOSE 4317

# Default command. The compose file overrides if you need a different entry.
CMD ["node", "dist/server/ingest-api/main.js"]
