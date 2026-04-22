import { Shell } from "@/components/layout/shell";
import { Card } from "@/components/ui/card";

export default function SessionsPage() {
  return (
    <Shell>
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">Sessions</h1>
          <p className="text-sm text-neutral-600">
            Recorded browser sessions captured by the ResolveTrace SDK.
          </p>
        </header>
        <Card className="p-10 text-center">
          <p className="text-sm text-neutral-600">
            No sessions captured yet. Install the SDK in your app and send some
            traffic to see recordings here.
          </p>
        </Card>
      </div>
    </Shell>
  );
}
