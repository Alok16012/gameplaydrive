import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lets the dev server be opened as 127.0.0.1 as well as localhost (e.g. two players in two browser tabs).
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
