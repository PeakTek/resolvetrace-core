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
import { portalRoutes } from "./routes/portal.js";
import { portalAuthRoutes } from "./routes/portal-auth.js";
import { retentionRoutes } from "./routes/retention.js";

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

  // --- Error handler ------------------------------------------------------
  // Registered BEFORE plugins and routes so that encapsulated scopes inherit
  // this handler (Fastify captures the parent scope's error handler at plugin
  // registration time; setting it later means the scopes keep the default).
  fastify.setErrorHandler((error, request, reply) => {
    const anyErr = error as unknown as Record<string, unknown>;

    // Rate-limit errors come through as the plain object returned by
    // plugins/rate-limit.ts's errorResponseBuilder — @fastify/rate-limit v9
    // throws that value directly, so it has no Error prototype, no
    // statusCode, and no name. Match on the discriminant field.
    if (anyErr["error"] === "rate_limit_exceeded") {
      reply.code(429).send(anyErr);
      return;
    }

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
    // v5 narrows `error` to `FastifyError` whose indexable fields are
    // typed loosely; reach through the object-view we already built for
    // the rate-limit branch to stay lint-clean across v4 + v5.
    const statusCode =
      typeof anyErr["statusCode"] === "number"
        ? (anyErr["statusCode"] as number)
        : undefined;
    const errMessage =
      typeof anyErr["message"] === "string" ? (anyErr["message"] as string) : "";
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      reply.code(statusCode).send({
        error: "bad_request",
        message: errMessage,
      });
      return;
    }
    request.log.error({ err: error }, "unexpected server error");
    reply.code(500).send({
      error: "internal_error",
      message: "An internal server error occurred.",
    });
  });

  // --- Global security headers / CORS -------------------------------------
  await fastify.register(helmet, {
    // Permissive CSP at the ingest surface — no HTML served from here.
    contentSecurityPolicy: false,
  });
  const origins = opts.corsOrigins ?? [];
  await fastify.register(cors, {
    origin: origins.length === 0 ? true : origins,
    methods: ["POST", "GET", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Authorization",
      "Content-Type",
      "Cache-Control",
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
    // Portal-auth routes are identity-first (the user authenticates before any
    // tenant is chosen), so they carry no tenant bearer and skip the resolver.
    // They authenticate the user themselves (credentials / identity token).
    skipPaths: [
      "/health",
      "/ready",
      "/api/v1/portal/auth/config",
      "/api/v1/portal/auth/login",
      "/api/v1/portal/auth/tenant-select",
      "/api/v1/portal/auth/session",
      "/api/v1/portal/auth/logout",
    ],
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
    // Webhook dispatch on `support.report_submitted` (feature #5).
    settingsRepository: opts.settingsRepository,
    auditSink: opts.auditSink,
    webhookHttpClient: opts.webhookHttpClient,
    webhookDispatchPolicy: opts.webhookDispatchPolicy,
  });
  await fastify.register(replayRoutes, {
    storage: opts.storage,
    replayManifestStore: opts.replayManifestStore,
    settingsRepository: opts.settingsRepository,
    replayUploadGuard: opts.replayUploadGuard,
    signedUrlTtlSeconds: opts.signedUrlTtlSeconds,
    signedUrlRateLimit: perClassLimits.replay_signed_url,
    completeRateLimit: perClassLimits.replay_complete,
  });
  await fastify.register(sessionRoutes, {
    sessionSink: opts.sessionSink,
    rateLimitOptions: perClassLimits.session,
  });
  await fastify.register(portalRoutes, {
    sessionRepository: opts.sessionRepository,
    eventRepository: opts.eventRepository,
    auditSink: opts.auditSink,
    auditRepository: opts.auditRepository,
    replayManifestStore: opts.replayManifestStore,
    storage: opts.storage,
    rateLimitOptions: perClassLimits.session,
  });
  // Retention settings + purge + targeted-deletion surface (admin-only).
  await fastify.register(retentionRoutes, {
    purgeStore: opts.purgeStore,
    storage: opts.storage,
    settingsRepository: opts.settingsRepository,
    auditSink: opts.auditSink,
    retentionConfig: opts.retentionConfig,
    rateLimitOptions: perClassLimits.session,
    // Webhook settings + "send test" action (feature #5).
    webhookHttpClient: opts.webhookHttpClient,
    webhookDispatchPolicy: opts.webhookDispatchPolicy,
  });
  // The portal-auth contract is only meaningful when an auth provider is wired.
  if (opts.authProvider) {
    await fastify.register(portalAuthRoutes, {
      authProvider: opts.authProvider,
      auditSink: opts.auditSink,
      membershipProvider: opts.membershipProvider,
      tenantCredentialMinter: opts.tenantCredentialMinter,
      portalTokenSecret: opts.portalTokenSecret,
      defaultPortalTenant: opts.defaultPortalTenant,
      portalAuthConfig: opts.portalAuthConfig,
      rateLimitOptions: perClassLimits.session,
    });
  }

  return fastify;
}
