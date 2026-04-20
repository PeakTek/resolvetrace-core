/**
 * Ingest API server entrypoint.
 *
 * Wires production adapters, builds the Fastify app, starts listening, and
 * installs a graceful-shutdown handler. The shape of this file is
 * intentionally boring — real configuration lives in `app.ts` and the
 * subsystem adapters.
 */

import process from "node:process";
import { createResolver } from "../tenant-resolver/index.js";
import { createStorage } from "../storage/index.js";
import { createAuthProvider } from "../auth/index.js";
import { createSecretsProvider } from "../secrets/index.js";
import { buildApp } from "./app.js";
import {
  InMemoryEventSink,
  InMemorySessionSink,
} from "./in-memory-sinks.js";
import { createIdempotencyStore } from "./plugins/idempotency.js";
import { ReadinessCheck } from "./types.js";

async function main(): Promise<void> {
  const port = parseInt(process.env.PORT ?? "4317", 10);
  const host = process.env.HOST ?? "0.0.0.0";
  const logLevel = process.env.LOG_LEVEL ?? "info";
  const corsOrigins = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const resolver = createResolver();
  const storage = createStorage();
  const idempotencyStore = createIdempotencyStore();
  const eventSink = new InMemoryEventSink();
  const sessionSink = new InMemorySessionSink();

  // Secrets and auth providers are wired at boot when their config is
  // present so a deployment misconfig fails fast. They are not consumed by
  // the ingest API itself (the portal API in a later wave will use them) —
  // skipping them when env is incomplete is fine for an ingest-only run.
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

  // Readiness probes — storage is the only dependency the Wave 4 code path
  // touches. DB / Redis checks land when those adapters come online.
  const readinessChecks: ReadinessCheck[] = [
    {
      name: "storage",
      async check() {
        try {
          // A best-effort signed-url mint with a probe key; we never upload.
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

  const app = await buildApp({
    resolver,
    storage,
    eventSink,
    sessionSink,
    idempotencyStore,
    readinessChecks,
    corsOrigins,
    logLevel,
  });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutdown signal received; closing server");
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port, host });
  app.log.info({ port, host }, "ingest API listening");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal during startup:", err);
  process.exit(1);
});
