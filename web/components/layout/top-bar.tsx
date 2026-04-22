import { User } from "lucide-react";

export function TopBar() {
  return (
    <header className="flex h-14 items-center justify-between border-b border-neutral-200 bg-white px-6">
      <div className="text-sm font-semibold tracking-tight">ResolveTrace</div>
      <div
        className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-100 text-neutral-600"
        aria-label="Signed-in user"
      >
        <User className="h-4 w-4" aria-hidden="true" />
      </div>
    </header>
  );
}
