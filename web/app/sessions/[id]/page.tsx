import { Shell } from "@/components/layout/shell";
import { Card } from "@/components/ui/card";

export default async function SessionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
    <Shell>
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">Session</h1>
          <p className="font-mono text-sm text-neutral-600">{id}</p>
        </header>
        <Card className="p-10 text-center">
          <p className="text-sm text-neutral-600">
            Session timeline, events, and replay viewer will appear here once
            the Portal API is wired.
          </p>
        </Card>
      </div>
    </Shell>
  );
}
