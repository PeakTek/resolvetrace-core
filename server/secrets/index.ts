/**
 * Secrets subsystem public surface.
 */

export * from "./types.js";
export { EnvSecretsProvider } from "./env.js";
export type { EnvSecretsOptions } from "./env.js";
export { ParameterStoreSecretsProvider } from "./parameter-store.js";
export type {
  ParameterStoreOptions,
  SsmClientLike,
} from "./parameter-store.js";

import { EnvSecretsProvider } from "./env.js";
import { ParameterStoreSecretsProvider } from "./parameter-store.js";
import { SecretsProvider } from "./types.js";

/**
 * Build the default secrets provider from env vars. Reads `SECRETS_MODE`
 * (`env` default, `parameter-store` alt).
 *
 * When `SECRETS_MODE=parameter-store`, also respects:
 * - `AWS_REGION` — required
 * - `SSM_PARAMETER_PREFIX` — optional prefix prepended to every name
 * - `SSM_CACHE_TTL_MS` — optional cache TTL (default 60_000)
 */
export function createSecretsProvider(
  env: NodeJS.ProcessEnv = process.env
): SecretsProvider {
  const mode = env.SECRETS_MODE ?? "env";
  switch (mode) {
    case "env":
      return new EnvSecretsProvider({ env });
    case "parameter-store": {
      const region = env.AWS_REGION;
      if (!region) {
        throw new Error(
          "SECRETS_MODE=parameter-store requires AWS_REGION to be set"
        );
      }
      const ttl = env.SSM_CACHE_TTL_MS
        ? Number.parseInt(env.SSM_CACHE_TTL_MS, 10)
        : undefined;
      return new ParameterStoreSecretsProvider({
        region,
        prefix: env.SSM_PARAMETER_PREFIX,
        cacheTtlMs: ttl,
      });
    }
    default:
      throw new Error(
        `SECRETS_MODE must be 'env' or 'parameter-store'; got '${mode}'`
      );
  }
}
