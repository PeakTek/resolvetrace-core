"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { PortalLocalizationSettings } from "@/lib/ingest-api";

/** A handful of common locales offered as autocomplete; any BCP-47 tag works. */
const COMMON_LOCALES = [
  "en-US", "en-GB", "en-CA", "en-AU", "fr-FR", "fr-CA", "de-DE", "es-ES",
  "es-MX", "pt-BR", "nl-NL", "it-IT", "ja-JP", "zh-CN",
];

/** IANA zone list from the runtime, with the current value guaranteed present. */
function timezones(current: string): string[] {
  const sv = (Intl as unknown as {
    supportedValuesOf?: (key: string) => string[];
  }).supportedValuesOf;
  const list =
    typeof sv === "function" ? sv("timeZone") : ["UTC", current];
  return list.includes(current) ? list : [current, ...list];
}

type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "ok" }
  | { status: "error"; message: string };

/** Admin edit form for the tenant's portal locale + timezone. */
export function LocalizationForm({
  settings,
}: {
  settings: PortalLocalizationSettings;
}) {
  const router = useRouter();
  const [locale, setLocale] = useState(settings.localization.locale);
  const [timezone, setTimezone] = useState(settings.localization.timezone);
  const [state, setState] = useState<SaveState>({ status: "idle" });
  const zones = timezones(settings.localization.timezone);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locale.trim().length < 2) {
      setState({ status: "error", message: "Enter a locale (e.g. en-US)." });
      return;
    }
    setState({ status: "saving" });
    let res: Response;
    try {
      res = await fetch("/api/localization", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: locale.trim(), timezone }),
      });
    } catch {
      setState({ status: "error", message: "Could not save. Try again." });
      return;
    }
    if (res.status === 403) {
      setState({
        status: "error",
        message: "Your account is not authorized to change these settings.",
      });
      return;
    }
    if (!res.ok) {
      let message = "Could not save localization settings.";
      try {
        const body = (await res.json()) as { message?: string };
        if (body.message) message = body.message;
      } catch {
        // keep default
      }
      setState({ status: "error", message });
      return;
    }
    setState({ status: "ok" });
    // The proxy re-sealed the session cookie with the new locale/timezone, so a
    // refresh re-renders every time label across the portal in the new format.
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor="locale" className="text-sm font-medium">
            Locale
          </label>
          <Input
            id="locale"
            name="locale"
            list="locale-options"
            value={locale}
            onChange={(e) => {
              setLocale(e.target.value);
              if (state.status !== "idle") setState({ status: "idle" });
            }}
          />
          <datalist id="locale-options">
            {COMMON_LOCALES.map((l) => (
              <option key={l} value={l} />
            ))}
          </datalist>
          <p className="text-xs text-neutral-500">
            BCP-47 tag, e.g. <span className="font-mono">en-US</span> — sets date
            order and 12/24-hour format.
          </p>
        </div>
        <div className="space-y-1">
          <label htmlFor="timezone" className="text-sm font-medium">
            Timezone
          </label>
          <select
            id="timezone"
            name="timezone"
            value={timezone}
            onChange={(e) => {
              setTimezone(e.target.value);
              if (state.status !== "idle") setState({ status: "idle" });
            }}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm"
          >
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
          <p className="text-xs text-neutral-500">
            IANA zone, e.g. <span className="font-mono">America/New_York</span> —
            all portal timestamps render in this zone.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={state.status === "saving"}>
          {state.status === "saving" ? "Saving…" : "Save localization"}
        </Button>
        {state.status === "ok" ? (
          <span className="text-sm text-green-700">Saved.</span>
        ) : null}
        {state.status === "error" ? (
          <span className="text-sm text-red-600">{state.message}</span>
        ) : null}
      </div>
    </form>
  );
}
