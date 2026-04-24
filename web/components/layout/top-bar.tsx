import Link from "next/link";
import { User } from "lucide-react";

export function TopBar() {
  return (
    <header className="flex h-14 items-center justify-between border-b border-neutral-200 bg-white px-6">
      <div className="text-sm font-semibold tracking-tight">ResolveTrace</div>
      <Link
        href="/login"
        aria-label="Sign in"
        title="Sign in"
        className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-100 text-neutral-600 transition hover:bg-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400"
      >
        <User className="h-4 w-4" aria-hidden="true" />
      </Link>
    </header>
  );
}
