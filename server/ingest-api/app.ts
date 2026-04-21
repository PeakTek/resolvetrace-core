/**
 * Fastify app builder.
 *
 * `main.ts` wires production adapters and calls this. Tests call this
 * directly with mock adapters and use `fastify.inject()` — no network.
 */

import type { Server } from "node:http";
import Fastify, { FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import { IngestApiDependencies } from "./types.js";
import { authPlugin, UnauthorizedError } from "./plugins/auth.js";
import {
  bodyValidatePlugin,
  ValidationError,
} from "./plugins/body-validate.js";
import {
  rateLimitPlugin,
  buildRateLimitPluginOptions,
} from "./plugins/rate-limit.js";
import { buildLoggerOptions } from "./plugins/logger-redact.js";
import { eventsRoutes } from "./routes/events.js";
import { replayRoutes } from "./routes/replay.js";
import { sessionRoutes } from "./routes/session.js";
import { healthRoutes } from "./routes/health.js";

export interface BuildAppOptions extends IngestApiDependencies {
  /** Pino log level. Defaults to env / "info". */
  logLevel?: string;
  /** Disable request logging. Used by tests to keep output quiet. */
  disableRequestLogging?: boolean;
}

export async function buildApp(
  opts: BuildAppOptions
): Promise<FastifyInstance<Server>> {
  const fastify = Fastify<Server>({
    logger: opts.disableRequestLogging
      ? false
      : buildLoggerOptions({ level: opts.logLevel }),
    // Fastify validates JSON bodies; our ajv-based plugin handles the public
    // schemas. Keep Fastify's default body parser for application/json.
    bodyLimit: 1024 * 1024, // 1 MiB server-level cap (batch cap is 512 KiB).
    trustProxy: true,
  });

  // --- Global security headers / CORS -------------------------------------
  await fastify.register(helmet, {
    // Permissive CSP at the ingest surface — no HTML served from here.
    contentSecurityPolicy: false,
  });
  const origins = opts.corsOrigins ?? [];
  await fastify.register(cors, {
    origin: origins.length === 0 ? true : origins,
    methods: ["POST", "GET", "OPTIONS"],
    allowedHeaders: [
      "Authorization",
      "Content-Type",
      "X-Request-ID",
      "X-Idempotency-Key",
    ],
    exposedHeaders: [
      "X-Request-ID",
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
      "Retry-After",
    ],
  });

  // Cache-Control: no-store on every response. Requests land on tenant data
  // and caching in any intermediary is incorrect by default.
  fastify.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });

  // --- Validation ---------------------------------------------------------
  await fastify.register(bodyValidatePlugin);

  // --- Auth (must run before rate-limit so the per-tenant key generator can
  //          read `request.principal`). Failed-auth requests do not consume
  //          rate-limit tokens; that's intentional. ---
  await fastify.register(authPlugin, {
    resolver: opts.resolver,
    skipPaths: ["/health", "/ready"],
  });

  // --- Rate limit ---------------------------------------------------------
  await fastify.register(rateLimitPlugin, { limits: opts.rateLimits });
  const perClassLimits = buildRateLimitPluginOptions(opts.rateLimits);

  // --- Routes -------------------------------------------------------------
  await fastify.register(healthRoutes, {
    readinessChecks: opts.readinessChecks,
  });
  await fastify.register(eventsRoutes, {
    eventSink: opts.eventSink,
    idempotencyStore: opts.idempotencyStore,
    rateLimitOptions: perClassLimits.events,
  });
  await fastify.register(replayRoutes, {
    storage: opts.storage,
    signedUrlTtlSeconds: opts.signedUrlTtlSeconds,
    signedUrlRateLimit: perClassLimits.replay_signed_url,
    completeRateLimit: perClassLimits.replay_complete,
  });
  await fastify.register(sessionRoutes, {
    sessionSink: opts.sessionSink,
    rateLimitOptions: perClassLimits.session,
  });

  // --- Error handler ------------------------------------------------------
  fastify.setErrorHandler((error, request, reply) => {
    // TEMP Wave 7 round-6 diagnostic — prove setErrorHandler actually runs
    // and see the error's constructor name + prototype-chain shape.
    // eslint-disable-next-line no-console
    console.error(
      "[WAVE7-DIAG] setErrorHandler fired:",
      "name=", error.name,
      "ctor=", error.constructor?.name,
      "isValidation=", error instanceof ValidationError,
      "isUnauth=", error instanceof UnauthorizedError,
      "msg=", error.message
    );
    // Validation first — ajv-driven.
    if (error instanceof ValidationError) {
      reply.code(400).send({
        error: "invalid_request",
        message: "Request body failed schema validation.",
        details: { errors: error.errors },
      });
      return;
    }
    if (error instanceof UnauthorizedError) {
      reply.code(401).send({
        error: "unauthorized",
        message: error.message,
      });
      return;
    }
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      reply.code(error.statusCode).send({
        error: "bad_request",
        message: error.message,
      });
      return;
    }
    request.log.error({ err: error }, "unexpected server error");
    reply.code(500).send({
      error: "internal_error",
      message: "An internal server error occurred.",
    });
  });

  return fastify;
}
