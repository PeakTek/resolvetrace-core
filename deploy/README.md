# Deploy

Container build + local-stack assets for running the ResolveTrace OSS
ingest server.

## Files

| File | Purpose |
|---|---|
| `Dockerfile` | Multi-stage image build (builder + runtime, non-root `node` user). |
| `docker-compose.yml` | Local-dev stack: ingest server + Postgres + Redis + MinIO. Builds the image locally. |
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
# Server reachable at http://localhost:4317
curl http://localhost:4317/health
```

Use this when you are iterating on server code.

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
- Exposes `4317/tcp`. Override with the `PORT` env var.
- Runs as the unprivileged `node` user (no root).
- `HEALTHCHECK` pokes `http://127.0.0.1:${PORT}/health` every 30 s.
- Default `CMD` is `node dist/ingest-api/main.js`.

See the [ingest-api README](../server/ingest-api/README.md) for the full
list of environment variables the server consumes at startup.
