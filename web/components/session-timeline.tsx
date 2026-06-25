/**
 * Session-detail timeline.
 *
 * Renders the per-session event stream emitted by the ResolveTrace SDK as a
 * chronological, type-aware timeline. Frustration signals (rage/dead clicks,
 * repeated submits), error breadcrumbs (JS/API/resource) and network/perf
 * events (api latency, long tasks) each get a distinct, severity-coloured row.
 *
 * Privacy: this component renders ONLY the scrubbed/masked data the SDK sent.
 * Selectors are already masked by the SDK; URLs are already scrubbed. We never
 * attempt to reconstruct raw values — anything we don't recognise is shown via
 * the generic fallback row with its raw `attributes` JSON.
 */

import { cn } from "@/lib/utils";
import { formatRelative } from "@/lib/format";
import type { PortalSessionEvent } from "@/lib/ingest-api";

type Severity = "info" | "warn" | "error";

type Category = "frustration" | "error" | "network" | "perf" | "other";

/** Visual treatment per severity — left accent + badge colours. */
const SEVERITY_STYLES: Record<
  Severity,
  { dot: string; badge: string; accent: string }
> = {
  error: {
    dot: "bg-red-500",
    badge: "bg-red-50 text-red-700 ring-red-600/20",
    accent: "border-l-red-400",
  },
  warn: {
    dot: "bg-amber-500",
    badge: "bg-amber-50 text-amber-700 ring-amber-600/20",
    accent: "border-l-amber-400",
  },
  info: {
    dot: "bg-sky-500",
    badge: "bg-sky-50 text-sky-700 ring-sky-600/20",
    accent: "border-l-sky-300",
  },
};

const CATEGORY_LABEL: Record<Category, string> = {
  frustration: "Frustration",
  error: "Error",
  network: "Network",
  perf: "Performance",
  other: "Event",
};

function categoryOf(type: string): Category {
  if (type.startsWith("ux.")) return "frustration";
  if (type === "error.api") return "network";
  if (type.startsWith("error.")) return "error";
  if (type.startsWith("perf.")) return "perf";
  return "other";
}

/**
 * Severity to render with. Prefer the persisted top-level `severity`; fall
 * back to a sensible default per type so legacy/auto events without a stored
 * severity still colour correctly.
 */
function severityOf(e: PortalSessionEvent): Severity {
  if (e.severity === "info" || e.severity === "warn" || e.severity === "error") {
    return e.severity;
  }
  const t = e.type;
  if (t.startsWith("error.")) return t === "error.resource" ? "warn" : "error";
  if (t === "ux.rage_click" || t === "ux.repeated_submit") return "warn";
  return "info";
}

