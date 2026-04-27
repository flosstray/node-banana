import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: {
      bodySizeLimit: "100mb", // Increased for large media files
    },
  },
  // Note: For route handlers (.../route.ts files), body size is controlled by
  // the underlying server. For large payloads, consider using streaming or
  // increase Node.js max HTTP header size if needed.
  //
  // Turbopack (Next 16's new bundler) is intentionally disabled — it currently
  // panics with "range end index 65535 out of range" when compiling our route
  // handlers under dev. Falling back to webpack until that bug is fixed
  // upstream (see https://github.com/vercel/next.js/discussions/category/turbopack-error-report).
  // To re-enable later: restore `turbopack: { root: __dirname }`.
};

export default nextConfig;
