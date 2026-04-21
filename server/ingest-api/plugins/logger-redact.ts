/**
 * Pino serializers and redactors that keep the bearer token out of logs.
 *
 * Exposed as a config object rather than a plugin because Fastify wants the
 * logger configuration at construction time.
 *
 * Redaction policy:
 *  - `Authorization` header → `Bearer [REDACTED:<first 6 chars>]`
 *  - `cookie` header → `[REDACTED]`
 */

export interface LoggerRedactOptions {
  level?: string;
}

/** Format the Authorization header for log output. */
export function formatAuthHeader(value: string | undefined): string {
  if (!value) return "[MISSING]";
  const m = /^Bearer\s+(.+)$/i.exec(value);
  if (!m || !m[1]) return "[MALFORMED]";
  const token = m[1].trim();
  const prefix = token.slice(0, 6);
  return `Bearer [REDACTED:${prefix}]`;
}

export function buildLoggerOptions(opts: LoggerRedactOptions = {}) {
  return {
    level: opts.level ?? process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: [
        'req.headers["authorization"]',
        'req.headers["Authorization"]',
        'req.headers.cookie',
        'req.headers.Cookie',
      ],
      censor: "[REDACTED]",
    },
    serializers: {
      req(request: {
        method: string;
        url: string;
        headers: Record<string, string | string[] | undefined>;
      }) {
        const auth = request.headers["authorization"];
        const flattenedAuth = Array.isArray(auth) ? auth[0] : auth;
        return {
          method: request.method,
          url: request.url,
          authorization: formatAuthHeader(flattenedAuth),
        };
      },
    },
  };
}
