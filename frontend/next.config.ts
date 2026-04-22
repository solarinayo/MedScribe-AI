import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  images: {
    unoptimized: true,
  },
  // Prefer this package's lockfile when other lockfiles exist higher in the tree.
  outputFileTracingRoot: path.join(__dirname),
  // During `next dev` only, forward /api to FastAPI so the browser stays same-origin
  // (avoids "Failed to fetch" from cross-origin + loopback). Ignored for static export.
  async rewrites() {
    const target = (
      process.env.NEXT_DEV_API_PROXY ?? "http://127.0.0.1:8000"
    ).replace(/\/$/, "");
    if (target === "false" || !target) {
      return [];
    }
    return [
      {
        source: "/api/:path*",
        destination: `${target}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
