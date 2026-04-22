import Link from "next/link";
import { ClipboardList, Play } from "lucide-react";

const NAV_ITEMS = [
  { href: "/sessions", label: "Sessions", icon: Play },
  { href: "/audit", label: "Audit log", icon: ClipboardList },
] as const;

export function Sidebar() {
  return (
    <nav className="w-56 border-r border-neutral-200 bg-white py-4">
      <ul className="space-y-1 px-2">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-100"
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
