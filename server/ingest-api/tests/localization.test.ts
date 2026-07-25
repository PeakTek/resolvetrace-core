/**
 * Portal localization settings route (GET/PUT /api/v1/portal/settings/localization).
 *
 * Admin-gated (tenant:admin). Backed by an injected TenantLocaleStore; absent ⇒
 * read-only defaults (GET editable:false, PUT 501). Validates BCP-47 locale +
 * IANA timezone. Writes a `settings.update` audit row.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTestApp } from "../test-utils/build-test-app.js";
import { MockResolver } from "../test-utils/mocks.js";
import { InMemoryAuditSink } from "../in-memory-sinks.js";
import { AuditAction } from "../audit.js";
import { AUTH_HEADER } from "../test-utils/fixtures.js";
import type { TenantLocale, TenantLocaleStore } from "../types.js";

const TENANT = "oss-test-tenant";

/** In-memory tenant-locale store; records set() calls via a closure. */
function fakeStore(initial?: TenantLocale): {
  store: TenantLocaleStore;
  sets: TenantLocale[];
} {
  let value: TenantLocale | null = initial ?? null;
  const sets: TenantLocale[] = [];
  const store: TenantLocaleStore = {
    async get() {
      return value;
    },
    async set(_tenantId, v) {
      value = v;
      sets.push(v);
    },
  };
  return { store, sets };
}

describe("GET /api/v1/portal/settings/localization", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("returns defaults + editable:false when no store is injected", async () => {
    const { app } = await buildTestApp({});
    close = () => app.close();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/portal/settings/localization",
      headers: { authorization: AUTH_HEADER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      localization: { locale: "en-US", timezone: "UTC" },
      editable: false,
    });
  });

  it("returns the stored value + editable:true when a store is injected", async () => {
    const { app } = await buildTestApp({
      tenantLocaleStore: fakeStore({
        locale: "en-GB",
        timezone: "Europe/London",
      }).store,
    });
    close = () => app.close();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/portal/settings/localization",
      headers: { authorization: AUTH_HEADER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      localization: { locale: "en-GB", timezone: "Europe/London" },
      editable: true,
    });
  });

  it("403s a viewer (no tenant:admin scope)", async () => {
    const resolver = new MockResolver({ scopes: ["events:write"] });
    const { app } = await buildTestApp({ resolver });
    close = () => app.close();
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/portal/settings/localization",
      headers: { authorization: AUTH_HEADER },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("PUT /api/v1/portal/settings/localization", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("persists a valid locale + timezone, audits it, returns updated", async () => {
    const store = fakeStore();
    const auditSink = new InMemoryAuditSink();
    const { app } = await buildTestApp({
      tenantLocaleStore: store.store,
      auditSink,
    });
    close = () => app.close();

    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/portal/settings/localization",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: { locale: "fr-FR", timezone: "America/New_York" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().localization).toEqual({
      locale: "fr-FR",
      timezone: "America/New_York",
    });
    expect(store.sets).toEqual([
      { locale: "fr-FR", timezone: "America/New_York" },
    ]);
    expect(
      auditSink.all(TENANT).some((r) => r.action === AuditAction.SETTINGS_UPDATE)
    ).toBe(true);
  });

  it("rejects an invalid locale (400)", async () => {
    const { app } = await buildTestApp({ tenantLocaleStore: fakeStore().store });
    close = () => app.close();
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/portal/settings/localization",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: { locale: "@@bad" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an invalid IANA timezone (400)", async () => {
    const { app } = await buildTestApp({ tenantLocaleStore: fakeStore().store });
    close = () => app.close();
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/portal/settings/localization",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: { timezone: "Not/AZone" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("501s when no store is injected (not editable)", async () => {
    const { app } = await buildTestApp({});
    close = () => app.close();
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/portal/settings/localization",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: { locale: "en-GB" },
    });
    expect(res.statusCode).toBe(501);
  });

  it("403s a viewer", async () => {
    const resolver = new MockResolver({ scopes: ["events:write"] });
    const setSpy = vi.fn();
    const store = { get: async () => null, set: setSpy };
    const { app } = await buildTestApp({ resolver, tenantLocaleStore: store });
    close = () => app.close();
    const res = await app.inject({
      method: "PUT",
      url: "/api/v1/portal/settings/localization",
      headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
      payload: { locale: "en-GB" },
    });
    expect(res.statusCode).toBe(403);
    expect(setSpy).not.toHaveBeenCalled();
  });
});
