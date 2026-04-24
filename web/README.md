# ResolveTrace OSS portal (shell)

The Next.js 16 App Router dashboard for self-hosted single-tenant
ResolveTrace deployments. Session list and detail pages render live data
from the ingest server's portal query endpoints; `/login` and `/audit`
remain placeholder callouts.

## What works today

- `/login` — accepts any non-empty credentials (development stub)
- `/sessions` — session list and detail pages render live data from the ingest server's portal query endpoints
- `/sessions/[id]` — session metadata, client details, and event list
- `/audit` — empty audit-log placeholder
- `tsc --noEmit` + `next build` both green

## What's intentionally missing

- Real authentication (OIDC / env-based). The portal-to-ingest bearer is server-to-server today.
- Replay viewer. Needs real chunk-download + timeline UI.
- Audit log page. Still an empty-state placeholder.

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

Portal architecture follows the Portal Web App + Portal API split. Real
auth for the portal user session is still a later wave; today the
portal's server-side calls use a bearer token shared with the ingest
service.
