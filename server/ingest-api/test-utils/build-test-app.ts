/**
 * Test helper — build a Fastify instance wired to in-memory mocks.
 *
 * Tests use `app.inject(...)` for all request execution; no TCP listener
 * is opened.
 */

import { buildApp } from "../app.js";
import {
  InMemoryEventSink,
  InMemorySessionSink,
} from "../in-memory-sinks.js";
import { InMemoryIdempotencyStore } from "../plugins/idempotency.js";
import { MockResolver, MockStorage } from "./mocks.js";
import { ReadinessCheck, RateLimitBudget, RateLimitClass } from "../types.js";

export interface TestAppOverrides {
  storage?: MockStorage;
  resolver?: MockResolver;
  eventSink?: InMemoryEventSink;
  sessionSink?: InMemorySessionSink;
  idempotencyStore?: InMemoryIdempotencyStore;
  readinessChecks?: ReadinessCheck[];
  rateLimits?: Partial<Record<RateLimitClass, RateLimitBudget>>;
}

export async function buildTestApp(overrides: TestAppOverrides = {}) {
  const storage = overrides.storage ?? new MockStorage();
  const resolver = overrides.resolver ?? new MockResolver();
  const eventSink = overrides.eventSink ?? new InMemoryEventSink();
  const sessionSink = overrides.sessionSink ?? new InMemorySessionSink();
  const idempotencyStore =
    overrides.idempotencyStore ?? new InMemoryIdempotencyStore();

  const app = await buildApp({
    resolver,
    storage,
    eventSink,
    sessionSink,
    idempotencyStore,
    readinessChecks: overrides.readinessChecks,
    rateLimits: overrides.rateLimits,
    // TEMPORARY — was `disableRequestLogging: true`; flipped to capture the
    // server-side error behind the 23 route 500s. Will restore in a follow-up.
    disableRequestLogging: false,
    logLevel: "error",
  });

  return {
    app,
    storage,
    resolver,
    eventSink,
    sessionSink,
    idempotencyStore,
  };
}
