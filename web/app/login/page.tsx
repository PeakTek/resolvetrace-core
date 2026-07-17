"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type Mode = "loading" | "password" | "redirect";

function errorMessage(code: string | null): string | null {
  if (!code) return null;
  switch (code) {
    case "unauthorized":
      return "Invalid username or password.";
    case "no_tenants":
      return "This account does not have access to any workspace.";
    case "sso":
      return "SSO sign-in failed. Please try again.";
    default:
      return "Sign-in failed. Please try again.";
  }
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/sessions";

  const [mode, setMode] = useState<Mode>("loading");
  const [providerLabel, setProviderLabel] = useState("Sign in");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(errorMessage(params.get("error")));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/config")
      .then((r) => r.json())
      .then((c: { mode?: string; providerLabel?: string }) => {
        if (!active) return;
        setMode(c.mode === "redirect" ? "redirect" : "password");
        if (c.providerLabel) setProviderLabel(c.providerLabel);
      })
      .catch(() => {
        if (active) setMode("password");
      });
    return () => {
      active = false;
    };
  }, []);

  async function handlePasswordSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (username.trim().length === 0 || password.length === 0) return;
    setError(null);
    setBusy(true);
    let res: Response;
    try {
      res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
    } catch {
      setError("Could not reach the server. Please try again.");
      setBusy(false);
      return;
    }
    if (res.ok) {
      router.replace(next);
      router.refresh();
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setError(errorMessage(body.error ?? null) ?? "Sign-in failed. Please try again.");
    setBusy(false);
  }

  async function startSso() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/auth/authorize");
      if (res.ok) {
        const { redirectUrl } = (await res.json()) as { redirectUrl?: string };
        if (redirectUrl) {
          window.location.href = redirectUrl;
          return;
        }
      }
      setError("SSO is not available right now.");
    } catch {
      setError("Could not start SSO. Please try again.");
    }
    setBusy(false);
  }

  return (
    <Card className="w-full max-w-sm p-6">
      <h1 className="mb-1 text-xl font-semibold">Sign in to ResolveTrace</h1>

      {mode === "redirect" ? (
        <>
          <p className="mb-6 text-sm text-neutral-600">
            Sign in with your organization account.
          </p>
          {error ? (
            <p role="alert" className="mb-4 text-sm text-red-600">
              {error}
            </p>
          ) : null}
          <Button type="button" className="w-full" onClick={startSso} disabled={busy}>
            {busy ? "Redirecting…" : providerLabel}
          </Button>
        </>
      ) : mode === "password" ? (
        <>
          <p className="mb-6 text-sm text-neutral-600">
            Enter your credentials to access the portal.
          </p>
          <form className="space-y-4" onSubmit={handlePasswordSubmit}>
            <div className="space-y-1">
              <label htmlFor="username" className="text-sm font-medium">
                Username
              </label>
              <Input
                id="username"
                name="username"
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                disabled={busy}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="password" className="text-sm font-medium">
                Password
              </label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={busy}
              />
            </div>
            {error ? (
              <p role="alert" className="text-sm text-red-600">
                {error}
              </p>
            ) : null}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </>
      ) : (
        <p className="mt-6 text-sm text-neutral-500">Loading…</p>
      )}
    </Card>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 p-6">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
