/**
 * Secrets provider abstraction.
 *
 * Configuration values that are sensitive (database credentials, signing
 * keys, API keys, OIDC client secrets) travel through this interface. The
 * OSS server ships two adapters:
 *
 * - `EnvSecretsProvider` — reads from `process.env`. Suitable for
 *   Docker Compose, systemd units, and other "feed it env vars" setups.
 * - `ParameterStoreSecretsProvider` — reads from AWS Systems Manager
 *   Parameter Store. Useful when self-hosting on AWS and you already
 *   have parameters there.
 */

export interface SecretsProvider {
  /** Fetch a secret as a plain string. */
  get(name: string): Promise<string>;
  /** Fetch a secret whose value is JSON and parse it. */
  getJson<T = unknown>(name: string): Promise<T>;
}

export class SecretNotFoundError extends Error {
  constructor(name: string) {
    super(`Secret not found: ${name}`);
    this.name = "SecretNotFoundError";
  }
}

export class SecretDecodeError extends Error {
  constructor(name: string, cause?: unknown) {
    super(`Failed to decode secret '${name}' as JSON`);
    this.name = "SecretDecodeError";
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}
