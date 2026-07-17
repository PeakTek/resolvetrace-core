"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/components/session-provider";

/**
 * Active-workspace picker. Data-driven: renders nothing when the user belongs
 * to a single tenant (OSS single-tenant, or a single-membership managed user).
 * Selecting a tenant re-scopes the session server-side, then refreshes so the
 * page re-renders against the new tenant.
 */
export function TenantSwitcher() {
  const session = useSession();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  if (!session || session.tenants.length <= 1) return null;

  async function onChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const tenantId = event.target.value;
    if (!session || tenantId === session.currentTenantId) return;
    setBusy(true);
    try {
      const res = await fetch("/api/auth/tenant-select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId }),
      });
      if (res.ok) {
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <select
      value={session.currentTenantId}
      onChange={onChange}
      disabled={busy}
      aria-label="Active workspace"
      className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400"
    >
      {session.tenants.map((t) => (
        <option key={t.id} value={t.id}>
          {t.displayName}
        </option>
      ))}
    </select>
  );
}
