"use client";

import { createContext, useContext } from "react";
import type { PortalSessionView } from "@/lib/session";

/**
 * Client-side access to the (non-secret) portal session. Seeded once by the
 * Shell from the server-verified session cookie. Client components read
 * identity + tenants + scopes from here; the privileged bearer stays server-side.
 */
const SessionContext = createContext<PortalSessionView | null>(null);

export function SessionProvider({
  value,
  children,
}: {
  value: PortalSessionView | null;
  children: React.ReactNode;
}) {
  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession(): PortalSessionView | null {
  return useContext(SessionContext);
}

/** The current tenant's scopes (empty when unauthenticated). */
export function useScopes(): string[] {
  return useContext(SessionContext)?.scopes ?? [];
}
