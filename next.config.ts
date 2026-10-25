import type { NextConfig } from "next";

// Build id baked into every bundle, so phones can tell when a newer deploy is live (app/lib/autoUpdate.ts).
// Netlify sets COMMIT_REF and Vercel VERCEL_GIT_COMMIT_SHA at build time; anywhere else the build time itself will
// do. `next dev` stays "dev".
const buildId = process.env.NODE_ENV === "development" ? "dev" : (process.env.COMMIT_REF ?? process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.BUILD_ID ?? String(Date.now())).slice(0, 12);

const nextConfig: NextConfig = {
  // Lets the dev server be opened as 127.0.0.1 as well as localhost (e.g. two players in two browser tabs).
  allowedDevOrigins: ["127.0.0.1"],
  env: { NEXT_PUBLIC_BUILD_ID: buildId },
};

export default nextConfig;
