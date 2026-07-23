import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // output: 'export', // Removed to enable API Routes for OpenClaw proxy
  serverExternalPackages: ['ws'],
};

export default nextConfig;
