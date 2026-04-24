/**
 * Test helper — build a Fastify instance wired to in-memory mocks.
 *
 * Tests use `app.inject(...)` for all request execution; no TCP listener
 * is opened.
 */

import { buildApp } from "../app.js";
import {
  EmptyEventRepository,
  EmptySessionRepository,
  InMemoryEventSink,
  InMemorySessionSink,
} from "../in-memory-sinks.js";
import { InMemoryIdempotencyStore } from "../plugins/idempotency.js";
import { MockResolver, MockStorage } from "./mocks.js";
import {
  EventRepository,
  RateLimitBudget,
  RateLimitClass,
  ReadinessCheck,
  SessionRepository,
} from "../types.js";

export interface TestAppOverrides {
  storage?: MockStorage;
  resolver?: MockResolver;
  eventSink?: InMemoryEventSink;
  sessionSink?: InMemorySessionSink;
  sessionRepository?: SessionRepository;
  eventRepository?: EventRepository;
  idempotencyStore?: InMemoryIdempotencyStore;
  readinessChecks?: ReadinessCheck[];
  rateLimits?: Partial<Record<RateLimitClass, RateLimitBudget>>;
}

export async function buildTestApp(overrides: TestAppOverrides = {}) {
  const storage = overrides.storage ?? new MockStorage();
  const resolver = overrides.resolver ?? new MockResolver();
  const eventSink = overrides.eventSink ?? new InMemoryEventSink();
  const sessionSink = overrides.sessionSink ?? new InMemorySessionSink();
  const sessionRepository =
    overrides.sessionRepository ?? new EmptySessionRepository();
  const eventRepository =
    overrides.eventRepository ?? new EmptyEventRepository();
  const idempotencyStore =
    overrides.idempotencyStore ?? new InMemoryIdempotencyStore();

  const app = await buildApp({
    resolver,
    storage,
    eventSink,
    sessionSink,
    sessionRepository,
    eventRepository,
    idempotencyStore,
    readinessChecks: overrides.readinessChecks,
    rateLimits: overrides.rateLimits,
    disableRequestLogging: true,
  });

  return {
    app,
    storage,
    resolver,
    eventSink,
    sessionSink,
    sessionRepository,
    eventRepository,
    idempotencyStore,
  };
}
