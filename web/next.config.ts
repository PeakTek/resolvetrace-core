import type { NextConfig } from "next";

const nextConfig = {
  // Vercel's self-hosting recommendation: `standalone` emits a minimal
  // Node.js server bundle under `.next/standalone/` that runs independently
  // of the project's node_modules/. The Dockerfile copies that bundle plus
  // `.next/static` + `public/` into the runtime image. Keeps portal + ingest
  // in a single published image with lean layers.
  output: "standalone",
} satisfies NextConfig;

export default nextConfig;
