import { TopBar } from "./top-bar";
import { Sidebar } from "./sidebar";

/**
 * Standard authenticated-page layout: fixed top bar, left sidebar, main pane.
 * The login page and other pre-auth surfaces render without Shell.
 */
export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <TopBar />
      <div className="flex flex-1">
        <Sidebar />
        <main className="flex-1 bg-neutral-50">{children}</main>
      </div>
    </div>
  );
}
