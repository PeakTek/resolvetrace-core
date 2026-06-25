"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type LookupState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "invalid" }
  | { status: "notFound" }
  | { status: "error" };

/**
 * Support-code search box for the sessions list. Operators paste a code a user
 * read to them (lenient input: lowercase, spaces, and dashes are fine — the
 * server normalizes). On a hit we route to the session-detail page.
 */
export function SupportCodeLookup() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [state, setState] = useState<LookupState>({ status: "idle" });

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = code.trim();
    if (trimmed.length === 0) return;

    setState({ status: "loading" });
    let response: Response;
    try {
      response = await fetch("/api/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: trimmed }),
      });
    } catch {
      setState({ status: "error" });
      return;
    }

    if (response.ok) {
      const body = (await response.json()) as { sessionId: string };
      router.push(`/sessions/${encodeURIComponent(body.sessionId)}`);
      return;
    }
    if (response.status === 400) {
      setState({ status: "invalid" });
      return;
    }
    if (response.status === 404) {
      setState({ status: "notFound" });
      return;
    }
    setState({ status: "error" });
  }

  const message =
    state.status === "invalid"
      ? "That doesn't look like a valid support code."
      : state.status === "notFound"
        ? "No session found for that code."
        : state.status === "error"
          ? "Could not look that up. Try again."
          : null;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2 sm:flex-row">
      <div className="flex-1">
        <label htmlFor="support-code" className="sr-only">
          Support code
        </label>
        <Input
          id="support-code"
          name="support-code"
          value={code}
          autoComplete="off"
          spellCheck={false}
          placeholder="Support code (e.g. ABCD-1234)"
          className="font-mono uppercase placeholder:font-sans placeholder:normal-case"
          onChange={(event) => {
            setCode(event.target.value);
            if (state.status !== "idle") setState({ status: "idle" });
          }}
        />
        {message ? (
          <p className="mt-1 text-xs text-red-600">{message}</p>
        ) : null}
      </div>
      <Button type="submit" disabled={state.status === "loading"}>
        {state.status === "loading" ? "Looking up…" : "Look up"}
      </Button>
    </form>
  );
}
