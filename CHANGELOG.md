# Changelog

All notable changes to **resolvetrace-core** (the OSS ingest server + portal) are
documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Pre-1.0 — the HTTP
surface and the container image are not yet stable.

## [Unreleased]

### Added
- A neutral, injectable **replay clip-capability policy** (`ReplayClipPolicy`).
  This server records a single replay clip per session ("the whole session" as
  one clip); a composing server can inject a policy to grant multi-clip curation
  per tenant. Session-start now advertises `replay: { clips: "single" | "multi" }`
  (default `single`), and the signed-url leg accepts an optional 0-based
  `clipIndex` — a `clipIndex > 0` is rejected **403 `multi_clip_not_permitted`**
  unless the policy grants multi (the first clip, `clipIndex` absent or `0`, is
  always allowed). Default-DENY and absent by default (the inverse polarity of
  the upload-authorization guard), so multi-clip can't be unlocked by
  configuration alone — only by injecting a policy that grants it.
- OIDC portal auth: **injectable dynamic redirect-URI allow-list**. The OIDC
  provider now accepts optional `isRedirectUriAllowed` / `isRedirectOriginAllowed`
  hooks (via `OidcAuthOptions` and `createOidcAuthFromEnv`), consulted when a
  per-request `redirect_uri` (login) or post-logout origin isn't in the static
  `OIDC_REDIRECT_URLS` list. A composing server can back these with a registry so
  per-tenant portal callback URLs are honored at runtime with no restart — the
  same move already made for CORS origins. Absent ⇒ static list only (unchanged);
  the IdP's own exact redirect-URI allow-list stays the primary enforcement.

## [0.3.0] — 2026-07-16

First tagged release. The multi-arch image publishes to
`ghcr.io/peaktek/resolvetrace-core`: a `v*` tag builds `:vX.Y.Z` / `:X.Y` / `:X`,
while `:latest` tracks `main`.

### Added
- **Ingest server** (Fastify): `/v1/events`, `/v1/session/*`, and the masked
  replay upload legs (`/v1/replay/signed-url`, `/v1/replay/complete`).
- **Portal** (Next.js) in the same image (second entry point): the sessions
  list, per-session timeline, audit, retention controls, and a masked
  **session-replay player**.
- Masked replay in the portal now **splits a session into per-recording
  segments** — a switcher plays each recording on its own timeline, and clips
  removed by the SDK (leaving sequence gaps) are stitched cleanly (#32).
- **Replay trigger-mode** (`auto` / `off`) on the portal replay settings API (#19).
- A neutral, injectable **upload-authorization guard** on both replay upload
  legs — absent by default (behavior unchanged), so a deployment can deny or
  hold replay uploads without a code change (#20).

### Fixed
- Invalid or revoked API keys now return **401** (not 500).
- The replay chunk-key format check accepts ULID ids.
- Portal timeline labels `perf.api_latency` as **"API call"** (not "Slow API
  call") (#21).
