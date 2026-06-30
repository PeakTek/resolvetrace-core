/**
 * Auth plugin — extracts `Authorization: Bearer <key>` and attaches the
 * resolved principal onto the request.
 *
 * The resolver is pluggable: in OSS it's a simple constant-time key compare
 * via `SingleTenantResolver`; alternate deployment shapes swap in a
 * different `TenantConfigResolver` without handler changes.
 *
 * Routes whose path is `/health` or `/ready` skip authentication entirely.
 */

import { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import {
  ApiKeyPrincipal,
  TenantConfigResolver,
  TenantResolverError,
} from "../../tenant-resolver/index.js";

declare module "fastify" {
  interface FastifyRequest {
    principal: ApiKeyPrincipal | null;
  }
}

/** Thrown for any auth failure; caught and rendered as 401 by the error handler. */
export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * True when `err` is (or duck-types as) a resolver-layer auth failure that
 * must render as 401.
 *
 * The resolver is pluggable: a composing deployment can supply one from a
 * separate package that carries its OWN copy of the `TenantResolverError`
 * classes — e.g. a vendored types module kept byte-identical by a drift gate.
 * Such a copy is structurally identical but has a DISTINCT class identity, so a
 * plain `instanceof` against this module's class returns false and the auth
 * failure would otherwise escape to the generic 500 handler. We keep
 * `instanceof` as the same-realm fast path and fall back to matching the stable
 * `TenantResolverError` constructor name anywhere on the prototype chain, which
 * also covers every subclass (`InvalidApiKeyError`, tenant-not-found,
 * suspended/offboarding, …) regardless of which realm minted it.
 */
function isTenantResolverError(err: unknown): boolean {
  if (err instanceof TenantResolverError) return true;
  if (typeof err !== "object" || err === null) return false;
  for (
    let proto: object | null = err;
    proto !== null;
    proto = Object.getPrototypeOf(proto) as object | null
  ) {
    const ctor = (proto as { constructor?: { name?: string } }).constructor;
    if (ctor?.name === "TenantResolverError") return true;
  }
  return false;
}

export interface AuthPluginOptions {
  resolver: TenantConfigResolver;
  /** Routes to skip entirely. Defaults to `/health` and `/ready`. */
  skipPaths?: string[];
}

const authPluginImpl: FastifyPluginAsync<AuthPluginOptions> = async (
  fastify,
  opts
) => {
  const skip = new Set(opts.skipPaths ?? ["/health", "/ready"]);

  fastify.decorateRequest("principal", null);
  fastify.addHook("onRequest", async (request: FastifyRequest) => {
    if (skip.has(request.url.split("?")[0] ?? "")) {
      return;
    }
    const header = request.headers.authorization;
    if (!header) {
      throw new UnauthorizedError("Missing Authorization header");
    }
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || !match[1]) {
      throw new UnauthorizedError("Malformed Authorization header");
    }
    const apiKey = match[1].trim();
    if (apiKey.length === 0) {
      throw new UnauthorizedError("Empty API key");
    }
    try {
      request.principal = await opts.resolver.resolveByApiKey(apiKey);
    } catch (err) {
      if (isTenantResolverError(err)) {
        throw new UnauthorizedError("Invalid API key");
      }
      throw err;
    }
  });
};

// Wrap with fastify-plugin so the onRequest auth hook + `principal` decorator
// apply to routes registered in the parent scope.
export const authPlugin = fp(authPluginImpl, {
  name: "auth",
  fastify: "5.x",
});
