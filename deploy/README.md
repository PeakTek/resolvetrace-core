# Deploy

Container build + local-stack assets for running the ResolveTrace OSS
bundle — Fastify ingest server + Next.js portal, bundled in a single
image.

## Files

| File | Purpose |
|---|---|
| `Dockerfile` | Three-stage image build (builder-server + builder-portal + runtime, non-root `node` user). |
| `docker-compose.yml` | Local-dev stack: ingest server (4317) + portal UI (3000) + Postgres + Redis + MinIO. Builds the image locally. |
| `docker-compose.published.yml` | Override file that swaps the locally-built image for the published GHCR image. |
| `local-env/` | Sample env files for local development. |

## Published image

The [`publish-image` workflow](../.github/workflows/publish-image.yml)
builds a multi-arch (`linux/amd64` + `linux/arm64`) image and pushes to
GitHub Container Registry on every push to `main` and on every `v*.*.*`
tag:

```
ghcr.io/peaktek/resolvetrace-core:latest        # tip of main
ghcr.io/peaktek/resolvetrace-core:sha-<short>   # every build
ghcr.io/peaktek/resolvetrace-core:v0.1.0        # semver tag pushes
```

Pull it directly:

```bash
docker pull ghcr.io/peaktek/resolvetrace-core:latest
```

## Pattern A — build locally (default)

Bring up the full stack, rebuilding the image against the current
working tree:

```bash
cd deploy
docker compose up --build
# Ingest server reachable at http://localhost:4317
curl http://localhost:4317/health
# Portal UI reachable at http://localhost:3000
open http://localhost:3000
```

Use this when you are iterating on server or portal code.

## Pattern B — pull the published image

Skip the local build and pull the image from GHCR:

```bash
cd deploy
docker compose \
  -f docker-compose.yml \
  -f docker-compose.published.yml \
  up
```

Pin to a specific tag by exporting `RESOLVETRACE_IMAGE`:

```bash
RESOLVETRACE_IMAGE=ghcr.io/peaktek/resolvetrace-core:v0.1.0 \
  docker compose \
    -f docker-compose.yml \
    -f docker-compose.published.yml \
    up
```

Use this when you just want to run the server (demos, data-plane bring-up,
conformance checks).

## Building the image manually

Single-arch build for the host machine:

```bash
docker build -f deploy/Dockerfile -t resolvetrace-core:dev .
```

Multi-arch build (matches what CI does — requires `docker buildx`):

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -f deploy/Dockerfile \
  -t ghcr.io/peaktek/resolvetrace-core:local \
  --load .
```

## Image surface

- Base: `node:20-bookworm-slim` (glibc — bcrypt prebuilt binaries just work).
- Exposes `4317/tcp` (ingest) and `3000/tcp` (portal).
- Runs as the unprivileged `node` user (no root).
- Default `CMD` launches the ingest server: `node dist/ingest-api/main.js`.
- Dockerfile `HEALTHCHECK` pokes `http://127.0.0.1:${PORT}/health` every 30 s (targets the ingest server by default; `docker-compose.yml`'s portal service overrides this with a check against the Next.js root).
- The portal command is `node web/server.js`, driven by Next.js's `output: "standalone"` build (`web/next.config.ts`). No devDeps or server-side Node module tree beyond what the standalone bundle packages.

Two entry points, one image — the `docker-compose.yml` file brings both up as sibling services.

See the [ingest-api README](../server/ingest-api/README.md) for the full list of environment variables the server consumes at startup.

The ingest service accepts two bearer tokens: `OSS_API_KEY` (SDK / replay traffic) and, optionally, `PORTAL_API_TOKEN` (portal query surface). Keeping them distinct lets the portal's bearer be rotated without breaking SDK integrations and vice versa. If `PORTAL_API_TOKEN` is left blank, the server falls back to only accepting `OSS_API_KEY`.

### Strict-session mode (`INGEST_STRICT_SESSIONS`)

Set `INGEST_STRICT_SESSIONS=true` to reject events whose `session_id` has
not been started via `POST /v1/session/start`. Default is `false`
(lenient) for backwards compatibility with older SDKs that don't issue
`/v1/session/start`. Newer SDK versions automatically issue start, so flip
to `true` once your fleet is upgraded.

Behavior under strict mode:

- Events arriving with an unknown `(tenant_id, session_id)` tuple are
  rejected with HTTP `409` and body `{ "error": "session_unknown",
  "unresolved_session_ids": [...], "message": "..." }`. The client may
  re-issue `POST /v1/session/start` for each id and retry the batch.
- Events arriving without a `session_id` are rejected with HTTP `400` and
  body `{ "error": "session_required", "message": "..." }`. Whole batches
  are rejected if any event in the batch is missing a `session_id`.

Behavior under the default lenient mode is unchanged: events without a
recognized session are still accepted, and a session row is auto-derived
from the first event's `captured_at` so listings stay correct.

## Portal (Next.js)

The portal is served by Next.js's standalone runtime on port 3000. `/sessions`, `/sessions/[id]`, and `/audit` render live data from the ingest server. `/login` is a development stub that accepts any non-empty credentials — the OSS build ships single-tenant with no identity provider; real user login + RBAC are a managed-deployment concern (a composing runtime injects an auth provider). See `web/README.md` for scope.

Environment variables the portal reads at startup:

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Listener port |
| `HOSTNAME` | `0.0.0.0` | Listener bind address (`0.0.0.0` so the Docker network can reach it) |
| `NODE_ENV` | `production` | Standard Next.js runtime flag |

The portal does NOT currently require `DATABASE_URL`, Redis, or S3 env — those are set on the ingest service in `docker-compose.yml` and are inert for the portal container.

### Connecting to the ingest API

Session list and detail pages query the ingest server over HTTP from server components. Two additional env vars on the `portal` service control that:

| Var | Default | Purpose |
|---|---|---|
| `RT_INGEST_URL` | `http://resolvetrace:4317` | Ingest server URL used by Portal server components for session queries. |
| `RT_PORTAL_API_TOKEN` | — | Bearer token sent to the ingest server. Must match the ingest side's `PORTAL_API_TOKEN` (falls back to `OSS_API_KEY` if the portal-specific one isn't set). |

## Operating notes (self-hosted)

The OSS bundle is a single-tenant server you run yourself; a few durability and
security basics worth wiring for anything beyond local use:

- **Persistence.** Point the ingest service at Postgres (`DATABASE_URL`) so
  events/sessions/audit/replay-manifests survive restarts (the in-memory
  defaults are for tests/local only). Set `REDIS_URL` for correct idempotent
  dedup across multiple ingest nodes. Replay chunks go to S3/MinIO.
- **Backups.** Back up the Postgres database and the replay object store
  (chunks live under `<sessionId>/<seq>.rrweb`).
- **Secrets.** `RT_PORTAL_API_TOKEN`/`PORTAL_API_TOKEN` (portal↔ingest bearer)
  and any SDK API keys are secrets — rotate them by updating the env and
  restarting; keep them out of the image and version control.
- **TLS + auth.** Terminate TLS at a reverse proxy in front of the server. The
  OSS portal login is a stub (single-tenant) — restrict portal access at the
  network/proxy layer, or run behind your own SSO. Real multi-tenant login is a
  managed-deployment concern, not part of this bundle.
