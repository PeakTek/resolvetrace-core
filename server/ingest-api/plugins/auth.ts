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
  InvalidApiKeyError,
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
      if (
        err instanceof InvalidApiKeyError ||
        err instanceof TenantResolverError
      ) {
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
  fastify: "4.x",
});
