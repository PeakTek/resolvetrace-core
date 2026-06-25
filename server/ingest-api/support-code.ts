/**
 * Per-session support code: a short, human-shareable identifier minted by
 * the server on `/v1/session/start`. The SDK surfaces it for
 * "Support code: XXXXXXXX" display and the portal resolves a code back to
 * its session.
 *
 * Format (mirrors the contract's `SessionStartResponse.supportCode`,
 * pattern `^[0-9A-HJKMNP-TV-Z]{8}$`): 8 characters of Crockford base32,
 * uppercase canonical, drawn from a cryptographically secure source so the
 * value is non-sequential and hard to guess.
 */

import { randomBytes } from "node:crypto";

/**
 * Crockford base32 alphabet — the standard base32 set with the ambiguous
 * letters I, L, O, U removed. Index = symbol value (0..31).
 */
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Canonical support-code length. */
export const SUPPORT_CODE_LENGTH = 8;

/** Matches the contract pattern for a canonical (uppercase) support code. */
export const SUPPORT_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/**
 * Generate a fresh 8-char Crockford base32 support code from a CSPRNG.
 *
 * Each character is an independent uniform draw over the 32-symbol alphabet.
 * We over-sample random bytes and reject values that would bias the modulo
 * (rejection sampling) so every symbol is equally likely.
 */
export function generateSupportCode(): string {
  let out = "";
  while (out.length < SUPPORT_CODE_LENGTH) {
    // Pull a generous chunk so we rarely need a second syscall even after
    // discarding biased bytes.
    const buf = randomBytes(SUPPORT_CODE_LENGTH);
    for (let i = 0; i < buf.length && out.length < SUPPORT_CODE_LENGTH; i++) {
      const byte = buf[i]!;
      // 256 is not a multiple of 32; bytes >= 256 would skew the
      // distribution. 256 % 32 === 0, so every byte maps cleanly — no
      // rejection needed, but keep the guard explicit for clarity.
      out += CROCKFORD_ALPHABET[byte % CROCKFORD_ALPHABET.length];
    }
  }
  return out;
}

/**
 * Normalize user-entered input into the canonical storage form for lookup.
 *
 * - Uppercase.
 * - Strip spaces and dashes (the portal may display the code as `XXXX-XXXX`).
 * - Map the Crockford look-alikes for lenient entry: I/L -> 1, O -> 0.
 *
 * Returns the normalized string (which may not be a valid code — callers
 * should validate with {@link SUPPORT_CODE_PATTERN} before querying).
 */
export function normalizeSupportCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

/** True when `code` is a canonical 8-char Crockford support code. */
export function isValidSupportCode(code: string): boolean {
  return SUPPORT_CODE_PATTERN.test(code);
}
