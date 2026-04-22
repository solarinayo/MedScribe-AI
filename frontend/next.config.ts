import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  images: {
    unoptimized: true,
  },
  // Prefer this package's lockfile when other lockfiles exist higher in the tree.
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
