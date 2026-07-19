import { TopBar } from "./top-bar";
import { Sidebar } from "./sidebar";
import { SessionProvider } from "@/components/session-provider";
import { getSession } from "@/lib/session-cookie";
import { publicView } from "@/lib/session";

/**
 * Standard authenticated-page layout: fixed top bar, left sidebar, main pane.
 * Reads the server-verified session once and seeds the client SessionProvider
 * so the top bar (identity, sign-out, tenant switcher) and scope-gated controls
 * render from it. The login page renders without Shell.
 */
export async function Shell({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  // Optional per-deployment brand label (multi-instance deployments set it so
  // each portal is visually identifiable). Read server-side at request time.
  const brand = process.env.PORTAL_BRAND_NAME;
  return (
    <SessionProvider value={session ? publicView(session) : null}>
      <div className="flex min-h-screen flex-col">
        <TopBar brand={brand} />
        <div className="flex flex-1">
          <Sidebar />
          <main className="flex-1 bg-neutral-50">{children}</main>
        </div>
      </div>
    </SessionProvider>
  );
}
