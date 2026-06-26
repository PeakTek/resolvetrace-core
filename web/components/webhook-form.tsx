"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  PortalWebhookSettings,
  PortalWebhookTestResult,
  PortalWebhookUpdateResult,
} from "@/lib/ingest-api";

type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "ok"; updated: Record<string, unknown> }
  | { status: "error"; message: string };

type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "done"; result: PortalWebhookTestResult }
  | { status: "error"; message: string };

/** Client-side https check mirroring the server's guard. Empty = "clear it". */
function isHttpsUrl(raw: string): boolean {
  try {
    return new URL(raw).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Admin webhook config form (Wave-25). Edits enabled / url / secret and triggers
 * a signed test delivery. The secret is WRITE-ONLY: we show a "configured"
 * indicator from `secretConfigured` and never render the value. Submitting an
 * empty secret field leaves the stored secret unchanged (we omit it); the
 * separate "Clear secret" control sends an empty string to clear it.
 */
export function WebhookForm({ settings }: { settings: PortalWebhookSettings }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(settings.webhook.enabled);
  const [url, setUrl] = useState(settings.webhook.url);
  const [secret, setSecret] = useState("");
  const [secretConfigured, setSecretConfigured] = useState(
    settings.webhook.secretConfigured
  );
  const [save, setSave] = useState<SaveState>({ status: "idle" });
  const [test, setTest] = useState<TestState>({ status: "idle" });

  function resetTransient() {
    if (save.status !== "idle") setSave({ status: "idle" });
    if (test.status !== "idle") setTest({ status: "idle" });
  }

  async function submit(body: {
    enabled?: boolean;
    url?: string;
    secret?: string;
  }) {
    setSave({ status: "saving" });
    setTest({ status: "idle" });
    let res: Response;
    try {
      res = await fetch("/api/settings/webhook", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      setSave({ status: "error", message: "Could not save. Try again." });
      return;
    }
    if (res.status === 403) {
      setSave({
        status: "error",
        message: "Your account is not authorized to change webhook settings.",
      });
      return;
    }
    if (!res.ok) {
      let message = "Could not save webhook settings.";
      try {
        const b = (await res.json()) as { message?: string };
        if (b.message) message = b.message;
      } catch {
        // keep default
      }
      setSave({ status: "error", message });
      return;
    }
    const b = (await res.json()) as PortalWebhookUpdateResult;
    setEnabled(b.webhook.enabled);
    setUrl(b.webhook.url);
    setSecret("");
    setSecretConfigured(b.webhook.secretConfigured);
    setSave({ status: "ok", updated: b.updated });
    router.refresh();
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedUrl = url.trim();
    if (trimmedUrl !== "" && !isHttpsUrl(trimmedUrl)) {
      setSave({
        status: "error",
        message: "URL must be a valid https URL (or empty to clear).",
      });
      return;
    }
    const body: { enabled: boolean; url: string; secret?: string } = {
      enabled,
      url: trimmedUrl,
    };
    // Only send the secret when the operator typed one; an empty field means
    // "leave the stored secret unchanged" (use "Clear secret" to remove it).
    if (secret.length > 0) body.secret = secret;
    await submit(body);
  }

  async function clearSecret() {
    await submit({ secret: "" });
  }

  async function sendTest() {
    setTest({ status: "testing" });
    let res: Response;
    try {
      res = await fetch("/api/settings/webhook/test", { method: "POST" });
    } catch {
      setTest({ status: "error", message: "Could not send test. Try again." });
      return;
    }
    if (res.status === 403) {
      setTest({
        status: "error",
        message: "Your account is not authorized to send a test.",
      });
      return;
    }
    if (res.status === 400) {
      let message = "Configure an https URL and a secret before testing.";
      try {
        const b = (await res.json()) as { message?: string };
        if (b.message) message = b.message;
      } catch {
        // keep default
      }
      setTest({ status: "error", message });
      return;
    }
    if (!res.ok) {
      setTest({
        status: "error",
        message: "Could not reach the ingest API to send the test.",
      });
      return;
    }
    const b = (await res.json()) as { result: PortalWebhookTestResult };
    setTest({ status: "done", result: b.result });
    // Surfaces the new webhook.dispatch audit row.
    router.refresh();
  }

  const canTest = isHttpsUrl(url.trim()) && (secretConfigured || secret.length > 0);

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            resetTransient();
          }}
          className="h-4 w-4 rounded border-neutral-300"
        />
        <span className="text-sm font-medium">
          Forward submitted reports to this webhook
        </span>
      </label>

      <div className="space-y-1">
        <label htmlFor="webhook-url" className="text-sm font-medium">
          Webhook URL
        </label>
        <Input
          id="webhook-url"
          name="url"
          type="url"
          inputMode="url"
          placeholder="https://example.com/hooks/resolvetrace"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            resetTransient();
          }}
        />
        <p className="text-xs text-neutral-500">
          Must be an <span className="font-mono">https</span> URL. Leave empty to
          clear.
        </p>
      </div>

      <div className="space-y-1">
        <label htmlFor="webhook-secret" className="text-sm font-medium">
          Signing secret{" "}
          {secretConfigured ? (
            <span className="ml-1 rounded bg-green-50 px-1.5 py-0.5 text-xs font-normal text-green-700 ring-1 ring-inset ring-green-600/20">
              configured
            </span>
          ) : (
            <span className="ml-1 rounded bg-neutral-100 px-1.5 py-0.5 text-xs font-normal text-neutral-600">
              not set
            </span>
          )}
        </label>
        <Input
          id="webhook-secret"
          name="secret"
          type="password"
          autoComplete="new-password"
          placeholder={
            secretConfigured ? "•••••••• (leave blank to keep)" : "Enter a secret"
          }
          value={secret}
          onChange={(e) => {
            setSecret(e.target.value);
            resetTransient();
          }}
        />
        <p className="text-xs text-neutral-500">
          Used to HMAC-sign each delivery. Write-only — the stored value is never
          shown. Leave blank to keep the current secret.
          {secretConfigured ? (
            <button
              type="button"
              onClick={clearSecret}
              className="ml-2 text-red-600 hover:underline"
            >
              Clear secret
            </button>
          ) : null}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-neutral-100 pt-4">
        <Button type="submit" disabled={save.status === "saving"}>
          {save.status === "saving" ? "Saving…" : "Save webhook settings"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={sendTest}
          disabled={test.status === "testing" || !canTest}
          title={
            canTest
              ? "Send a signed test payload to the configured URL"
              : "Configure an https URL and a secret first"
          }
        >
          {test.status === "testing" ? "Sending…" : "Send test"}
        </Button>

        {save.status === "ok" ? (
          <span className="text-sm text-green-700">Saved.</span>
        ) : null}
        {save.status === "error" ? (
          <span className="text-sm text-red-600">{save.message}</span>
        ) : null}
        {test.status === "done" ? (
          <span
            className={
              test.result.status === "delivered"
                ? "text-sm text-green-700"
                : "text-sm text-red-600"
            }
          >
            {test.result.status === "delivered"
              ? `Delivered (HTTP ${test.result.httpStatus ?? "?"}, ${test.result.attempts} attempt${test.result.attempts === 1 ? "" : "s"}).`
              : `Failed: ${test.result.status}${
                  test.result.httpStatus !== null
                    ? ` (HTTP ${test.result.httpStatus})`
                    : ""
                }${test.result.error ? ` — ${test.result.error}` : ""}.`}
          </span>
        ) : null}
        {test.status === "error" ? (
          <span className="text-sm text-red-600">{test.message}</span>
        ) : null}
      </div>
    </form>
  );
}
