/**
 * Liveness and readiness probes.
 *
 * `GET /health` — always 200 if the process is alive. No auth.
 * `GET /ready` — 200 iff every configured readiness check returns true;
 *   503 otherwise. No auth.
 */

import { FastifyPluginAsync } from "fastify";
import { ReadinessCheck } from "../types.js";

export interface HealthRoutesOptions {
  readinessChecks?: ReadinessCheck[];
}

export const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (
  fastify,
  opts
) => {
  const checks = opts.readinessChecks ?? [];

  fastify.get("/health", async () => ({ status: "ok" }));

  fastify.get("/ready", async (_request, reply) => {
    const results = await Promise.all(
      checks.map(async (c) => {
        try {
          const ok = await c.check();
          return { name: c.name, ok };
        } catch {
          return { name: c.name, ok: false };
        }
      })
    );
    const allOk = results.every((r) => r.ok);
    if (!allOk) {
      reply.code(503);
      return {
        status: "degraded",
        checks: results,
      };
    }
    return { status: "ok", checks: results };
  });
};
