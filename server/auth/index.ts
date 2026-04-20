/**
 * Auth subsystem public surface.
 */

export * from "./types.js";
export {
  LocalAuthProvider,
  createLocalAuthFromEnv,
} from "./local.js";
export type { LocalAuthOptions, LocalAuthUser } from "./local.js";
export {
  OidcAuthProvider,
  createOidcAuthFromEnv,
} from "./oidc.js";
export type {
  OidcAuthOptions,
  OidcClientLike,
} from "./oidc.js";

import { createLocalAuthFromEnv } from "./local.js";
import { createOidcAuthFromEnv } from "./oidc.js";
import { AuthConfigError, AuthProvider } from "./types.js";

/**
 * Build the default auth provider from environment variables. Reads
 * `AUTH_MODE` (`local` default, `oidc` alt) and dispatches to the
 * corresponding factory.
 */
export async function createAuthProvider(
  env: NodeJS.ProcessEnv = process.env
): Promise<AuthProvider> {
  const mode = env.AUTH_MODE ?? "local";
  switch (mode) {
    case "local":
      return createLocalAuthFromEnv(env);
    case "oidc":
      return createOidcAuthFromEnv(env);
    default:
      throw new AuthConfigError(
        `AUTH_MODE must be 'local' or 'oidc'; got '${mode}'`
      );
  }
}
