import type { NextConfig } from "next";
import { buildSecurityHeaders } from "./src/lib/securityHeaders";

/**
 * Next.js configuration for the Vexlyx dashboard.
 * Transpiles the shared workspace package for monorepo compatibility.
 */
const nextConfig: NextConfig = {
  transpilePackages: ["@vexlyx/shared"],
  async headers() {
    // NEXT_PUBLIC_API_URL is a build-time value (see the Dockerfile ARG), so the
    // CSP connect-src below is fixed per build, matching what the client bundle uses.
    const headers = buildSecurityHeaders({
      apiUrl: process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000",
      isProduction: process.env.NODE_ENV === "production",
    });
    return [{ source: "/:path*", headers }];
  },
  // Produces .next/standalone — a minimal, self-contained server bundle used
  // by the production Docker image (F5.1) so the runtime image doesn't need
  // the full node_modules tree. Disabled on Windows to prevent symlink EPERM failures.
  output: process.env.BUILD_STANDALONE === "true" || process.platform !== "win32" ? "standalone" : undefined,
};

export default nextConfig;