function attrString(
  attrs: Record<string, unknown> | null | undefined,
  key: string
): string | null {
  if (!attrs) return null;
  const v = attrs[key];
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function attrNumber(
  attrs: Record<string, unknown> | null | undefined,
  key: string
): number | null {
  if (!attrs) return null;
  const v = attrs[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function attrBool(
  attrs: Record<string, unknown> | null | undefined,
  key: string
): boolean {
  return Boolean(attrs && attrs[key] === true);
}

function formatDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

interface RowContent {
  title: string;
  /** Short single-line summary (masked target, method+url, message, …). */
  summary?: string | null;
  /** Compact badges rendered after the title (count, status, duration). */
  badges: { label: string; tone?: "neutral" | "danger" }[];
  /** Optional collapsible detail block (stack traces). */
  detail?: { label: string; body: string } | null;
}

function buildRow(e: PortalSessionEvent): RowContent {
  const a = e.attributes;
  const badges: RowContent["badges"] = [];
  const duration = formatDuration(e.durationMs);

  switch (e.type) {
    case "ux.rage_click": {
      const count = attrNumber(a, "clickCount");
      if (count !== null) badges.push({ label: `${count} clicks` });
      return {
        title: "Rage click",
        summary: attrString(a, "target") ?? "(unknown target)",
        badges,
      };
    }
    case "ux.dead_click":
      return {
        title: "Dead click",
        summary: attrString(a, "target") ?? "(unknown target)",
        badges,
      };
    case "ux.repeated_submit": {
      const count = attrNumber(a, "submitCount");
      if (count !== null) badges.push({ label: `${count} submits` });
      return {
        title: "Repeated submit",
        summary: attrString(a, "target") ?? "(unknown target)",
        badges,
      };
    }
    case "error.js": {
      const kind = attrString(a, "kind");
      const errorType = attrString(a, "errorType");
      if (errorType) badges.push({ label: errorType, tone: "danger" });
      if (kind) badges.push({ label: kind });
      const stack = attrString(a, "stack");
      return {
        title: "JavaScript error",
        summary: attrString(a, "message") ?? "(no message)",
        badges,
        detail: stack ? { label: "Stack trace", body: stack } : null,
      };
    }
    case "error.api": {
      const method = attrString(a, "method");
      const url = attrString(a, "url");
      const status = e.httpStatus;
      if (status !== null && status !== undefined) {
        badges.push({ label: `HTTP ${status}`, tone: "danger" });
      }
      if (attrBool(a, "networkError")) {
        badges.push({ label: "network error", tone: "danger" });
      }
      if (duration) badges.push({ label: duration });
      return {
        title: "API error",
        summary: [method, url].filter(Boolean).join(" ") || "(request)",
        badges,
      };
    }
    case "error.resource": {
      const rt = attrString(a, "resourceType");
      if (rt) badges.push({ label: rt });
      return {
        title: "Resource failed to load",
        summary:
          attrString(a, "resourceUrl") ??
          attrString(a, "target") ??
          "(resource)",
        badges,
      };
    }
    case "perf.api_latency": {
      const method = attrString(a, "method");
      const url = attrString(a, "url");
      const status = e.httpStatus;
      if (status !== null && status !== undefined) {
        badges.push({ label: `HTTP ${status}` });
      }
      if (duration) badges.push({ label: duration });
      return {
        title: "Slow API call",
        summary: [method, url].filter(Boolean).join(" ") || "(request)",
        badges,
      };
    }
    case "perf.long_task": {
      if (duration) badges.push({ label: duration });
      return {
        title: "Long task",
        summary: attrString(a, "name") ?? "(task)",
        badges,
      };
    }
    default: {
      // Generic / future event types: show the type and raw attributes.
      if (e.httpStatus !== null && e.httpStatus !== undefined) {
        badges.push({ label: `HTTP ${e.httpStatus}` });
      }
      if (duration) badges.push({ label: duration });
      let body = "";
      if (a) {
        try {
          body = JSON.stringify(a, null, 2);
        } catch {
          body = "[unserializable]";
        }
      }
      return {
        title: e.type,
        summary: null,
        badges,
        detail: body ? { label: "Attributes", body } : null,
      };
    }
  }
}

function Badge({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "danger";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[11px] font-medium ring-1 ring-inset",
        tone === "danger"
          ? "bg-red-50 text-red-700 ring-red-600/20"
          : "bg-neutral-100 text-neutral-600 ring-neutral-300/50"
      )}
    >
      {label}
    </span>
  );
}

function TimelineRow({ event }: { event: PortalSessionEvent }) {
  const severity = severityOf(event);
  const category = categoryOf(event.type);
  const styles = SEVERITY_STYLES[severity];
  const row = buildRow(event);

  return (
    <li
      className={cn(
        "relative border-l-2 py-3 pl-6 pr-4 last:pb-1",
        styles.accent
      )}
    >
      {/* Timeline dot sitting on the accent rail. */}
      <span
        className={cn(
          "absolute -left-[5px] top-4 h-2 w-2 rounded-full ring-2 ring-white",
          styles.dot
        )}
        aria-hidden
      />
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm font-medium text-neutral-900">
          {row.title}
        </span>
        <span
          className={cn(
            "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ring-inset",
            styles.badge
          )}
        >
          {CATEGORY_LABEL[category]}
        </span>
        {row.badges.map((b, i) => (
          <Badge key={i} label={b.label} tone={b.tone} />
        ))}
        <span
          className="ml-auto whitespace-nowrap text-xs text-neutral-400"
          title={event.capturedAt}
        >
          {formatRelative(event.capturedAt)}
        </span>
      </div>
      {row.summary ? (
        <p className="mt-1 break-all font-mono text-xs text-neutral-600">
          {row.summary}
        </p>
      ) : null}
      {row.detail ? (
        <details className="mt-2 group">
          <summary className="cursor-pointer select-none text-xs text-neutral-500 hover:text-neutral-700">
            {row.detail.label}
          </summary>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-neutral-50 p-2 font-mono text-[11px] text-neutral-600 ring-1 ring-inset ring-neutral-200">
            {row.detail.body}
          </pre>
        </details>
      ) : null}
    </li>
  );
}

export function SessionTimeline({
  events,
  capped,
}: {
  events: PortalSessionEvent[];
  capped?: boolean;
}) {
  if (events.length === 0) {
    return (
      <div className="p-6 text-center text-sm text-neutral-600">
        No events recorded for this session yet.
      </div>
    );
  }

  // Defensive: render strictly by capture order even if the API order changes.
  const ordered = [...events].sort((a, b) =>
    a.capturedAt < b.capturedAt ? -1 : a.capturedAt > b.capturedAt ? 1 : 0
  );

  // Category roll-up for an at-a-glance summary above the stream.
  const counts = ordered.reduce<Record<Category, number>>(
    (acc, e) => {
      const c = categoryOf(e.type);
      acc[c] += 1;
      return acc;
    },
    { frustration: 0, error: 0, network: 0, perf: 0, other: 0 }
  );
  const summaryParts = (
    ["frustration", "error", "network", "perf", "other"] as Category[]
  )
    .filter((c) => counts[c] > 0)
    .map((c) => `${counts[c]} ${CATEGORY_LABEL[c].toLowerCase()}`);

  return (
    <div>
      {summaryParts.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-neutral-100 px-4 py-2 text-xs text-neutral-500">
          {summaryParts.map((p, i) => (
            <span key={i} className="rounded bg-neutral-100 px-2 py-0.5">
              {p}
            </span>
          ))}
        </div>
      ) : null}
      <ol className="px-4 py-2">
        {ordered.map((e) => (
          <TimelineRow key={e.eventId} event={e} />
        ))}
      </ol>
      {capped ? (
        <div className="border-t border-neutral-100 bg-amber-50/50 px-4 py-2 text-xs text-amber-700">
          This session reached the SDK&rsquo;s per-session auto-capture cap;
          some later events may not have been recorded.
        </div>
      ) : null}
    </div>
  );
}
