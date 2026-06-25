"use client";

import { useState } from "react";
import { formatSupportCode } from "@/lib/format";

/**
 * Prominent, readable rendering of a session's support code with a one-click
 * copy affordance. The copied value is the formatted (dashed) code, which is
 * also what the lookup box accepts back — the server normalizes dashes away.
 */
export function SupportCodeBadge({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const formatted = formatSupportCode(code);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(formatted);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable (e.g. insecure context); the code is
      // still visible on screen for the operator to copy manually.
    }
  }

  return (
    <div className="inline-flex items-center gap-2 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-1.5">
      <span className="text-xs uppercase tracking-wide text-neutral-500">
        Support code
      </span>
      <span className="font-mono text-base font-semibold tracking-wider text-neutral-900">
        {formatted}
      </span>
      <button
        type="button"
        onClick={handleCopy}
        className="rounded px-1.5 py-0.5 text-xs text-blue-600 hover:bg-neutral-100"
        aria-label="Copy support code"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
