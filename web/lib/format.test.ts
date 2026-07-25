import { describe, expect, it } from "vitest";
import { formatDateTime, formatTenantTime, formatSupportCode } from "./format";

// A fixed instant: 2026-07-24T18:05:00Z.
const ISO = "2026-07-24T18:05:00.000Z";

describe("formatDateTime", () => {
  it("renders an exact date-time in an explicit locale + timezone", () => {
    // en-US, New York (EDT = UTC-4) → 2:05 PM.
    const s = formatDateTime(ISO, {
      locale: "en-US",
      timeZone: "America/New_York",
    });
    expect(s).toMatch(/Jul 24, 2026/);
    expect(s).toMatch(/2:05\s?PM/);
  });

  it("is deterministic across timezones — the explicit timeZone wins", () => {
    // Same instant, Tokyo (UTC+9) → next-day 03:05, 24h via en-GB.
    const tokyo = formatDateTime(ISO, {
      locale: "en-GB",
      timeZone: "Asia/Tokyo",
    });
    expect(tokyo).toMatch(/25 Jul 2026/);
    expect(tokyo).toMatch(/03:05/);
  });

  it("defaults to en-US / UTC when unset", () => {
    const s = formatDateTime(ISO);
    expect(s).toMatch(/Jul 24, 2026/);
    expect(s).toMatch(/6:05\s?PM/); // 18:05 UTC
  });

  it("falls back to defaults on an invalid locale/timeZone (never throws)", () => {
    const s = formatDateTime(ISO, { locale: "@@@", timeZone: "Not/AZone" });
    expect(s).toMatch(/Jul 24, 2026/); // en-US/UTC fallback
  });

  it("returns the raw input for an unparseable date", () => {
    expect(formatDateTime("not-a-date")).toBe("not-a-date");
  });
});

describe("formatTenantTime", () => {
  const session = {
    currentTenantId: "t1",
    tenants: [
      { id: "t0", locale: "en-GB", timezone: "Asia/Tokyo" },
      { id: "t1", locale: "en-US", timezone: "America/New_York" },
    ],
  };

  it("formats using the CURRENT tenant's locale + timezone", () => {
    const s = formatTenantTime(session, ISO);
    expect(s).toMatch(/Jul 24, 2026/);
    expect(s).toMatch(/2:05\s?PM/); // New York, en-US
  });

  it("falls back to en-US / UTC when the tenant has no locale/timezone", () => {
    const s = formatTenantTime(
      { currentTenantId: "t1", tenants: [{ id: "t1" }] },
      ISO
    );
    expect(s).toMatch(/6:05\s?PM/); // UTC
  });

  it("handles a null session", () => {
    const s = formatTenantTime(null, ISO);
    expect(s).toMatch(/Jul 24, 2026/);
  });
});

describe("formatSupportCode", () => {
  it("splits an 8-char code into two groups", () => {
    expect(formatSupportCode("ABCD1234")).toBe("ABCD-1234");
    expect(formatSupportCode("SHORT")).toBe("SHORT");
  });
});
