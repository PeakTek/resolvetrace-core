import { Shell } from "@/components/layout/shell";
import { Card } from "@/components/ui/card";

export default function AuditPage() {
  return (
    <Shell>
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">Audit log</h1>
          <p className="text-sm text-neutral-600">
            Administrative and access events recorded by this deployment.
          </p>
        </header>
        <Card className="p-10 text-center">
          <p className="text-sm text-neutral-600">
            No audit entries yet. Events will appear here as users sign in,
            view sessions, and change settings.
          </p>
        </Card>
      </div>
    </Shell>
  );
}
