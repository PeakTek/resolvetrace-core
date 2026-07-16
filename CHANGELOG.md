# Changelog

All notable changes to **resolvetrace-core** (the OSS ingest server + portal) are
documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Pre-1.0 — the HTTP
surface and the container image are not yet stable.

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
