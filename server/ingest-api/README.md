# Ingest API

The HTTP surface for the ResolveTrace ingest endpoints. Implements the public
contract documented in
[`resolvetrace-contract/api-spec/openapi.yaml`](https://github.com/PeakTek/resolvetrace-contract/blob/main/api-spec/openapi.yaml).

| Endpoint | Body schema | Success |
|---|---|---|
| `POST /v1/events` | `EventBatchRequest` | `202` |
| `POST /v1/replay/signed-url` | `ReplaySignedUrlRequest` | `201` |
| `POST /v1/replay/complete` | `ReplayManifestRequest` | `200` (`409` on integrity failure) |
| `POST /v1/session/start` | `SessionStartRequest` | `201` |
| `POST /v1/session/end` | `SessionEndRequest` | `200` |
| `GET /health` | — | `200` |
| `GET /ready` | — | `200` / `503` |

Authentication is via `Authorization: Bearer <api-key>` on every request
except `/health` and `/ready`.

## Portal API (internal)

| Endpoint | Success |
|---|---|
| `GET /api/v1/portal/sessions?limit=&cursor=` | `200` |
| `GET /api/v1/portal/sessions/:sessionId` | `200` (`404` if the session is unknown) |

These routes back the self-hosted portal's sessions views. They are **not
part of the public SDK contract — subject to change without notice** and
are intentionally absent from `resolvetrace-contract/api-spec/openapi.yaml`.

Authentication accepts either `OSS_API_KEY` or, when set, the separate
`PORTAL_API_TOKEN` bearer. Responses carry `X-Portal-Api-Version: 1`.

## Running locally

The simplest path is the repo's Docker Compose stack:

```bash
cd ../../deploy
docker compose up
# Server reachable at http://localhost:4317
curl http://localhost:4317/health
```

To run from source against your own infrastructure:

```bash
npm install
npm run dev
```

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `4317` | HTTP listener port. |
| `HOST` | `0.0.0.0` | Bind host. |
| `LOG_LEVEL` | `info` | Pino log level. |
| `CORS_ORIGINS` | `*` | Comma-separated allowed origins. |
| `OSS_API_KEY` | — | **Required.** Single ingest bearer token. |
| `PORTAL_API_TOKEN` | — | Optional separate bearer accepted on the portal API surface. When set, both this and `OSS_API_KEY` authenticate; when unset, only `OSS_API_KEY` does. |
| `RESOLVETRACE_TENANT_ID` | `oss-single-tenant` | Logical tenant id. |
| `RESOLVETRACE_ENV` | `prod` | One of `prod` / `staging` / `dev`. |
| `INGEST_HOST` | `resolvetrace.local` | Hostname stamped on principals. |
| `DATABASE_URL` | — | **Required.** Postgres DSN. |
| `REDIS_URL` | — | **Required.** Redis URL (currently used by adapters; ingest API uses an in-memory dedup store regardless — see [Known gaps](#known-gaps)). |
| `S3_BUCKET` | — | **Required.** Object-storage bucket. |
| `S3_ENDPOINT` | — | Optional. Set for MinIO (e.g. `http://minio:9000`). |
| `S3_PREFIX` | empty | Optional global key prefix. |
| `AWS_REGION` | — | **Required** for S3 / MinIO. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | from credential chain | Optional explicit creds. |
| `AUTH_MODE` | `local` | `local` (bcrypt admin user) or `oidc` (portal users only). Does not affect ingest API key. |
| `SECRETS_MODE` | `env` | `env` or `parameter-store`. |
| `INGEST_STRICT_SESSIONS` | `false` | When `true`, `POST /v1/events` rejects events whose `session_id` has not been started via `POST /v1/session/start` (`409 session_unknown`) and events missing `session_id` (`400 session_required`). Default `false` keeps the auto-derive-on-first-event path for backwards compatibility with older SDKs. Flip to `true` once your SDK fleet is on session-managed clients. |

## Rate limits

Default per-tenant quotas:

| Class | Soft RPS | Hard burst |
|---|---|---|
| `events` (`POST /v1/events`) | 60 | 120 |
| `replay_signed_url` (`POST /v1/replay/signed-url`) | 10 | 30 |
| `replay_complete` (`POST /v1/replay/complete`) | 10 | 30 |
| `session` (`POST /v1/session/*`) | 5 | 20 |

When tripped, the server responds `429` with the
`RateLimitErrorResponse` body shape (see contract repo) and
`Retry-After` / `X-RateLimit-*` headers.

In OSS single-tenant mode the per-tenant bucket effectively belongs to the
single configured API key, so a one-key install gets the full quota.

## Idempotency

`POST /v1/events` deduplicates on the `(tenantId, eventId)` tuple within a
24-hour window. Duplicate envelopes are counted in the `duplicates` field of
the 202 response. A batch that is entirely duplicates is signalled via the
`X-Idempotent-Replay: true` response header.

## Pluggable adapters

The server is built around injectable sinks/stores (interfaces in `types.ts`),
so the same HTTP surface runs from in-memory defaults (tests, the conformance
harness) up to durable backends selected by env:

- **Event + session sinks.** Default to Postgres (`PostgresEventSink` /
  `PostgresSessionSink`, schema in `migrations/`) when a database is configured;
  the in-memory sinks (`InMemoryEventSink`/`InMemorySessionSink`) back the test
  and no-DB paths. `POST /v1/events` persists accepted batches; the portal reads
  them back as live data.
- **Idempotency store.** In-memory LRU by default; when `REDIS_URL` is set the
  Redis-backed store is used (required for multi-node dedup correctness).
- **Replay checksum verification.** When the object store reports a
  `ChecksumSHA256` (S3 checksum mode / MinIO configured for it), it is compared
  against the manifest; otherwise the server records the client-asserted digest
  as the manifest sha256. Full body-download re-verification is out of scope for
  the ingest path.

See [deploy/README.md](../../deploy/README.md) for wiring these via env.

## Running the tests

```bash
npm test
```

All route tests use `fastify.inject()` — no real network is opened. Mock
adapters (`MockResolver`, `MockStorage`, etc.) live in
[`test-utils/mocks.ts`](./test-utils/mocks.ts).
