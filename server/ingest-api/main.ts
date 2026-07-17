/**
 * Ingest API server entrypoint.
 *
 * Wires production adapters, builds the Fastify app, starts listening, and
 * installs a graceful-shutdown handler. The shape of this file is
 * intentionally boring — real configuration lives in `app.ts` and the
 * subsystem adapters.
 */

import process from "node:process";
import type { Pool } from "pg";
import { createResolver } from "../tenant-resolver/index.js";
import { createStorage } from "../storage/index.js";
import { createAuthProvider } from "../auth/index.js";
import { createSecretsProvider } from "../secrets/index.js";
import { buildApp } from "./app.js";
import {
  EmptyEventRepository,
  EmptySessionRepository,
  InMemoryAuditSink,
  InMemoryEventSink,
  InMemoryPurgeStore,
  InMemoryReplayManifestStore,
  InMemorySessionSink,
  InMemorySettingsRepository,
} from "./in-memory-sinks.js";
import { createIdempotencyStore } from "./plugins/idempotency.js";
import {
  createPgPool,
  PostgresAuditRepository,
  PostgresAuditSink,
  PostgresEventRepository,
  PostgresEventSink,
  PostgresPurgeStore,
  PostgresReplayManifestStore,
  PostgresSessionRepository,
  PostgresSessionSink,
  PostgresSettingsRepository,
  runMigrations,
} from "./postgres.js";
import {
  AuditRepository,
  AuditSink,
  EventRepository,
  EventSink,
  PurgeStore,
  ReadinessCheck,
  ReplayManifestStore,
  SessionRepository,
  SessionSink,
  SettingsRepository,
} from "./types.js";
import { loadRetentionConfig } from "./retention-config.js";
import { RetentionScheduler } from "./retention-scheduler.js";
import type { AuthProvider } from "../auth/index.js";

function parseBoolEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

