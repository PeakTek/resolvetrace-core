/**
 * Env-var backed secrets provider.
 *
 * The default OSS adapter. Secret names map 1-to-1 to environment variable
 * names; missing values raise `SecretNotFoundError`.
 */

import {
  SecretDecodeError,
  SecretNotFoundError,
  SecretsProvider,
} from "./types.js";

export interface EnvSecretsOptions {
  /** The env dictionary to read from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export class EnvSecretsProvider implements SecretsProvider {
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: EnvSecretsOptions = {}) {
    this.env = opts.env ?? process.env;
  }

  async get(name: string): Promise<string> {
    const value = this.env[name];
    if (value === undefined || value === "") {
      throw new SecretNotFoundError(name);
    }
    return value;
  }

  async getJson<T = unknown>(name: string): Promise<T> {
    const raw = await this.get(name);
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      throw new SecretDecodeError(name, err);
    }
  }
}
