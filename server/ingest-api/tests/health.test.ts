import { afterEach, describe, expect, it } from "vitest";
import { buildTestApp } from "../test-utils/build-test-app.js";

describe("GET /health", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("returns 200 unconditionally", async () => {
    const { app } = await buildTestApp();
    close = () => app.close();

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("does not require authentication", async () => {
    const { app } = await buildTestApp();
    close = () => app.close();

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });
});

describe("GET /ready", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("returns 200 when all readiness checks pass", async () => {
    const { app } = await buildTestApp({
      readinessChecks: [
        { name: "fake-db", async check() { return true; } },
        { name: "fake-storage", async check() { return true; } },
      ],
    });
    close = () => app.close();

    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });

  it("returns 503 when any readiness check fails", async () => {
    const { app } = await buildTestApp({
      readinessChecks: [
        { name: "fake-db", async check() { return false; } },
        { name: "fake-storage", async check() { return true; } },
      ],
    });
    close = () => app.close();

    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe("degraded");
    expect(body.checks.find((c: { name: string }) => c.name === "fake-db")?.ok)
      .toBe(false);
  });

  it("treats throwing readiness checks as failure (returns 503)", async () => {
    const { app } = await buildTestApp({
      readinessChecks: [
        {
          name: "throws",
          async check() {
            throw new Error("boom");
          },
        },
      ],
    });
    close = () => app.close();

    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
  });
});