async function main(): Promise<void> {
  const port = parseInt(process.env.PORT ?? "4317", 10);
  const host = process.env.HOST ?? "0.0.0.0";
  const logLevel = process.env.LOG_LEVEL ?? "info";
  const corsOrigins = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // When true, `/v1/events` rejects events whose session_id has not been
  // started via `/v1/session/start`. Default false keeps the legacy
  // auto-derive path so older SDKs continue to ingest unchanged.
  const strictSessions = parseBoolEnv(process.env.INGEST_STRICT_SESSIONS);

  const resolver = createResolver();
  const storage = createStorage();
  const idempotencyStore = createIdempotencyStore();
  // Retention config (env defaults). Parsing throws on a malformed value so a
  // misconfig fails fast rather than silently keeping data forever.
  const retentionConfig = loadRetentionConfig();

  // --- Persistence wiring ---
  // With DATABASE_URL set, we use Postgres-backed sinks + repositories and
  // run migrations on boot. Without it, we fall back to in-memory sinks and
  // empty repository stubs — enough for smoke runs and unit tests but not
  // durable. The fallback logs a warning so it's visible in logs.
  let eventSink: EventSink;
  let sessionSink: SessionSink;
  let sessionRepository: SessionRepository;
  let eventRepository: EventRepository;
  let auditSink: AuditSink;
  let auditRepository: AuditRepository;
  let settingsRepository: SettingsRepository;
  let replayManifestStore: ReplayManifestStore;
  let purgeStore: PurgeStore;
  let pgPool: Pool | undefined;

  const databaseUrl = process.env.DATABASE_URL;
  const readinessChecks: ReadinessCheck[] = [
    {
      name: "storage",
      async check() {
        try {
          await storage.createSignedUploadUrl({
            key: "__readiness__/probe.bin",
            contentType: "application/octet-stream",
            maxBytes: 1,
            expiresInSeconds: 60,
          });
          return true;
        } catch {
          return false;
        }
      },
    },
  ];

  if (databaseUrl && databaseUrl.length > 0) {
    pgPool = createPgPool(databaseUrl);
    await runMigrations(pgPool);
    eventSink = new PostgresEventSink(pgPool, { strictSessions });
    sessionSink = new PostgresSessionSink(pgPool);
    sessionRepository = new PostgresSessionRepository(pgPool);
    eventRepository = new PostgresEventRepository(pgPool);
    auditSink = new PostgresAuditSink(pgPool);
    auditRepository = new PostgresAuditRepository(pgPool);
    settingsRepository = new PostgresSettingsRepository(pgPool);
    replayManifestStore = new PostgresReplayManifestStore(pgPool);
    purgeStore = new PostgresPurgeStore(pgPool);
    const pool = pgPool;
    readinessChecks.push({
      name: "postgres",
      async check() {
        try {
          await pool.query("SELECT 1");
          return true;
        } catch {
          return false;
        }
      },
    });
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      "DATABASE_URL not set — events will be held in memory and discarded on restart. Set DATABASE_URL to enable persistence."
    );
    eventSink = new InMemoryEventSink();
    sessionSink = new InMemorySessionSink();
    sessionRepository = new EmptySessionRepository();
    eventRepository = new EmptyEventRepository();
    // A single in-memory instance backs both the write and read sides so
    // audit rows written during a smoke run are queryable in the same process.
    const inMemoryAudit = new InMemoryAuditSink();
    auditSink = inMemoryAudit;
    auditRepository = inMemoryAudit;
    // Non-durable settings + an empty purge store: the retention surface still
    // responds, there's just no persisted data to act on in this smoke mode.
    settingsRepository = new InMemorySettingsRepository();
    // A linked manifest + purge pair so a smoke run's replay complete/read/
    // purge are mutually consistent in-process.
    const inMemoryManifest = new InMemoryReplayManifestStore();
    replayManifestStore = inMemoryManifest;
    purgeStore = new InMemoryPurgeStore(inMemoryManifest);
  }

  // Secrets and auth providers are wired at boot when their config is
  // present so a deployment misconfig fails fast. They are not consumed by
  // the ingest API itself — skipping them when env is incomplete is fine
  // for an ingest-only run.
  try {
    createSecretsProvider();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("Secrets provider not initialised:", (err as Error).message);
  }
  let authProvider: AuthProvider | undefined;
  try {
    authProvider = await createAuthProvider();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("Auth provider not initialised:", (err as Error).message);
  }

  // Surface the single tenant's id + a friendly name in the portal-auth
  // contract (login response + switcher). Falls back to a generic single tenant
  // if the resolver can't be probed (e.g. an ingest-only smoke run).
  let defaultPortalTenant: { id: string; displayName: string } | undefined;
  try {
    const t = await resolver.resolveByIngestHost(process.env.INGEST_HOST ?? "");
    defaultPortalTenant = {
      id: t.tenantId,
      displayName: process.env.PORTAL_TENANT_NAME ?? "ResolveTrace",
    };
  } catch {
    /* leave undefined; the contract falls back to a generic single tenant */
  }

  const app = await buildApp({
    resolver,
    storage,
    eventSink,
    sessionSink,
    sessionRepository,
    eventRepository,
    auditSink,
    auditRepository,
    settingsRepository,
    replayManifestStore,
    purgeStore,
    retentionConfig,
    authProvider,
    defaultPortalTenant,
    idempotencyStore,
    readinessChecks,
    corsOrigins,
    logLevel,
  });

  // Scheduled retention purge. Only meaningful against a real data store, and
  // only when enabled in config. The single-tenant OSS server purges its one
  // configured tenant; the actor on scheduled runs is `system`.
  let scheduler: RetentionScheduler | undefined;
  if (pgPool && retentionConfig.purgeEnabled) {
    const tenantConfig = await resolver.resolveByIngestHost(
      process.env.INGEST_HOST ?? ""
    );
    scheduler = new RetentionScheduler({
      purgeStore,
      storage,
      settingsRepository,
      auditSink,
      retentionConfig,
      tenantId: tenantConfig.tenantId,
      logger: app.log,
    });
    scheduler.start();
  } else if (pgPool) {
    app.log.info("retention purge scheduler disabled by config");
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutdown signal received; closing server");
    try {
      scheduler?.stop();
      await app.close();
      if (pgPool) {
        await pgPool.end();
      }
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port, host });
  app.log.info(
    { port, host, strictSessions },
    "ingest API listening"
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal during startup:", err);
  process.exit(1);
});
