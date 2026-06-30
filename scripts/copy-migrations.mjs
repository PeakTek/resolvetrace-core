// Copy non-TS assets (SQL migrations) into `dist/` so `runMigrations` finds
// them when the package is consumed from `dist/` — both the published image's
// `node dist/ingest-api/main.js` start path and a downstream server that
// imports `runMigrations` from this package. `tsc` only emits .js/.d.ts, so
// the `*.sql` files must be copied explicitly.
import { cpSync } from "node:fs";

cpSync("server/ingest-api/migrations", "dist/ingest-api/migrations", {
  recursive: true,
});
