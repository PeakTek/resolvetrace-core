"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  PortalRetentionSettings,
  PortalRetentionWindows,
} from "@/lib/ingest-api";

type FieldKey = keyof PortalRetentionWindows;

const FIELDS: { key: FieldKey; label: string; hint: string }[] = [
  { key: "eventsDays", label: "Events", hint: "Captured events / breadcrumbs" },
  { key: "sessionsDays", label: "Sessions", hint: "Session records" },
  { key: "replayDays", label: "Replay", hint: "Replay artifacts" },
];

type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "ok"; updated: Partial<PortalRetentionWindows> }
  | { status: "error"; message: string };

/** Edit form for the three retention day-windows. 0 = keep forever. */
export function RetentionForm({
  settings,
}: {
  settings: PortalRetentionSettings;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Record<FieldKey, string>>({
    eventsDays: String(settings.retention.eventsDays),
    sessionsDays: String(settings.retention.sessionsDays),
    replayDays: String(settings.retention.replayDays),
  });
  const [state, setState] = useState<SaveState>({ status: "idle" });

  function validate(): Partial<PortalRetentionWindows> | { error: string } {
    const out: Partial<PortalRetentionWindows> = {};
    for (const { key, label } of FIELDS) {
      const raw = values[key].trim();
      if (!/^[0-9]+$/.test(raw)) {
        return { error: `${label} must be a non-negative integer.` };
      }
      out[key] = parseInt(raw, 10);
    }
    return out;
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = validate();
    if ("error" in parsed) {
      setState({ status: "error", message: parsed.error });
      return;
    }
    setState({ status: "saving" });
    let res: Response;
    try {
      res = await fetch("/api/retention", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
    } catch {
      setState({ status: "error", message: "Could not save. Try again." });
      return;
    }
    if (res.status === 403) {
      setState({
        status: "error",
        message: "Your account is not authorized to change retention settings.",
      });
      return;
    }
    if (!res.ok) {
      let message = "Could not save retention settings.";
      try {
        const body = (await res.json()) as { message?: string };
        if (body.message) message = body.message;
      } catch {
        // keep default
      }
      setState({ status: "error", message });
      return;
    }
    const body = (await res.json()) as {
      retention: PortalRetentionWindows;
      updated: Partial<PortalRetentionWindows>;
    };
    setValues({
      eventsDays: String(body.retention.eventsDays),
      sessionsDays: String(body.retention.sessionsDays),
      replayDays: String(body.retention.replayDays),
    });
    setState({ status: "ok", updated: body.updated });
    // Refresh the server component so the "source: override/env" badges update.
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {FIELDS.map(({ key, label, hint }) => (
          <div key={key} className="space-y-1">
            <label htmlFor={key} className="text-sm font-medium">
              {label}{" "}
              <span className="font-normal text-neutral-400">(days)</span>
            </label>
            <Input
              id={key}
              name={key}
              inputMode="numeric"
              value={values[key]}
              onChange={(e) => {
                setValues((v) => ({ ...v, [key]: e.target.value }));
                if (state.status !== "idle") setState({ status: "idle" });
              }}
            />
            <p className="text-xs text-neutral-500">
              {hint}
              {settings.source[key] === "override" ? (
                <span className="ml-1 rounded bg-neutral-100 px-1 text-neutral-600">
                  override
                </span>
              ) : (
                <span className="ml-1 rounded bg-neutral-100 px-1 text-neutral-600">
                  env
                </span>
              )}
            </p>
          </div>
        ))}
      </div>
      <p className="text-xs text-neutral-500">
        Use <span className="font-mono">0</span> to keep data forever.
      </p>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={state.status === "saving"}>
          {state.status === "saving" ? "Saving…" : "Save retention settings"}
        </Button>
        {state.status === "ok" ? (
          <span className="text-sm text-green-700">
            Saved{" "}
            {Object.keys(state.updated).length > 0
              ? `(${Object.entries(state.updated)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(", ")})`
              : ""}
            .
          </span>
        ) : null}
        {state.status === "error" ? (
          <span className="text-sm text-red-600">{state.message}</span>
        ) : null}
      </div>
    </form>
  );
}
