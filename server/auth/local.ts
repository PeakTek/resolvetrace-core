/**
 * Local username/password auth provider.
 *
 * OSS scaffolding ships with a single admin user sourced from the
 * `OSS_ADMIN_USERNAME` + `OSS_ADMIN_PASSWORD_HASH` env vars. The password
 * is checked with bcrypt. No disk-backed user store in this skeleton; a
 * future milestone can introduce one without changing this interface.
 */

import bcrypt from "bcrypt";
import {
  AuthConfigError,
  AuthPrincipal,
  AuthProvider,
  LocalCredentials,
} from "./types.js";

export interface LocalAuthUser {
  username: string;
  /** bcrypt hash (e.g. `$2b$10$...`). */
  passwordHash: string;
  email?: string;
  roles?: string[];
}

export interface LocalAuthOptions {
  users: LocalAuthUser[];
}

export class LocalAuthProvider implements AuthProvider {
  private readonly users: Map<string, LocalAuthUser>;

  constructor(opts: LocalAuthOptions) {
    if (opts.users.length === 0) {
      throw new AuthConfigError(
        "LocalAuthProvider requires at least one configured user"
      );
    }
    this.users = new Map(opts.users.map((u) => [u.username, u]));
  }

  async verifyCredentials(
    input: LocalCredentials
  ): Promise<AuthPrincipal | null> {
    const user = this.users.get(input.username);
    if (!user) {
      // Run a dummy bcrypt compare to keep timing roughly constant between
      // the unknown-user branch and the wrong-password branch.
      await bcrypt.compare(input.password, DUMMY_HASH);
      return null;
    }
    const ok = await bcrypt.compare(input.password, user.passwordHash);
    if (!ok) {
      return null;
    }
    return {
      userId: `local:${user.username}`,
      email: user.email ?? user.username,
      roles: user.roles ?? ["admin"],
    };
  }
}

/**
 * Build a `LocalAuthProvider` from the standard OSS env vars.
 * `OSS_ADMIN_USERNAME` + `OSS_ADMIN_PASSWORD_HASH` are required.
 */
export function createLocalAuthFromEnv(
  env: NodeJS.ProcessEnv = process.env
): LocalAuthProvider {
  const username = env.OSS_ADMIN_USERNAME;
  const passwordHash = env.OSS_ADMIN_PASSWORD_HASH;
  if (!username || !passwordHash) {
    throw new AuthConfigError(
      "Local auth requires OSS_ADMIN_USERNAME and OSS_ADMIN_PASSWORD_HASH"
    );
  }
  return new LocalAuthProvider({
    users: [
      {
        username,
        passwordHash,
        email: env.OSS_ADMIN_EMAIL,
        roles: ["admin"],
      },
    ],
  });
}

/**
 * A stable bcrypt hash used for timing-equalizing the unknown-user branch
 * of `verifyCredentials`. The cleartext is irrelevant; the hash is never
 * expected to match anything real.
 */
const DUMMY_HASH =
  "$2b$10$0000000000000000000000uCrSUvuW5qMxTKZLuOeeNK1/fbrcnea";
