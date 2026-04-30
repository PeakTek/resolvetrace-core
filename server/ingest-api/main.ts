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
  InMemoryEventSink,
  InMemorySessionSink,
} from "./in-memory-sinks.js";
import { createIdempotencyStore } from "./plugins/idempotency.js";
import {
  createPgPool,
  PostgresEventRepository,
  PostgresEventSink,
  PostgresSessionRepository,
  PostgresSessionSink,
  runMigrations,
} from "./postgres.js";
import {
  EventRepository,
  EventSink,
  ReadinessCheck,
  SessionRepository,
  SessionSink,
} from "./types.js";

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

  // --- Persistence wiring ---
  // With DATABASE_URL set, we use Postgres-backed sinks + repositories and
  // run migrations on boot. Without it, we fall back to in-memory sinks and
  // empty repository stubs — enough for smoke runs and unit tests but not
  // durable. The fallback logs a warning so it's visible in logs.
  let eventSink: EventSink;
  let sessionSink: SessionSink;
  let sessionRepository: SessionRepository;
  let eventRepository: EventRepository;
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
  try {
    await createAuthProvider();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("Auth provider not initialised:", (err as Error).message);
  }

  const app = await buildApp({
    resolver,
    storage,
    eventSink,
    sessionSink,
    sessionRepository,
    eventRepository,
    idempotencyStore,
    readinessChecks,
    corsOrigins,
    logLevel,
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutdown signal received; closing server");
    try {
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
