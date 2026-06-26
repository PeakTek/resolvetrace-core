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
  InMemoryAuditSink,
  InMemoryEventSink,
  InMemoryPurgeStore,
  InMemoryReplayManifestStore,
  InMemorySessionSink,
  InMemorySettingsRepository,
} from "../in-memory-sinks.js";
import { InMemoryIdempotencyStore } from "../plugins/idempotency.js";
import { MockResolver, MockStorage } from "./mocks.js";
import {
  AuditRepository,
  AuditSink,
  EventRepository,
  EventSink,
  PurgeStore,
  RateLimitBudget,
  RateLimitClass,
  ReadinessCheck,
  ReplayManifestStore,
  SessionRepository,
  SessionSink,
  SettingsRepository,
} from "../types.js";
import {
  loadRetentionConfig,
  type RetentionConfig,
} from "../retention-config.js";
import type {
  WebhookDispatchPolicy,
  WebhookHttpClient,
} from "../webhook-dispatch.js";
import type { AuthProvider } from "../../auth/index.js";

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
  /**
   * Audit sink. Defaults to a fresh `InMemoryAuditSink`. The same instance is
   * also used as the audit repository unless `auditRepository` is overridden.
   */
  auditSink?: AuditSink & AuditRepository;
  auditRepository?: AuditRepository;
  /** Settings store. Defaults to a fresh `InMemorySettingsRepository`. */
  settingsRepository?: SettingsRepository;
  /** Replay manifest store. Defaults to a fresh `InMemoryReplayManifestStore`. */
  replayManifestStore?: ReplayManifestStore;
  /** Purge store. Defaults to a fresh `InMemoryPurgeStore`. */
  purgeStore?: PurgeStore;
  /** Retention config. Defaults to env-loaded (all "keep forever" in tests). */
  retentionConfig?: RetentionConfig;
  authProvider?: AuthProvider;
  idempotencyStore?: InMemoryIdempotencyStore;
  readinessChecks?: ReadinessCheck[];
  rateLimits?: Partial<Record<RateLimitClass, RateLimitBudget>>;
  /** Webhook HTTP client double (feature #5). Defaults to fetch in production. */
  webhookHttpClient?: WebhookHttpClient;
  /** Webhook retry/backoff/timeout overrides (e.g. fast/no backoff in tests). */
  webhookDispatchPolicy?: Partial<WebhookDispatchPolicy>;
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
  const auditSink = overrides.auditSink ?? new InMemoryAuditSink();
  const auditRepository = overrides.auditRepository ?? auditSink;
  const settingsRepository =
    overrides.settingsRepository ?? new InMemorySettingsRepository();
  // Default the manifest store + purge store to a linked pair so an
  // integration test (complete -> purge) sees the manifest's exact keys via
  // the purge store. A test that supplies either one explicitly opts out.
  const replayManifestStore =
    overrides.replayManifestStore ?? new InMemoryReplayManifestStore();
  const purgeStore =
    overrides.purgeStore ??
    new InMemoryPurgeStore(
      replayManifestStore instanceof InMemoryReplayManifestStore
        ? replayManifestStore
        : undefined
    );
  // Default to a config loaded from an empty env: every window is "keep
  // forever" (0), so a purge in an un-configured test is a no-op unless the
  // test passes its own config or seeds + overrides windows.
  const retentionConfig =
    overrides.retentionConfig ?? loadRetentionConfig({} as NodeJS.ProcessEnv);
  const idempotencyStore =
    overrides.idempotencyStore ?? new InMemoryIdempotencyStore();

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
    authProvider: overrides.authProvider,
    idempotencyStore,
    readinessChecks: overrides.readinessChecks,
    rateLimits: overrides.rateLimits,
    webhookHttpClient: overrides.webhookHttpClient,
    webhookDispatchPolicy: overrides.webhookDispatchPolicy,
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
    auditSink,
    auditRepository,
    settingsRepository,
    replayManifestStore,
    purgeStore,
    retentionConfig,
    idempotencyStore,
  };
}
