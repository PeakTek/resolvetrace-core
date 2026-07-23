"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogOut, User } from "lucide-react";
import { useSession } from "@/components/session-provider";
import { TenantSwitcher } from "./tenant-switcher";

export function TopBar({ brand }: { brand?: string }) {
  const session = useSession();
  const router = useRouter();

  async function signOut() {
    let logoutUrl: string | undefined;
    try {
      const res = await fetch("/api/auth/logout", { method: "POST" });
      ({ logoutUrl } = (await res.json().catch(() => ({}))) as {
        logoutUrl?: string;
      });
    } catch {
      /* fall through to the local sign-out below */
    }
    if (logoutUrl) {
      // Full sign-out: end the session at the identity provider too, else the
      // next sign-in is satisfied silently and the user is never really signed
      // out. The IdP returns the browser to /login.
      window.location.href = logoutUrl;
      return;
    }
    router.replace("/login");
    router.refresh();
  }

  return (
    <header className="flex h-14 items-center justify-between border-b border-neutral-200 bg-white px-6">
      <div className="flex items-center gap-3">
        <div className="text-sm font-semibold tracking-tight">
          {brand ?? "ResolveTrace"}
        </div>
        <TenantSwitcher />
      </div>
      {session ? (
        <div className="flex items-center gap-3">
          <span className="hidden text-sm text-neutral-600 sm:inline">
            {session.email}
          </span>
          <button
            type="button"
            onClick={signOut}
            aria-label="Sign out"
            title="Sign out"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-100 text-neutral-600 transition hover:bg-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ) : (
        <Link
          href="/login"
          aria-label="Sign in"
          title="Sign in"
          className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-100 text-neutral-600 transition hover:bg-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400"
        >
          <User className="h-4 w-4" aria-hidden="true" />
        </Link>
      )}
    </header>
  );
}
