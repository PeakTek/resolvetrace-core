# resolvetrace-core

Single-tenant, self-hosted ResolveTrace server.

## Purpose

`resolvetrace-core` is the public, self-hosted server distribution for ResolveTrace. It runs the same public contract used by ResolveTrace clients without exposing private service internals.

## Layout

- `server/` — the ingest/portal server: HTTP API, Postgres/Redis/S3 adapters,
  replay pipeline, retention, and the portal-auth contract seams.
- `web/` — the operator portal UI (Next.js): sessions, replay, audit, settings.
- `deploy/` — Docker image + compose bundle to build and run the stack. See
  [deploy/README.md](./deploy/README.md).

Runnable SDK examples live in the separate
[resolvetrace-examples](https://github.com/PeakTek/resolvetrace-examples) repo.

This repository is focused on:

- local development
- self-hosted deployments
- contract conformance
- reference integrations

This repository does not include:

- managed service operations
- multi-tenant control surfaces
- private service components that are not required for self-hosting
- internal infrastructure or tooling

## Contract Compatibility

This repository is expected to consume `resolvetrace-contract` as the interface authority. Public API shape and SDK-facing schemas should be defined there, not re-declared here.

## Docker

Published multi-arch images (`linux/amd64` + `linux/arm64`) are pushed to
GitHub Container Registry on every push to `main` and on every `v*.*.*`
tag:

```bash
docker pull ghcr.io/peaktek/resolvetrace-core:latest
```

Tag conventions:

| Tag | Meaning |
|---|---|
| `:latest` | Tip of `main`. Moves on every merge. |
| `:sha-<short>` | Immutable — one per build. Use this when you need reproducibility. |
| `:vX.Y.Z`, `:X.Y`, `:X` | Published on `v*.*.*` tag pushes. |

To run the full local stack (ingest server + Postgres + Redis + MinIO)
using the published image instead of a local build, see the two patterns
in [`deploy/README.md`](./deploy/README.md). The minimum required env
vars (`OSS_API_KEY`, `DATABASE_URL`, `REDIS_URL`, `S3_*`, `AWS_REGION`)
are documented in the [ingest-api README](./server/ingest-api/README.md).

## License

Business Source License 1.1 with an Apache 2.0 change license. See [LICENSE](./LICENSE) for the binding terms.

In plain English:

- self-hosting and internal use are allowed
- deployment in a single customer's own environment is allowed
- offering the software itself as a competing hosted service is not allowed before the change date
- each release converts to Apache 2.0 three years after that release is first published

## Contributing

Changes in this repository should preserve compatibility with the public contract and avoid introducing private-only assumptions into the open-source server.
