/**
 * Public composition API for the ResolveTrace OSS server.
 *
 * Re-exports the building blocks a downstream server needs to assemble its own
 * ResolveTrace deployment — most importantly `buildApp`, the data-plane
 * adapters, and the `TenantConfigResolver` seam. The OSS `ingest-api/main.ts`
 * is one consumer; a server that injects a different (e.g. registry-backed)
 * resolver is another.
 *
 * This exposes only the public, self-hosting building blocks of the OSS server.
 * No private service internals belong here.
 */

export { buildApp } from "./ingest-api/app.js";
export type { BuildAppOptions } from "./ingest-api/app.js";

// Postgres data-plane adapters + migration runner.
export {
  createPgPool,
  runMigrations,
  PostgresEventSink,
  PostgresSessionSink,
  PostgresSessionRepository,
  PostgresEventRepository,
  PostgresAuditSink,
  PostgresAuditRepository,
  PostgresSettingsRepository,
  PostgresReplayManifestStore,
  PostgresPurgeStore,
} from "./ingest-api/postgres.js";

export { createStorage } from "./storage/index.js";
export { createIdempotencyStore } from "./ingest-api/plugins/idempotency.js";
export { loadRetentionConfig } from "./ingest-api/retention-config.js";
export { RetentionScheduler } from "./ingest-api/retention-scheduler.js";

// Dependency + adapter interfaces a composing server must satisfy.
export type {
  IngestApiDependencies,
  EventSink,
  SessionSink,
  SessionRepository,
  EventRepository,
  AuditSink,
  AuditRepository,
  SettingsRepository,
  ReplayManifestStore,
  ReplayUploadGuard,
  ReplayUploadGuardContext,
  PurgeStore,
  ReadinessCheck,
} from "./ingest-api/types.js";

// The tenant-resolution seam. A composing server provides its own
// implementation (the OSS default is the single-tenant resolver).
export type {
  TenantConfigResolver,
  TenantConfig,
  ApiKeyPrincipal,
} from "./tenant-resolver/types.js";
