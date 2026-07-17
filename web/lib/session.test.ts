import { describe, expect, it } from "vitest";
import {
  buildSession,
  openSession,
  publicView,
  sealSession,
  type PortalSession,
} from "./session";

const base: Omit<PortalSession, "exp"> = {
  sub: "sub-1",
  email: "u@x.test",
  roles: ["admin"],
  tenants: [
    { id: "t-A", displayName: "Acme" },
    { id: "t-B", displayName: "Beta" },
  ],
  currentTenantId: "t-A",
  role: "admin",
  scopes: ["session:read", "audit:read", "tenant:admin"],
  identityToken: "id-token-secret",
  ingestBearer: "rt_live_secret_key",
  ingestBearerExp: 9_999_999_999_000,
};

describe("portal session seal/open", () => {
  it("round-trips a sealed session", async () => {
    const s = buildSession(base);
    const opened = await openSession(await sealSession(s));
    expect(opened).toEqual(s);
  });

  it("returns null for a tampered cookie (GCM auth fails)", async () => {
    const sealed = await sealSession(buildSession(base));
    const tampered = (sealed[0] === "A" ? "B" : "A") + sealed.slice(1);
    expect(await openSession(tampered)).toBeNull();
  });

  it("returns null for an expired session", async () => {
    const expired: PortalSession = { ...base, exp: Date.now() - 1000 };
    expect(await openSession(await sealSession(expired))).toBeNull();
  });

  it("returns null for garbage / empty input", async () => {
    expect(await openSession("not-a-real-cookie")).toBeNull();
    expect(await openSession("")).toBeNull();
  });

  it("publicView strips every secret field", () => {
    const view = publicView(buildSession(base));
    expect(view).not.toHaveProperty("ingestBearer");
    expect(view).not.toHaveProperty("identityToken");
    expect(view).not.toHaveProperty("ingestBearerExp");
    expect(view).not.toHaveProperty("exp");
    expect(view.email).toBe("u@x.test");
    expect(view.tenants).toHaveLength(2);
    expect(view.scopes).toContain("tenant:admin");
  });
});
