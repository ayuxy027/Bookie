import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  // node:sqlite is a Node builtin the bundler does not know yet; load it at runtime
  webpack: (config, { isServer }) => {
    if (isServer) config.externals.push({ "node:sqlite": "commonjs node:sqlite" });
    return config;
  },
};

export default nextConfig;
