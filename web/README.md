# ResolveTrace OSS portal (shell)

The Next.js 16 App Router dashboard for self-hosted single-tenant
ResolveTrace deployments. Session, replay, and audit pages render live data
from the ingest server's portal query endpoints; `/login` is a development
stub (the OSS build is single-tenant, with no identity provider).

## What works today

- `/sessions` + `/sessions/[id]` — session list, metadata, client details, and event list (live)
- session replay — rrweb-based player with scale-to-fit + fullscreen (live chunk download)
- `/audit` — audit log (live)
- `/login` — accepts any non-empty credentials (development stub, see below)
- `tsc --noEmit` + `next build` both green

## Auth (OSS vs managed)

The OSS build is **single-tenant by design** and ships a login stub: the
portal's server-side calls use a bearer shared with the ingest service. Real
user login + RBAC + multi-tenant workspace switching are provided by a
**composing runtime** that injects an auth provider through the portal-auth
seams — not part of the single-tenant OSS distribution.

## Prerequisites

- Node.js 20+
- npm 10+

## Local development

```bash
cd web
npm install
npm run dev
```

The dev server listens on http://localhost:3000.

## Checks CI runs

```bash
npm run typecheck    # tsc --noEmit
npm run build        # next build (includes type-check of routes)
npm run lint         # next lint
```

## Where the bigger picture lives

Portal architecture follows the Portal Web App + Portal API split. In the OSS
single-tenant build the portal's server-side calls use a bearer shared with the
ingest service; managed deployments inject a real auth provider through the
portal-auth seams (see the platform runtime).
