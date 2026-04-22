"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Development stub: accept any non-empty credentials, write a placeholder
    // cookie, and redirect. Real authentication wires in a later wave once
    // the Portal API is scaffolded.
    if (username.trim().length === 0 || password.trim().length === 0) {
      return;
    }
    document.cookie = `rt_session=stub; path=/; SameSite=Lax`;
    router.push("/sessions");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 p-6">
      <Card className="w-full max-w-sm p-6">
        <h1 className="mb-1 text-xl font-semibold">Sign in to ResolveTrace</h1>
        <p className="mb-6 text-sm text-neutral-600">
          Development stub: any non-empty username and password will sign you
          in. Real authentication is a later wave.
        </p>
        <form className="space-y-4" onSubmit={handleSubmit}>
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
            />
          </div>
          <Button type="submit" className="w-full">
            Sign in
          </Button>
        </form>
      </Card>
    </div>
  );
}
