import type { NextConfig } from "next";

const nextConfig = {
  // No `output: "export"` — serving model (static vs standalone) is a
  // later-wave decision. Keep defaults so the shell builds cleanly under
  // both the dev server (`next dev`) and a standard Node runtime
  // (`next start` / `next build`).
} satisfies NextConfig;

export default nextConfig;
