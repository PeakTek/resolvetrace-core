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
  EventSink,
  RateLimitBudget,
  RateLimitClass,
  ReadinessCheck,
  SessionRepository,
  SessionSink,
} from "../types.js";

export interface TestAppOverrides<
  ES extends EventSink = InMemoryEventSink,
  SS extends SessionSink = InMemorySessionSink,
> {
  storage?: MockStorage;
  resolver?: MockResolver;
  /**
   * Event sink. Defaults to a fresh `InMemoryEventSink`. Tests that need
   * strict-mode session resolution can pass a `PostgresEventSink` backed by
   * a fake `PgPool` here.
   */
  eventSink?: ES;
  /** Session sink. Defaults to a fresh `InMemorySessionSink`. */
  sessionSink?: SS;
  sessionRepository?: SessionRepository;
  eventRepository?: EventRepository;
  idempotencyStore?: InMemoryIdempotencyStore;
  readinessChecks?: ReadinessCheck[];
  rateLimits?: Partial<Record<RateLimitClass, RateLimitBudget>>;
}

export async function buildTestApp<
  ES extends EventSink = InMemoryEventSink,
  SS extends SessionSink = InMemorySessionSink,
>(overrides: TestAppOverrides<ES, SS> = {}) {
  const storage = overrides.storage ?? new MockStorage();
  const resolver = overrides.resolver ?? new MockResolver();
  const eventSink = (overrides.eventSink ??
    (new InMemoryEventSink() as unknown as ES)) as ES;
  const sessionSink = (overrides.sessionSink ??
    (new InMemorySessionSink() as unknown as SS)) as SS;
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
