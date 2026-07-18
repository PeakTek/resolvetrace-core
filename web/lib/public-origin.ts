/**
 * Resolve the portal's PUBLIC origin for absolute redirects.
 *
 * Behind a TLS-terminating reverse proxy the standalone Next server sees its
 * internal listen address (e.g. `0.0.0.0:3000`) in `request.url`, so building
 * redirects from it sends browsers to an unreachable origin. Resolution order:
 *
 *   1. `PORTAL_PUBLIC_URL` env — explicit override, always wins.
 *   2. `X-Forwarded-Host` (+ `X-Forwarded-Proto`, default https) — what a
 *      reverse proxy (Caddy et al.) sets.
 *   3. The `Host` header, with the request's own protocol — direct access
 *      (e.g. local dev on http://localhost:3000).
 *   4. The request URL's origin — last resort.
 *
 * Isomorphic (plain header reads) so both route handlers and the middleware
 * can use it.
 */

/** First value of a possibly comma-separated header. */
function first(value: string | null): string | undefined {
  const v = value?.split(",")[0]?.trim();
  return v && v.length > 0 ? v : undefined;
}

export function publicOrigin(request: Request): string {
  const explicit = process.env.PORTAL_PUBLIC_URL;
  if (explicit && explicit.length > 0) return explicit.replace(/\/$/, "");

  const headers = request.headers;
  const xfHost = first(headers.get("x-forwarded-host"));
  if (xfHost) {
    const proto = first(headers.get("x-forwarded-proto")) ?? "https";
    return `${proto}://${xfHost}`;
  }

  const host = first(headers.get("host"));
  if (host) {
    return `${new URL(request.url).protocol}//${host}`;
  }

  return new URL(request.url).origin;
}
